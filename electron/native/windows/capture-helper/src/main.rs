use std::io::BufRead;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Deserialize;
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::encoder::{
    AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
    VideoSettingsSubType,
};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

// Windows native capture helper for Quick Recording — see electron/main/native/screenCapture.ts
// for why this exists instead of ffmpeg's `-f gdigrab -draw_mouse`: gdigrab's cursor draw
// polls GetCursorInfo/GDI independently of the frame capture, racing DWM's hardware cursor
// compositor (confirmed: visible flicker, both live on-screen and in the recording).
// Windows.Graphics.Capture composites the cursor as part of the same frame the compositor
// already produces — no separate poll, no race, no flicker. Mirrors the protocol of the
// macOS ScreenCaptureKit helper (electron/native/mac/ScreenCaptureKitRecorder.swift): a
// JSON config via argv[1], a "Recording started" stdout handshake once capture begins, and
// a line-based stdin command ("stop") to end the session. Unlike the Mac helper, pause/
// resume are NOT handled in-process here — the Node side stops this process and starts a
// fresh one per segment (mirroring gdigrab's existing segment+concat pause/resume model in
// screenCapture.ts), so this binary only ever runs one uninterrupted recording per launch.
#[derive(Deserialize)]
struct CaptureConfig {
    #[serde(rename = "monitorIndex")]
    monitor_index: usize,
    #[serde(rename = "outputPath")]
    output_path: String,
    fps: u32,
    #[serde(rename = "showCursor")]
    show_cursor: bool,
    #[serde(rename = "areaX")]
    area_x: Option<f64>,
    #[serde(rename = "areaY")]
    area_y: Option<f64>,
    #[serde(rename = "areaWidth")]
    area_width: Option<f64>,
    #[serde(rename = "areaHeight")]
    area_height: Option<f64>,
}

/// Pixel crop box, precomputed once from the monitor's real size and the fractional
/// (0..1) AreaRect — same shape as the fractional-area convention used elsewhere in the
/// app (see ScreenCaptureKitRecorder.swift's CaptureConfig comment).
struct CropBox {
    start_w: u32,
    start_h: u32,
    end_w: u32,
    end_h: u32,
}

struct HandlerFlags {
    output_path: String,
    out_width: u32,
    out_height: u32,
    fps: u32,
    crop: Option<CropBox>,
    stop_flag: Arc<AtomicBool>,
}

struct Recorder {
    encoder: Option<VideoEncoder>,
    stop_flag: Arc<AtomicBool>,
    output_path: String,
    crop: Option<CropBox>,
}

impl GraphicsCaptureApiHandler for Recorder {
    type Flags = HandlerFlags;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let flags = ctx.flags;

        let video_settings = VideoSettingsBuilder::new(flags.out_width, flags.out_height)
            .sub_type(VideoSettingsSubType::H264)
            .frame_rate(flags.fps)
            .bitrate(12_000_000);

        let encoder = VideoEncoder::new(
            video_settings,
            // Mic/system audio and the camera bubble already ride their own separate
            // pipelines (see RecordingService.ts) — this helper is video-only, same as the
            // macOS SCK helper.
            AudioSettingsBuilder::default().disabled(true),
            ContainerSettingsBuilder::default(),
            &flags.output_path,
        )?;

        println!("Recording started");
        use std::io::Write;
        std::io::stdout().flush()?;

        Ok(Self {
            encoder: Some(encoder),
            stop_flag: flags.stop_flag,
            output_path: flags.output_path,
            crop: flags.crop,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        // Must be captured before any crop/buffer borrow below — Frame::timestamp() takes
        // &self, but buffer_crop() takes &mut self and the returned FrameBuffer keeps that
        // borrow alive, so frame can't be touched again until it's dropped.
        let timestamp_100ns = frame.timestamp().Duration;

        if let Some(crop) = &self.crop {
            let mut buffer = frame.buffer_crop(crop.start_w, crop.start_h, crop.end_w, crop.end_h)?;
            let bytes = buffer.as_nopadding_buffer()?;
            self.encoder.as_mut().unwrap().send_frame_buffer(bytes, timestamp_100ns)?;
        } else {
            self.encoder.as_mut().unwrap().send_frame(frame)?;
        }

        if self.stop_flag.load(Ordering::SeqCst) {
            self.encoder.take().unwrap().finish()?;
            capture_control.stop();
            println!("Recording stopped. Output path: {}", self.output_path);
            use std::io::Write;
            std::io::stdout().flush()?;
        }

        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        // The capture item (a monitor) closing on its own isn't expected in normal
        // operation, but if it ever happens, finish out the file instead of leaving it
        // unfinalized.
        self.stop_flag.store(true, Ordering::SeqCst);
        Ok(())
    }
}

fn compute_crop(config: &CaptureConfig, width: u32, height: u32) -> Option<CropBox> {
    let (ax, ay, aw, ah) = (config.area_x?, config.area_y?, config.area_width?, config.area_height?);
    let start_w = ((ax * width as f64).round() as i64).clamp(0, width as i64 - 2) as u32;
    let start_h = ((ay * height as f64).round() as i64).clamp(0, height as i64 - 2) as u32;
    let crop_w = ((aw * width as f64).round() as i64).clamp(2, width as i64 - start_w as i64) as u32;
    let crop_h = ((ah * height as f64).round() as i64).clamp(2, height as i64 - start_h as i64) as u32;
    Some(CropBox { start_w, start_h, end_w: start_w + crop_w, end_h: start_h + crop_h })
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

    let monitor = match Monitor::from_index(config.monitor_index) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("Monitor not found (index {}): {e}", config.monitor_index);
            std::process::exit(1);
        }
    };
    let (monitor_width, monitor_height) = match (monitor.width(), monitor.height()) {
        (Ok(w), Ok(h)) => (w, h),
        _ => {
            eprintln!("Failed to read monitor dimensions");
            std::process::exit(1);
        }
    };

    let crop = compute_crop(&config, monitor_width, monitor_height);
    let (out_width, out_height) = match &crop {
        Some(c) => (c.end_w - c.start_w, c.end_h - c.start_h),
        None => (monitor_width, monitor_height),
    };

    let stop_flag = Arc::new(AtomicBool::new(false));
    {
        let stop_flag = stop_flag.clone();
        std::thread::spawn(move || {
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                let Ok(line) = line else { break };
                if line.trim().eq_ignore_ascii_case("stop") {
                    stop_flag.store(true, Ordering::SeqCst);
                    break;
                }
            }
        });
    }

    let cursor_capture =
        if config.show_cursor { CursorCaptureSettings::WithCursor } else { CursorCaptureSettings::WithoutCursor };

    let flags = HandlerFlags {
        output_path: config.output_path.clone(),
        out_width,
        out_height,
        fps: config.fps.max(1),
        crop,
        stop_flag,
    };

    let interval = std::time::Duration::from_millis(1000 / u64::from(config.fps.max(1)));
    let settings = Settings::new(
        monitor,
        cursor_capture,
        DrawBorderSettings::WithoutBorder,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Custom(interval),
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        flags,
    );

    if let Err(e) = Recorder::start(settings) {
        eprintln!("Capture failed: {e}");
        std::process::exit(1);
    }
}
