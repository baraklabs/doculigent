import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CaptureTarget, MicConfig, OverlayConfig } from "@shared/types/models";
import { useRecordingStore } from "../store/recordingStore";
import { desktopConstraints } from "../services/recording/constraints";
import { recordingService } from "../services/recording/RecordingService";
import { SettingsService } from "../services/settings/SettingsService";
import { AnnotationToolbar } from "../components/AnnotationToolbar";

const DEFAULT_OVERLAY: OverlayConfig = {
  corner: "bottom-right",
  sizePct: 18,
  circular: true,
  showCamera: false,
  cameraDeviceId: null,
  cursorHighlight: "default",
};

// Emoji-as-icon, matching the "⚙ Settings" tab convention elsewhere in this app — these
// swap the real OS cursor (see electron/main/native/systemCursor.ts), Windows-only.
// Labels show as a hover tooltip (native `title`) rather than always-visible captions.
const CURSOR_STYLES: {
  value: OverlayConfig["cursorHighlight"];
  label: string;
  icon: string;
  big?: boolean;
  color?: string;
}[] = [
  { value: "default", label: "Default", icon: "🚫" },
  { value: "hand", label: "Hand", icon: "👆" },
  { value: "crosshair", label: "Crosshair", icon: "✛" },
  { value: "bigger", label: "Big pointer", icon: "3X", big: true },
  { value: "huge", label: "Huge pointer", icon: "5X", big: true },
  { value: "colorArrow", label: "Orange arrow", icon: "↖", color: "#ff7a00" },
  { value: "colorHand", label: "Purple dot", icon: "●", color: "#5b4bf5" },
];

export function RecordPage() {
  const navigate = useNavigate();
  const { recording, busy, error, start, stop } = useRecordingStore();

  const { data: targets = [] } = useQuery<CaptureTarget[]>({
    queryKey: ["captureTargets"],
    queryFn: () => window.api.capture.listTargets(),
  });
  const [targetId, setTargetId] = useState("");

  const [overlay, setOverlay] = useState<OverlayConfig>(DEFAULT_OVERLAY);
  const [title, setTitle] = useState("Untitled recording");

  // Restore the last-used capture source + camera overlay so returning to Record doesn't
  // reset them to defaults every time. `settingsLoaded` gates the persist effect below so
  // it can't fire (and clobber the saved settings with defaults) before this resolves.
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [preferredTargetId, setPreferredTargetId] = useState<string | null>(null);
  const [mic, setMic] = useState<MicConfig>({ deviceId: null, muted: false });
  useEffect(() => {
    SettingsService.getRecordSettings()
      .then(({ overlay: savedOverlay, targetId: savedTargetId, mic: savedMic }) => {
        if (savedOverlay) setOverlay(savedOverlay);
        setPreferredTargetId(savedTargetId);
        if (savedMic) setMic(savedMic);
      })
      .finally(() => setSettingsLoaded(true));
  }, []);

  useEffect(() => {
    if (targetId || targets.length === 0) return;
    const preferred = preferredTargetId && targets.some((t) => t.id === preferredTargetId) ? preferredTargetId : targets[0].id;
    setTargetId(preferred);
  }, [targets, targetId, preferredTargetId]);

  useEffect(() => {
    if (!settingsLoaded || !targetId) return;
    SettingsService.setRecordSettings(overlay, targetId, mic).catch(() => {});
  }, [overlay, targetId, mic, settingsLoaded]);

  // Cursor highlight swaps the real OS cursor live, as soon as it's picked — not just
  // while actually recording — so this reacts to every change in overlay.cursorHighlight
  // (a button click, or the saved value loading in above) rather than being tied to
  // RecordingService's start/stop. "default" restores; anything else applies. Also used
  // directly by the icon row's hover preview below, to put the *actual* selection back
  // (not just "default") once the mouse leaves a previewed icon.
  function applyCursorForStyle(style: OverlayConfig["cursorHighlight"]) {
    if (style === "default") window.api.cursor.restore().catch(() => {});
    else window.api.cursor.apply(style).catch(() => {});
  }
  useEffect(() => {
    applyCursorForStyle(overlay.cursorHighlight);
  }, [overlay.cursorHighlight]);

  // Restores the cursor when leaving the Record page (switching tabs) — unless a
  // recording is still in flight, in which case RecordingService/the capture still
  // depends on the cursor staying as-is until the user comes back and turns it off. A
  // ref (rather than a dependency) so this only runs on unmount, reading whatever
  // `recording` was most recently, not whatever it was when the effect was set up.
  const recordingRef = useRef(recording);
  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);
  useEffect(() => {
    return () => {
      if (!recordingRef.current) window.api.cursor.restore().catch(() => {});
    };
  }, []);

  // Camera/mic device lists for the pickers below — labels are only populated once
  // permission has been granted at least once (see the preview effects' `.then()`
  // handlers, which call this again after that happens), so this also re-runs on the
  // browser's 'devicechange' event to pick up devices plugged in mid-session.
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([]);
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([]);
  const refreshDevices = () => {
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        setCameraDevices(devices.filter((d) => d.kind === "videoinput"));
        setMicDevices(devices.filter((d) => d.kind === "audioinput"));
      })
      .catch(() => {});
  };
  useEffect(() => {
    refreshDevices();
    navigator.mediaDevices.addEventListener("devicechange", refreshDevices);
    return () => navigator.mediaDevices.removeEventListener("devicechange", refreshDevices);
  }, []);

  const [saveDir, setSaveDir] = useState("");
  const [pickingDir, setPickingDir] = useState(false);
  useEffect(() => {
    window.api.settings.getSaveDir().then(setSaveDir).catch(() => {});
  }, []);

  const camVideoRef = useRef<HTMLVideoElement>(null);
  const [micLevel, setMicLevel] = useState(0);
  const [camError, setCamError] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);

  // Stop hands off to a background MP4 transcode (see RecordingService.stop()'s doc
  // comment) rather than blocking on it, so the toast has a "processing" state that
  // flips to "ready" once window.api.recording.onSaveCompleted fires for this id.
  const [saveStatus, setSaveStatus] = useState<
    { id: string; status: "processing" | "ready" | "failed"; message?: string } | null
  >(null);
  const queryClient = useQueryClient();
  useEffect(() => {
    const unsubCompleted = window.api.recording.onSaveCompleted((video) => {
      setSaveStatus((prev) => (prev?.id === video.id ? { id: video.id, status: "ready" } : prev));
      queryClient.invalidateQueries({ queryKey: ["videos"] });
    });
    const unsubFailed = window.api.recording.onSaveFailed(({ id, message }) => {
      setSaveStatus((prev) => (prev?.id === id ? { id, status: "failed", message } : prev));
    });
    return () => {
      unsubCompleted();
      unsubFailed();
    };
  }, [queryClient]);

  // Live screen preview before recording starts — the same getUserMedia+desktopCapturer
  // mechanism RecordingService uses for the real capture, just attached to a visible
  // <video> instead of the compositing canvas. (Unlike the old Tauri app, there's no
  // "screenshot without triggering an OS sharing indicator" trick needed/available here:
  // Electron's desktopCapturer doesn't put up any OS-level sharing banner in the first
  // place, so a live stream is the natural choice.)
  const screenVideoRef = useRef<HTMLVideoElement>(null);
  const [screenError, setScreenError] = useState<string | null>(null);
  useEffect(() => {
    if (!targetId || recording) return;
    let stream: MediaStream | null = null;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia(desktopConstraints(targetId))
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        if (screenVideoRef.current) screenVideoRef.current.srcObject = s;
        setScreenError(null);
      })
      .catch((e) => setScreenError(String(e)));
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [targetId, recording]);

  // While recording, show the actual compositing canvas (screen + camera bubble already
  // drawn in) as the live preview instead of the separate pre-recording preview streams
  // above — this is exactly what's being written to the output file, not a second,
  // independent capture of it.
  const recordingPreviewRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!recording) return;
    const canvas = recordingService.getCanvas();
    const container = recordingPreviewRef.current;
    if (!canvas || !container) return;
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    container.appendChild(canvas);
    return () => {
      if (canvas.parentElement === container) container.removeChild(canvas);
    };
  }, [recording]);

  // Live camera preview for the bubble — only shown before recording starts. Once
  // recording begins, RecordingService opens its own getUserMedia camera stream for
  // compositing (see FUNCTIONALITY.md §7.4's note: the old app's camera-exclusivity/
  // mirroring workarounds were specific to a native Windows camera backend split across
  // two processes — there's no such split here, both are the same getUserMedia API in
  // one renderer, so no hand-off dance is needed).
  useEffect(() => {
    if (!overlay.showCamera || recording) {
      setCamError(null);
      return;
    }
    let stream: MediaStream | null = null;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: overlay.cameraDeviceId ? { deviceId: { exact: overlay.cameraDeviceId } } : true })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        if (camVideoRef.current) camVideoRef.current.srcObject = s;
        setCamError(null);
        refreshDevices();
      })
      .catch((e) => setCamError(String(e)));
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [overlay.showCamera, overlay.cameraDeviceId, recording]);

  // Mic level meter — independent of the camera toggle, keeps working even if the
  // camera is off or unavailable.
  useEffect(() => {
    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    let raf = 0;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ audio: mic.deviceId ? { deviceId: { exact: mic.deviceId } } : true })
      .then(async (s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        audioCtx = new AudioContext();
        await audioCtx.resume().catch(() => {});
        const source = audioCtx.createMediaStreamSource(s);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);
        const tick = () => {
          analyser.getByteFrequencyData(data);
          setMicLevel(data.reduce((a, b) => a + b, 0) / data.length);
          raf = requestAnimationFrame(tick);
        };
        tick();
        setMicError(null);
        refreshDevices();
      })
      .catch((e) => setMicError(String(e)));
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      audioCtx?.close();
    };
  }, [mic.deviceId]);

  async function browseSaveDir() {
    // Guards against stacking multiple native picker windows from rapid clicks — the
    // same bug documented (and fixed) in FUNCTIONALITY.md §8.
    if (pickingDir) return;
    setPickingDir(true);
    try {
      const picked = await window.api.settings.pickSaveDir();
      if (picked) {
        setSaveDir(picked);
        await window.api.settings.setSaveDir(picked);
      }
    } finally {
      setPickingDir(false);
    }
  }

  function commitSaveDir() {
    if (saveDir) window.api.settings.setSaveDir(saveDir).catch(() => {});
  }

  async function handleStart() {
    await start(targetId, overlay, mic, title);
  }

  async function handleStop() {
    const result = await stop();
    if (result) setSaveStatus({ id: result.id, status: "processing" });
  }

  const bubbleStyle: CSSProperties = {
    position: "absolute",
    width: `${overlay.sizePct}%`,
    aspectRatio: "1 / 1",
    ...(overlay.corner.startsWith("top") ? { top: 0 } : { bottom: 0 }),
    ...(overlay.corner.endsWith("left") ? { left: 0 } : { right: 0 }),
  };

  return (
    <section className="panel record">
      <h1>Record</h1>

      <div className="record-layout">
        <div className="record-preview-col">
          <div className="stage-preview">
            {recording ? (
              <div ref={recordingPreviewRef} className="recording-canvas-host" />
            ) : screenError ? (
              <div className="stage-empty">Screen preview unavailable: {screenError}</div>
            ) : (
              <video ref={screenVideoRef} autoPlay muted playsInline />
            )}
            {/* Before recording, the bubble is a separate floating preview; once
                recording starts, the compositing canvas above already has it baked in. */}
            {overlay.showCamera && !recording && (
              <div className={`cam-bubble${overlay.circular ? " circular" : ""}`} style={bubbleStyle}>
                <video ref={camVideoRef} autoPlay muted playsInline />
              </div>
            )}
          </div>

          {camError && <p className="error">Camera unavailable: {camError}</p>}
          {micError && <p className="error">Mic unavailable: {micError}</p>}

          <div className="mic-meter">
            <span className="muted">Mic{mic.muted ? " (muted)" : ""}</span>
            <div className="mic-meter-track">
              <div
                className="mic-meter-fill"
                style={{ width: `${mic.muted ? 0 : Math.min(100, (micLevel / 160) * 100)}%` }}
              />
            </div>
          </div>

          <div className="cursor-style-picker">
            <span className="muted">Cursor highlight</span>
            <div className="cursor-style-options">
              {CURSOR_STYLES.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  className={`cursor-style-btn${overlay.cursorHighlight === s.value ? " active" : ""}`}
                  disabled={busy}
                  onClick={() =>
                    setOverlay({
                      ...overlay,
                      cursorHighlight: overlay.cursorHighlight === s.value ? "default" : s.value,
                    })
                  }
                  onMouseEnter={() => applyCursorForStyle(s.value)}
                  onMouseLeave={() => applyCursorForStyle(overlay.cursorHighlight)}
                  title={s.label}
                >
                  <span
                    className={`cursor-style-icon${s.big ? " big" : ""}`}
                    style={s.color ? { color: s.color } : undefined}
                  >
                    {s.icon}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <AnnotationToolbar />
        </div>

        <div className="record-controls-col">
          <label className="field">
            <span>Capture source</span>
            <select value={targetId} onChange={(e) => setTargetId(e.target.value)} disabled={recording || busy}>
              {targets.length === 0 && <option value="">(no sources found)</option>}
              {targets.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.kind}: {t.title}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Title</span>
            <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} disabled={recording || busy} />
          </label>

          <fieldset className="field" disabled={recording || busy}>
            <legend>Camera overlay</legend>
            <div className="overlay-cfg">
              <label className="checkbox">
                Show camera
                <input
                  type="checkbox"
                  checked={overlay.showCamera}
                  onChange={(e) => setOverlay({ ...overlay, showCamera: e.target.checked })}
                />
              </label>
              <label className="checkbox">
                Circular bubble
                <input
                  type="checkbox"
                  checked={overlay.circular}
                  disabled={!overlay.showCamera}
                  onChange={(e) => setOverlay({ ...overlay, circular: e.target.checked })}
                />
              </label>
              <label>
                Camera
                <select
                  value={overlay.cameraDeviceId ?? ""}
                  disabled={!overlay.showCamera}
                  onChange={(e) => setOverlay({ ...overlay, cameraDeviceId: e.target.value || null })}
                >
                  <option value="">Default</option>
                  {cameraDevices.map((d, i) => (
                    <option key={d.deviceId || i} value={d.deviceId}>
                      {d.label || `Camera ${i + 1}`}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Corner
                <select
                  value={overlay.corner}
                  disabled={!overlay.showCamera}
                  onChange={(e) => setOverlay({ ...overlay, corner: e.target.value as OverlayConfig["corner"] })}
                >
                  <option value="top-left">Top left</option>
                  <option value="top-right">Top right</option>
                  <option value="bottom-left">Bottom left</option>
                  <option value="bottom-right">Bottom right</option>
                </select>
              </label>
              <label>
                Size {overlay.sizePct}%
                <input
                  type="range"
                  min={8}
                  max={40}
                  value={overlay.sizePct}
                  disabled={!overlay.showCamera}
                  onChange={(e) => setOverlay({ ...overlay, sizePct: Number(e.target.value) })}
                />
              </label>
            </div>
          </fieldset>

          <fieldset className="field" disabled={recording || busy}>
            <legend>Microphone</legend>
            <div className="overlay-cfg mic-cfg">
              <label>
                Device
                <select
                  value={mic.deviceId ?? ""}
                  disabled={mic.muted}
                  onChange={(e) => setMic({ ...mic, deviceId: e.target.value || null })}
                >
                  <option value="">Default</option>
                  {micDevices.map((d, i) => (
                    <option key={d.deviceId || i} value={d.deviceId}>
                      {d.label || `Microphone ${i + 1}`}
                    </option>
                  ))}
                </select>
              </label>
              <label className="checkbox">
                Mute microphone
                <input
                  type="checkbox"
                  checked={mic.muted}
                  onChange={(e) => setMic({ ...mic, muted: e.target.checked })}
                />
              </label>
            </div>
          </fieldset>

          <label className="field">
            <span>Save to</span>
            <div className="save-location">
              <input
                type="text"
                value={saveDir}
                onChange={(e) => setSaveDir(e.target.value)}
                onBlur={commitSaveDir}
                disabled={recording || busy}
              />
              <button type="button" onClick={browseSaveDir} disabled={recording || busy || pickingDir}>
                {pickingDir ? "Choosing…" : "Browse…"}
              </button>
            </div>
          </label>

          <div className="actions">
            {!recording ? (
              <button className="primary" onClick={handleStart} disabled={!targetId || busy}>
                {busy ? "Starting…" : "● Start recording"}
              </button>
            ) : (
              <button className="danger" onClick={handleStop} disabled={busy}>
                {busy ? "Stopping…" : "■ Stop"}
              </button>
            )}
          </div>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {saveStatus && (
        <div className="toast">
          <button type="button" className="toast-close" onClick={() => setSaveStatus(null)} aria-label="Dismiss">
            ×
          </button>
          {saveStatus.status === "processing" && (
            <>
              <strong>Processing your recording…</strong>
              <p className="muted toast-path">Converting to MP4 — this runs in the background, feel free to keep going.</p>
            </>
          )}
          {saveStatus.status === "ready" && (
            <>
              <strong>Recording saved</strong>
              <p className="muted toast-path">Added to your Library.</p>
              <div className="actions">
                <button className="primary" onClick={() => navigate(`/library/${saveStatus.id}/edit`)}>
                  Edit
                </button>
                <button onClick={() => navigate("/library")}>View library</button>
              </div>
            </>
          )}
          {saveStatus.status === "failed" && (
            <>
              <strong>Couldn't save recording</strong>
              <p className="error toast-path">{saveStatus.message}</p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
