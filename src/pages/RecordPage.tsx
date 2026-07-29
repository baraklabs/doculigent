import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Pencil, Monitor, Video, Mic, MousePointer2, FolderOpen, Info } from "lucide-react";
import type { CaptureTarget, MicConfig, OverlayConfig } from "@shared/types/models";
import { useRecordingStore, useSavingRecording } from "../store/recordingStore";
import { desktopConstraints } from "../services/recording/constraints";
import { recordingService } from "../services/recording/RecordingService";
import { SettingsService } from "../services/settings/SettingsService";
import { AnnotationToolbar } from "../components/AnnotationToolbar";
import "./RecordPage.css";

const DEFAULT_OVERLAY: OverlayConfig = {
  corner: "bottom-right",
  sizePct: 18,
  circular: true,
  showCamera: false,
  cameraDeviceId: null,
  cursorHighlight: "hidden",
};

const ARROW_PATH = "M3 2l0 15 4-4 2.5 5.5 2.5-1.2-2.4-5.3 5.4 0z";

/** The real Windows arrow, so "System cursor" shows what it actually is. */
function ArrowCursorIcon() {
  return (
    <svg viewBox="0 0 22 22" width="16" height="16" aria-hidden="true">
      <path d={ARROW_PATH} fill="#fff" stroke="#1c1e2a" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

/** The same arrow struck through — the usual "off" reading, and it makes clear that what's
 *  hidden is the pointer itself rather than some highlight effect on top of it. */
function NoCursorIcon() {
  return (
    <svg viewBox="0 0 22 22" width="16" height="16" aria-hidden="true">
      <path d={ARROW_PATH} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M2 20L20 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

const CURSOR_STYLES: {
  value: OverlayConfig["cursorHighlight"];
  label: string;
  icon: ReactNode;
  big?: boolean;
  color?: string;
}[] = [
  { value: "default", label: "System cursor", icon: <ArrowCursorIcon /> },
  { value: "hand", label: "Hand", icon: "👆" },
  { value: "crosshair", label: "Crosshair", icon: "✛" },
  { value: "bigger", label: "Big pointer", icon: "3X", big: true },
  { value: "huge", label: "Huge pointer", icon: "5X", big: true },
  { value: "colorArrow", label: "Orange arrow", icon: "↖", color: "#ff7a00" },
  { value: "colorHand", label: "Purple dot", icon: "●", color: "#5b4bf5" },
];

const CURSOR_HINT =
  "";

/** Where the toggle returns to when the cursor is switched back on, if the user never
 *  picked a style themselves. */
const FALLBACK_VISIBLE_STYLE: OverlayConfig["cursorHighlight"] = "default";

/** "Recording 29-07-26 11:23" — the default title, timestamped so a batch of
 *  never-renamed recordings in the Library are still distinguishable from each other
 *  instead of all reading as the same "Untitled recording" (same idea as MeetingPage.tsx's
 *  defaultMeetingTitle). */
function defaultRecordingTitle(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const dd = pad(now.getDate());
  const mm = pad(now.getMonth() + 1);
  const yy = pad(now.getFullYear() % 100);
  const hh = pad(now.getHours());
  const min = pad(now.getMinutes());
  return `Recording ${dd}-${mm}-${yy} ${hh}:${min}`;
}

export function RecordPage() {
  const { recording, busy, error, start, stop } = useRecordingStore();
  const saving = useSavingRecording();

  const { data: targets = [] } = useQuery<CaptureTarget[]>({
    queryKey: ["captureTargets"],
    queryFn: () => window.api.capture.listTargets(),
  });
  const [targetId, setTargetId] = useState("");

  const [overlay, setOverlay] = useState<OverlayConfig>(DEFAULT_OVERLAY);
  const [title, setTitle] = useState(() => defaultRecordingTitle());
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

  const recordingRef = useRef(recording);
  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  // Selecting or hovering a style previews it on the real pointer. "hidden" is the one
  // style with nothing to preview — it's applied by RecordingService once recording
  // starts, so here it just means "leave the pointer alone".
  function applyCursorForStyle(style: OverlayConfig["cursorHighlight"]) {
    if (style === "default" || style === "hidden") window.api.cursor.restore().catch(() => {});
    else window.api.cursor.apply(style).catch(() => {});
  }
  useEffect(() => {
    // Never while recording: whatever the pointer looked like when recording started is
    // already what's being captured (baked in for the swap styles, or excluded entirely
    // for "hidden" via gdigrab's draw_mouse) — touching it mid-take would just desync the
    // picker's preview from the actual capture.
    if (recordingRef.current) return;
    applyCursorForStyle(overlay.cursorHighlight);
  }, [overlay.cursorHighlight]);

  const cursorHidden = overlay.cursorHighlight === "hidden";
  // Toggling the cursor back on should land on the style the user had before hiding it,
  // not reset them to the system arrow every time.
  const [lastVisibleStyle, setLastVisibleStyle] =
    useState<OverlayConfig["cursorHighlight"]>(FALLBACK_VISIBLE_STYLE);
  function toggleCursorHidden() {
    if (cursorHidden) {
      setOverlay({ ...overlay, cursorHighlight: lastVisibleStyle });
    } else {
      setLastVisibleStyle(overlay.cursorHighlight);
      setOverlay({ ...overlay, cursorHighlight: "hidden" });
    }
  }
  useEffect(() => {
    return () => {
      if (!recordingRef.current) window.api.cursor.restore().catch(() => {});
    };
  }, []);

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
  const screenVideoRef = useRef<HTMLVideoElement>(null);
  const [screenError, setScreenError] = useState<string | null>(null);
  useEffect(() => {
    if (!targetId) return;
    // The ordinary pipeline's canvas takes over as the visible preview once recording
    // starts (see the recordingPreviewRef effect below), so this raw stream is torn down —
    // except in native (gdigrab) mode, where there's no compositing canvas and this stream
    // stays the preview for the whole recording. Read fresh rather than from React state:
    // recordingService.start() has already resolved by the time `recording` flips true and
    // this effect re-runs, so the value is correct with no extra render lag.
    if (recording && !recordingService.isNativeCapture()) return;
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

  useEffect(() => {
    if (!overlay.showCamera || (recording && !recordingService.isNativeCapture())) {
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
    await stop();
  }

  const bubbleStyle: CSSProperties = {
    position: "absolute",
    width: `${overlay.sizePct}%`,
    aspectRatio: "1 / 1",
    ...(overlay.corner.startsWith("top") ? { top: 0 } : { bottom: 0 }),
    ...(overlay.corner.endsWith("left") ? { left: 0 } : { right: 0 }),
  };

  return (
    <section className="panel record-page">
         <div className="record-layout">
        <div className="record-preview-col">
          <div className={`stage-preview${recording ? " is-recording" : ""}`}>
            {recording && (
              <span className="record-live-pill">
                <span className="record-live-dot" />
                REC
              </span>
            )}
            {recording && !recordingService.isNativeCapture() ? (
              <div ref={recordingPreviewRef} className="recording-canvas-host" />
            ) : screenError ? (
              <div className="stage-empty">Screen preview unavailable: {screenError}</div>
            ) : (
              <video ref={screenVideoRef} autoPlay muted playsInline />
            )}
            {/* In the ordinary pipeline, the compositing canvas above already has the
                bubble baked in once recording starts, so this floating preview is only
                needed before recording. In native (gdigrab) mode there's no such canvas —
                the screen goes straight to disk — so this stays the camera preview
                throughout, same as before recording. */}
            {overlay.showCamera && (!recording || recordingService.isNativeCapture()) && (
              <div className={`cam-bubble${overlay.circular ? " circular" : ""}`} style={bubbleStyle}>
                <video ref={camVideoRef} autoPlay muted playsInline />
              </div>
            )}
          </div>

          <div className="record-cta">
            {!recording ? (
              <button
                className="record-cta-btn"
                onClick={handleStart}
                disabled={!targetId || busy || saving}
                title={saving ? "Finishing the previous recording…" : undefined}
              >
                <span className="record-cta-dot" />
                {busy ? "Starting…" : "Start recording"}
              </button>
            ) : (
              <button className="record-cta-btn stop" onClick={handleStop} disabled={busy}>
                <span className="record-cta-square" />
                {busy ? "Stopping…" : "Stop recording"}
              </button>
            )}
          </div>

          {camError && <p className="error">Camera unavailable: {camError}</p>}
          {micError && <p className="error">Mic unavailable: {micError}</p>}

          <div className="record-block record-block-draw">
            <div className="record-block-head">
              <span className="record-block-icon"><Pencil size={16} /></span>
              <div>
                <div className="record-block-title">Draw on screen</div>
                <p className="record-block-sub">Annotate live while you record</p>
              </div>
            </div>
            <AnnotationToolbar />
          </div>
        </div>

        <div className="record-controls-col">
          <div className="record-block record-block-source">
            <div className="record-block-head">
              <span className="record-block-icon"><Monitor size={16} /></span>
              <div>
                <div className="record-block-title">What to capture</div>
                <p className="record-block-sub">Pick a screen or a single window</p>
              </div>
            </div>
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
          </div>

          <fieldset className="record-block record-block-camera" disabled={recording || busy}>
            <div className="record-block-head">
              <span className="record-block-icon"><Video size={16} /></span>
              <div>
                <div className="record-block-title">Camera bubble</div>
                <p className="record-block-sub">Your webcam, composited into the corner</p>
              </div>
            </div>
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

          <fieldset className="record-block record-block-audio" disabled={recording || busy}>
            <div className="record-block-head">
              <span className="record-block-icon"><Mic size={16} /></span>
              <div>
                <div className="record-block-title">Microphone</div>
                <p className="record-block-sub">Voice-over recorded alongside the screen</p>
              </div>
            </div>
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
            <div className="mic-meter">
              <span className="muted">Level{mic.muted ? " (muted)" : ""}</span>
              <div className="mic-meter-track">
                <div
                  className="mic-meter-fill"
                  style={{ width: `${mic.muted ? 0 : Math.min(100, (micLevel / 160) * 100)}%` }}
                />
              </div>
            </div>
          </fieldset>

          <div className="record-block record-block-cursor">
            <div className="record-block-head">
              <span className="record-block-icon"><MousePointer2 size={16} /></span>
              <div>
                <div className="record-block-title">
                  Cursor{" "}
                  <span className="info-dot" title={CURSOR_HINT} aria-label={CURSOR_HINT} role="img">
                    <Info size={13} />
                  </span>
                </div>
                <p className="record-block-sub">How the pointer appears in the recording</p>
              </div>
            </div>
            <div className="cursor-style-picker">
              <button
                type="button"
                className={`cursor-hide-toggle${cursorHidden ? " on" : ""}`}
                aria-pressed={cursorHidden}
                disabled={busy || recording}
                onClick={toggleCursorHidden}
                title={CURSOR_HINT}
              >
                <span className="cursor-hide-icon">
                  <NoCursorIcon />
                </span>
                <span className="cursor-hide-label">Hide cursor while recording</span>
                <span className="cursor-hide-switch" aria-hidden="true">
                  <span className="cursor-hide-knob" />
                </span>
              </button>
              <div className={`cursor-style-options${cursorHidden ? " dimmed" : ""}`}>
                {CURSOR_STYLES.map((s) => (
                  <button
                    key={s.value}
                    type="button"
                    className={`cursor-style-btn${overlay.cursorHighlight === s.value ? " active" : ""}`}
                    disabled={busy || cursorHidden}
                    // A plain radio choice — "System cursor" is itself an option in the
                    // list, so there's nothing for clicking the active one to toggle to.
                    onClick={() => setOverlay({ ...overlay, cursorHighlight: s.value })}
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
          </div>

          <div className="record-block record-block-output">
            <div className="record-block-head">
              <span className="record-block-icon"><FolderOpen size={16} /></span>
              <div>
                <div className="record-block-title">Save to</div>
                <p className="record-block-sub">Where the finished MP4 lands</p>
              </div>
            </div>
            <label className="field">
              <span>Title</span>
              <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} disabled={recording || busy} />
            </label>
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
          </div>
        </div>
      </div>

      {error && <p className="error">{error}</p>}
    </section>
  );
}
