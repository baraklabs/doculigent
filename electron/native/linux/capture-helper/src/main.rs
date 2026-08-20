// ============================================================================================
// UNVERIFIED — written without any Linux environment available to build, type-check, or run
// this against (see the plan doc: no `cargo check` possible here — no Linux target, no
// libpipewire headers for pipewire-sys's pkg-config/bindgen step). The overall shape (xdg-
// desktop-portal ScreenCast handshake -> connect to the returned PipeWire remote -> negotiate
// a raw video format -> pipe frames to ffmpeg for encoding) is right, and the ashpd 0.13 API
// calls below were checked against ashpd's real docs.rs pages at write time. The pipewire-rs
// (0.10.x) calls are grounded in a real example (its examples/streams.rs) but are the part
// most likely to need fixing — in particular, connecting to a *specific* fd handed over by
// the portal (rather than the default system PipeWire socket) needs pipewire-rs's fd-connect
// entry point, whose exact name/signature wasn't confirmed from here. Treat this file as a
// draft for a Linux machine to compile and correct, not working code.
// ============================================================================================
//
// Linux native capture helper for Quick Recording — see electron/main/native/screenCapture.ts
// for why this exists instead of the getDisplayMedia/Chromium fallback Linux uses today
// (Linux has no native capture path at all currently — canCaptureTarget() hardcodes
// win32/darwin only). PipeWire via the xdg-desktop-portal ScreenCast interface is the modern,
// compositor-agnostic capture mechanism (works under both X11 and Wayland compositors that
// implement the portal) and — same rationale as Windows.Graphics.Capture and ScreenCaptureKit
// — composites the cursor as part of the same pipeline that draws it on screen
// (CursorMode::Embedded) instead of a separate poll that can race the compositor and flicker.
//
// Real, known gap this does NOT solve (see the plan doc's "Part G" for the full explanation):
// Electron's setContentProtection is a no-op on Linux, so there is no reliable way to exclude
// the camera-bubble window from a PipeWire capture the way WDA_EXCLUDEFROMCAPTURE (Windows)
// or sharingType=.none (macOS) do. That's a pre-existing platform limitation independent of
// this helper — this file only addresses the cursor-flicker problem, not bubble exclusion.
//
// Protocol mirrors the Windows/Mac helpers: JSON config via argv[1], a "Recording started"
// stdout line once capture begins, and line-based commands via stdin ("pause"/"resume"/
// "stop"). Unlike the other two, there's no built-in encoder available (no Media Foundation/
// AVAssetWriter equivalent) — raw BGRx frames are piped to the app's own bundled ffmpeg
// binary (path passed in the config) for H.264/MP4 encoding, the same raw-frame-over-stdin
// technique the app already used in the now-removed electron/main/native/cursorOverlay.ts.
//
// Pause/resume are handled in-process (dropping frames while paused, matching this file's
// single long-lived-process design) rather than the Windows helper's kill-and-respawn-per-
// segment model — re-running the portal handshake on every resume would re-show the
// permission picker dialog each time, a real UX regression the in-process approach avoids.
// This does mean a pause/resume cycle isn't currently retimed against the separately-synced
// audio side clip the app records (see RecordingService.ts) — flagged here as another
// unverified correctness gap alongside the ones called out further down, not solved in
// this pass.
//
// Also unlike Windows/Mac: the portal's ScreenCast picker is a system dialog the *user*
// interacts with to choose which monitor/window to share — this helper cannot silently pick
// a specific monitor by index the way Monitor::from_index (WGC) or a CGDirectDisplayID (SCK)
// can. `monitorIndex`/area-select from the app's own target-picker UI are therefore not
// wired through here; v1 always requests SourceType::Monitor and lets the portal dialog
// decide. A `restore_token` (PersistMode::ExplicitlyRevoked or Persistent) could skip the
// dialog on repeat recordings, deliberately left out here as an additional untested surface.

use std::io::{BufRead, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use ashpd::desktop::screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType};
use ashpd::desktop::{PersistMode, ResponseError};
use serde::Deserialize;

#[derive(Deserialize)]
struct CaptureConfig {
    #[serde(rename = "outputPath")]
    output_path: String,
    fps: u32,
    #[serde(rename = "ffmpegPath")]
    ffmpeg_path: String,
}

fn main() {
    let raw_config = match std::env::args().nth(1) {
        Some(arg) => arg,
        None => {
            eprintln!("Missing config JSON");
            std::process::exit(1);
        }
    };
    let config: CaptureConfig = match serde_json::from_str(&raw_config) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Invalid config JSON: {e}");
            std::process::exit(1);
        }
    };

    let stop_flag = Arc::new(AtomicBool::new(false));
    let paused_flag = Arc::new(AtomicBool::new(false));
    {
        let stop_flag = stop_flag.clone();
        let paused_flag = paused_flag.clone();
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                let Ok(line) = line else { break };
                match line.trim().to_lowercase().as_str() {
                    "stop" => {
                        stop_flag.store(true, Ordering::SeqCst);
                        break;
                    }
                    "pause" => paused_flag.store(true, Ordering::SeqCst),
                    "resume" => paused_flag.store(false, Ordering::SeqCst),
                    _ => {}
                }
            }
        });
    }

    if let Err(e) = async_std::task::block_on(run(config, stop_flag, paused_flag)) {
        eprintln!("Capture failed: {e}");
        std::process::exit(1);
    }
}

async fn run(
    config: CaptureConfig,
    stop_flag: Arc<AtomicBool>,
    paused_flag: Arc<AtomicBool>,
) -> Result<(), Box<dyn std::error::Error>> {
    // --- Portal handshake (ashpd 0.13 API, checked against real docs at write time) ---
    let proxy = Screencast::new().await?;
    let session = proxy.create_session(Default::default()).await?;
    proxy
        .select_sources(
            &session,
            SelectSourcesOptions::default()
                .set_cursor_mode(CursorMode::Embedded)
                .set_sources(SourceType::Monitor)
                .set_multiple(false)
                .set_persist_mode(PersistMode::DoNot),
        )
        .await?;

    let response = proxy.start(&session, None, Default::default()).await?.response()?;
    let stream_info = response
        .streams()
        .first()
        .ok_or(ResponseError::Cancelled)?
        .clone();
    let node_id = stream_info.pipe_wire_node_id();

    let pw_fd = proxy.open_pipe_wire_remote(&session, Default::default()).await?;

    // --- PipeWire stream (pipewire-rs 0.10.x shape, per its examples/streams.rs — the
    // fd-connect call below is the single least-verified line in this file: pipewire-rs
    // needs to connect to the *portal-provided* remote (pw_fd), not the default system
    // socket a plain `context.connect_rc(None)` would use. Whatever the real 0.10.x entry
    // point for that turns out to be (a Context method taking a RawFd, most likely), swap
    // it in here. ---
    pipewire::init();
    let mainloop = pipewire::main_loop::MainLoopRc::new(None)?;
    let context = pipewire::context::ContextRc::new(&mainloop, None)?;
    let core = context.connect_fd(pw_fd, None)?; // <-- verify against the pinned pipewire-rs version

    let (frame_tx, frame_rx) = sync_channel::<(u32, u32, Vec<u8>)>(4);
    let encoder = std::thread::spawn({
        let output_path = config.output_path.clone();
        let ffmpeg_path = config.ffmpeg_path.clone();
        let fps = config.fps.max(1);
        move || run_encoder(ffmpeg_path, output_path, fps, frame_rx)
    });

    let started = Arc::new(AtomicBool::new(false));
    let stream = pipewire::stream::StreamBox::new(
        &core,
        "doculigent-screen-capture",
        pipewire::properties::properties! {
            *pipewire::keys::MEDIA_TYPE => "Video",
            *pipewire::keys::MEDIA_CATEGORY => "Capture",
            *pipewire::keys::MEDIA_ROLE => "Screen",
        },
    )?;

    let frame_tx_for_process = frame_tx.clone();
    let started_for_process = started.clone();
    let paused_for_process = paused_flag.clone();
    let _listener = stream
        .add_local_listener()
        .state_changed(|_, _, old, new| {
            eprintln!("[doculigent-pipewire-helper] stream state: {old:?} -> {new:?}");
        })
        .param_changed(move |_stream, _user_data, id, _param| {
            // TODO(unverified): parse the SPA_PARAM_Format pod here to pull out negotiated
            // width/height (spa::param::video::VideoInfoRaw::parse, per pipewire-rs's own
            // video-format examples) and stash them somewhere run_encoder's first frame can
            // read, since send_frame_buffer-equivalent needs real dimensions before writing
            // any bytes to ffmpeg's stdin.
            let _ = id;
        })
        .process(move |stream, _user_data| {
            if !started_for_process.swap(true, Ordering::SeqCst) {
                println!("Recording started");
                let _ = std::io::stdout().flush();
            }
            // Still dequeue while paused (must, to keep returning buffers to PipeWire), just
            // don't forward the bytes on to the encoder.
            let paused = paused_for_process.load(Ordering::SeqCst);
            match stream.dequeue_buffer() {
                None => {}
                Some(mut buffer) => {
                    if paused {
                        return;
                    }
                    let datas = buffer.datas_mut();
                    if let Some(data) = datas.first_mut() {
                        let chunk_size = data.chunk().size() as usize;
                        if let Some(slice) = data.data() {
                            let bytes = slice[..chunk_size.min(slice.len())].to_vec();
                            // TODO(unverified): real width/height from param_changed above,
                            // not hardcoded — placeholder 0,0 until that's wired up.
                            let _ = frame_tx_for_process.try_send((0, 0, bytes));
                        }
                    }
                }
            }
        })
        .register()?;

    let mut params = Vec::new(); // TODO(unverified): build a SPA_FORMAT_VIDEO_raw pod list
                                  // requesting BGRx/RGBx, matching pipewire-rs's video
                                  // examples' param-building pattern, before connecting.
    stream.connect(
        pipewire::spa::utils::Direction::Input,
        Some(node_id),
        pipewire::stream::StreamFlags::AUTOCONNECT | pipewire::stream::StreamFlags::MAP_BUFFERS,
        &mut params,
    )?;

    // Drive the mainloop until told to stop.
    loop {
        mainloop.loop_().iterate(std::time::Duration::from_millis(100));
        if stop_flag.load(Ordering::SeqCst) {
            break;
        }
    }

    drop(frame_tx);
    let _ = encoder.join();

    println!("Recording stopped. Output path: {}", config.output_path);
    let _ = std::io::stdout().flush();
    Ok(())
}

/// Owns the ffmpeg child process's stdin on a dedicated thread so writing raw frames never
/// blocks PipeWire's mainloop — same rationale as the raw-frame-over-stdin technique the
/// app used in the now-removed cursorOverlay.ts. Spawns ffmpeg lazily on the first frame,
/// once real width/height are known (see the param_changed TODO above — this won't produce
/// a valid file until that's wired up to pass real dimensions instead of 0,0).
fn run_encoder(
    ffmpeg_path: String,
    output_path: String,
    fps: u32,
    frame_rx: std::sync::mpsc::Receiver<(u32, u32, Vec<u8>)>,
) {
    let mut child: Option<std::process::Child> = None;
    let mut stdin: Option<std::process::ChildStdin> = None;

    for (width, height, bytes) in frame_rx {
        if child.is_none() {
            if width == 0 || height == 0 {
                continue; // not yet negotiated — see param_changed TODO
            }
            let mut spawned = match Command::new(&ffmpeg_path)
                .args([
                    "-y",
                    "-f",
                    "rawvideo",
                    "-pixel_format",
                    "bgra",
                    "-video_size",
                    &format!("{width}x{height}"),
                    "-framerate",
                    &fps.to_string(),
                    "-i",
                    "pipe:0",
                    "-c:v",
                    "libx264",
                    "-preset",
                    "ultrafast",
                    &output_path,
                ])
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .spawn()
            {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("Failed to spawn ffmpeg encoder: {e}");
                    return;
                }
            };
            stdin = spawned.stdin.take();
            child = Some(spawned);
        }
        if let Some(s) = stdin.as_mut() {
            let _ = s.write_all(&bytes);
        }
    }

    drop(stdin);
    if let Some(mut c) = child {
        let _ = c.wait();
    }
}

// Unused placeholder kept only so the `SyncSender` clone above type-checks against the
// signature; remove once param_changed's real dimension plumbing replaces the TODOs.
#[allow(dead_code)]
fn _silence_unused(_tx: SyncSender<(u32, u32, Vec<u8>)>) {}
