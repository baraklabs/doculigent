import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Pencil,
  Monitor,
  AppWindow,
  Crop,
  Camera,
  Video,
  Mic,
  Volume2,
  FolderOpen,
  ChevronDown,
  Loader2,
} from "lucide-react";
import type {
  AreaRect,
  CameraBlurLevel,
  CaptureMode,
  CaptureTarget,
  MicConfig,
  OverlayConfig,
  SystemAudioConfig,
} from "@shared/types/models";
import { useRecordingStore, useSavingRecording } from "../store/recordingStore";
import { recordingService } from "../services/recording/RecordingService";
import { applyCameraBlur, preloadCameraBlurModel, type CameraBlurHandle } from "../services/camera/cameraBlur";
import { getSystemAudioStream } from "../services/recording/AudioRecordingService";
import { SettingsService } from "../services/settings/SettingsService";
import { AnnotationToolbar } from "../components/AnnotationToolbar";
import "./RecordPage.css";

const DEFAULT_OVERLAY: OverlayConfig = {
  corner: "bottom-right",
  sizePct: 18,
  circular: true,
  showCamera: false,
  cameraDeviceId: null,
  mirrorCamera: true,
  cameraBlur: "none",
};

const BLUR_CYCLE: CameraBlurLevel[] = ["none", "soft", "aggressive"];
const BLUR_META: Record<CameraBlurLevel, { label: string; color: string; bg: string }> = {
  none: { label: "Background blur: Off", color: "var(--muted)", bg: "rgba(92, 98, 115, 0.1)" },
  soft: { label: "Background blur: Low", color: "#0ea5e9", bg: "rgba(14, 165, 233, 0.16)" },
  aggressive: { label: "Background blur: High", color: "#075985", bg: "rgba(7, 89, 133, 0.22)" },
};

function BlurIcon({ level }: { level: CameraBlurLevel }) {
  const stdDeviation = level === "none" ? 0 : level === "soft" ? 0.7 : 1.6;
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      {stdDeviation > 0 && (
        <defs>
          <filter id={`blur-icon-${level}`} x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation={stdDeviation} />
          </filter>
        </defs>
      )}
      <circle
        cx="8"
        cy="8"
        r="4.5"
        fill="currentColor"
        filter={stdDeviation > 0 ? `url(#blur-icon-${level})` : undefined}
      />
    </svg>
  );
}

function TargetDropdown({
  targets,
  value,
  disabled,
  placeholderLabel,
  onOpen,
  onSelect,
}: {
  targets: CaptureTarget[];
  value: string;
  disabled: boolean;
  placeholderLabel: string;
  onOpen: () => void;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  const selected = targets.find((t) => t.id === value);

  return (
    <div className="target-dropdown" ref={rootRef} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="target-dropdown-trigger"
        disabled={disabled || targets.length === 0}
        onClick={() => {
          setOpen((o) => {
            const next = !o;
            if (next) onOpen();
            return next;
          });
        }}
      >
        <span>{targets.length === 0 ? placeholderLabel : (selected?.title ?? placeholderLabel)}</span>
      </button>
      {open && (
        <div className="target-dropdown-list">
          {targets.map((t) => (
            <button
              type="button"
              key={t.id}
              className={`target-dropdown-item${t.id === value ? " active" : ""}`}
              onClick={() => {
                onSelect(t.id);
                setOpen(false);
              }}
            >
              <span className="target-dropdown-thumb">
                {t.thumbnailDataUrl ? (
                  <img src={t.thumbnailDataUrl} alt="" />
                ) : (
                  <span className="target-dropdown-thumb-empty" />
                )}
              </span>
              <span className="target-dropdown-item-title">{t.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

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
  const { recording, paused, busy, error, warning, start, stop, pause, resume, restart, discard, saveStatus, cancelSave } =
    useRecordingStore();
  const saving = useSavingRecording();
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const { data: targets = [], refetch: refetchTargets } = useQuery<CaptureTarget[]>({
    queryKey: ["captureTargets"],
    queryFn: () => window.api.capture.listTargets(),
    refetchOnWindowFocus: true,
  });
  const { data: screenPermission } = useQuery({
    queryKey: ["screenPermission"],
    queryFn: () => window.api.capture.getPermissionStatus(),
    refetchOnWindowFocus: true,
  });
  const screenPermissionDenied = targets.length === 0 && screenPermission && screenPermission.screen !== "granted";
  const [targetId, setTargetId] = useState("");
  const [captureMode, setCaptureMode] = useState<CaptureMode>("display");
  const [areaRect, setAreaRect] = useState<AreaRect | null>(null);
  const windowTargets = useMemo(() => targets.filter((t) => t.kind === "window"), [targets]);

  const [overlay, setOverlay] = useState<OverlayConfig>(DEFAULT_OVERLAY);
  const [title, setTitle] = useState(() => defaultRecordingTitle());
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [preferredTargetId, setPreferredTargetId] = useState<string | null>(null);
  const [mic, setMic] = useState<MicConfig>({ deviceId: null, muted: false });
  const [systemAudio, setSystemAudio] = useState<SystemAudioConfig>({ enabled: false, sourceId: null });
  const [countdownSecs, setCountdownSecs] = useState(3);

  useEffect(() => {
    SettingsService.getRecordSettings()
      .then(
        ({
          overlay: savedOverlay,
          targetId: savedTargetId,
          mic: savedMic,
          systemAudio: savedSystemAudio,
          captureMode: savedCaptureMode,
          areaRect: savedAreaRect,
          countdownSecs: savedCountdownSecs,
        }) => {
          if (savedOverlay) setOverlay({ ...DEFAULT_OVERLAY, ...savedOverlay });
          setPreferredTargetId(savedTargetId);
          if (savedMic) setMic(savedMic);
          if (savedSystemAudio) setSystemAudio(savedSystemAudio);
          if (savedCaptureMode) setCaptureMode(savedCaptureMode);
          if (savedAreaRect) setAreaRect(savedAreaRect);
          if (savedCountdownSecs !== null) setCountdownSecs(savedCountdownSecs);
        }
      )
      .finally(() => setSettingsLoaded(true));
  }, []);

  useEffect(() => {
    const shouldShow = overlay.showCamera && captureMode !== "camera";
    if (!shouldShow) {
      window.api.cameraBubble.close().catch(() => {});
      return;
    }
    window.api.cameraBubble
      .open({ mirror: overlay.mirrorCamera, cameraDeviceId: overlay.cameraDeviceId, blur: overlay.cameraBlur })
      .catch(() => {});
  }, [overlay.showCamera, overlay.mirrorCamera, overlay.cameraDeviceId, overlay.cameraBlur, captureMode]);

  useEffect(() => {
    return window.api.cameraBubble.onClosedByUser(() => {
      setOverlay((prev) => (prev.showCamera ? { ...prev, showCamera: false } : prev));
    });
  }, []);

  useEffect(() => {
    return () => {
      window.api.cameraBubble.close().catch(() => {});
    };
  }, []);

  function syncDockTimer() {
    window.api.recordingDock
      .syncTimer({ elapsedMs: recordingService.getElapsedMs(), paused: recordingService.isPaused() })
      .catch(() => {});
  }

  useEffect(() => {
    if (recording) {
      window.api.recordingDock.open().catch((e) => console.error("Failed to open recording dock:", e));
      window.api.recordingDock.hideMainWindow().catch(() => {});
      syncDockTimer();
    } else {
      window.api.recordingDock.close().catch(() => {});
      window.api.recordingDock.showMainWindow().catch(() => {});
    }
  }, [recording]);

  useEffect(() => {
    if (!recording) return;
    syncDockTimer();
  }, [paused, recording]);

  useEffect(() => {
    return window.api.recordingDock.onAction(async (action) => {
      if (action === "pause") await pause();
      else if (action === "resume") await resume();
      else if (action === "stop") await handleStop();
      else if (action === "restart") {
        await restart();
        syncDockTimer();
      } else if (action === "discard") {
        await discard();
      }
    });
  }, [pause, resume, restart, discard]);

  useEffect(() => {
    return () => {
      window.api.recordingDock.close().catch(() => {});
      window.api.countdown.close().catch(() => {});
    };
  }, []);

  const [displayTargets, setDisplayTargets] = useState<CaptureTarget[]>([]);
  useEffect(() => {
    const displays = targets.filter((t) => t.kind === "display");
    setDisplayTargets(displays);
    setSystemAudio((current) => (current.sourceId ? current : { ...current, sourceId: displays[0]?.id ?? null }));
  }, [targets]);

  useEffect(() => {
    if (captureMode === "camera") return;
    // Waits on the saved settings round-trip (preferredTargetId), not just the targets
    // query — capture.listTargets() usually resolves before settings:getRecordSettings
    // does, and without this guard that race picked pool[0] (whichever target happens to
    // be first) as soon as the target list arrived, then the "already have a valid
    // targetId, leave it alone" check below meant the *real* saved preference — arriving
    // moments later — was ignored, since the id it just picked was itself already valid.
    // Every remount (e.g. switching tabs and back) re-runs this race, which is why it only
    // reset "sometimes" rather than consistently.
    if (!settingsLoaded) return;
    const pool = captureMode === "window" ? windowTargets : displayTargets;
    if (pool.length === 0) {
      if (targetId) setTargetId("");
      return;
    }
    if (targetId && pool.some((t) => t.id === targetId)) return;
    const preferred = preferredTargetId && pool.some((t) => t.id === preferredTargetId) ? preferredTargetId : pool[0].id;
    setTargetId(preferred);
  }, [captureMode, windowTargets, displayTargets, targetId, preferredTargetId, settingsLoaded]);

  useEffect(() => {
    if (!settingsLoaded) return;
    SettingsService.setRecordSettings(
      overlay,
      targetId || null,
      mic,
      systemAudio,
      captureMode,
      areaRect,
      countdownSecs
    ).catch(() => {});
  }, [overlay, targetId, mic, systemAudio, captureMode, areaRect, countdownSecs, settingsLoaded]);

  const recordingRef = useRef(recording);
  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

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
    window.api.settings.getRecordingsDir().then(setSaveDir).catch(() => {});
  }, []);

  const [micLevel, setMicLevel] = useState(0);
  const [blurLoading, setBlurLoading] = useState(false);

  const camPreviewVideoRef = useRef<HTMLVideoElement>(null);
  const [camPreviewError, setCamPreviewError] = useState<string | null>(null);
  const [camPreviewStream, setCamPreviewStream] = useState<MediaStream | null>(null);
  useEffect(() => {
    if (captureMode !== "camera" || recording) {
      setCamPreviewError(null);
      setCamPreviewStream(null);
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
        setCamPreviewStream(s);
        setCamPreviewError(null);
        refreshDevices();
      })
      .catch((e) => setCamPreviewError(String(e)));
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
      setCamPreviewStream(null);
    };
  }, [captureMode, overlay.cameraDeviceId, recording]);

  useEffect(() => {
    if (!camPreviewStream || !camPreviewVideoRef.current) return;
    let blurHandle: CameraBlurHandle | null = null;
    if (overlay.cameraBlur === "none") {
      camPreviewVideoRef.current.srcObject = camPreviewStream;
    } else {
      blurHandle = applyCameraBlur(camPreviewStream, overlay.cameraBlur);
      camPreviewVideoRef.current.srcObject = blurHandle.stream;
    }
    return () => {
      blurHandle?.stop();
    };
  }, [camPreviewStream, overlay.cameraBlur]);

  const [countdownRemaining, setCountdownRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (countdownRemaining === null) {
      window.api.countdown.close().catch(() => {});
      return;
    }
    window.api.countdown.open(countdownRemaining).catch(() => {});
    if (countdownRemaining === 0) {
      setCountdownRemaining(null);
      void beginRecording();
      return;
    }
    const timer = setTimeout(() => setCountdownRemaining((c) => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(timer);
  }, [countdownRemaining]);

  useEffect(() => window.api.countdown.onCancelled(cancelPendingStart), []);

  const [micError, setMicError] = useState<string | null>(null);

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

  const [systemAudioLevel, setSystemAudioLevel] = useState(0);
  const [systemAudioError, setSystemAudioError] = useState<string | null>(null);
  useEffect(() => {
    if (!systemAudio.enabled || !systemAudio.sourceId || recording) {
      setSystemAudioLevel(0);
      setSystemAudioError(null);
      return;
    }
    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    let raf = 0;
    let cancelled = false;
    getSystemAudioStream(systemAudio.sourceId)
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
          setSystemAudioLevel(data.reduce((a, b) => a + b, 0) / data.length);
          raf = requestAnimationFrame(tick);
        };
        tick();
        setSystemAudioError(null);
      })
      .catch((e) => setSystemAudioError(String(e)));
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      audioCtx?.close();
    };
  }, [systemAudio.enabled, systemAudio.sourceId, recording]);

  const [selectingArea, setSelectingArea] = useState(false);
  async function openAreaSelector() {
    setSelectingArea(true);
    try {
      await window.api.areaSelect.open();
    } catch {
      setSelectingArea(false);
    }
  }
  useEffect(() => {
    const unsubCompleted = window.api.areaSelect.onCompleted(({ targetId: pickedTargetId, rect }) => {
      setSelectingArea(false);
      setCaptureMode("area");
      setTargetId(pickedTargetId);
      setAreaRect(rect);
    });
    const unsubCancelled = window.api.areaSelect.onCancelled(() => setSelectingArea(false));
    return () => {
      unsubCompleted();
      unsubCancelled();
    };
  }, []);

  async function browseSaveDir() {

    if (pickingDir) return;
    setPickingDir(true);
    try {
      const picked = await window.api.settings.pickRecordingsDir();
      if (picked) {
        setSaveDir(picked);
        await window.api.settings.setRecordingsDir(picked);
      }
    } finally {
      setPickingDir(false);
    }
  }

  function commitSaveDir() {
    if (saveDir) window.api.settings.setRecordingsDir(saveDir).catch(() => {});
  }

  async function beginRecording() {
    await start(targetId, overlay, mic, systemAudio, title, "record", captureMode, captureMode === "area" ? areaRect : null);
  }

  function handleStart() {
    if (countdownSecs > 0) {
      window.api.recordingDock.open().catch((e) => console.error("Failed to open recording dock:", e));
      window.api.recordingDock.hideMainWindow().catch(() => {});
      setCountdownRemaining(countdownSecs);
    } else {
      void beginRecording();
    }
  }

  function cancelPendingStart() {
    setCountdownRemaining(null);
    window.api.recordingDock.close().catch(() => {});
    window.api.recordingDock.showMainWindow().catch(() => {});
  }

  async function handleStop() {
    await stop();
  }

  const startDisabled =
    (captureMode !== "camera" && !targetId) || (captureMode === "area" && !areaRect) || busy || saving;

  const selectedCameraLabel = overlay.cameraDeviceId
    ? cameraDevices.find((d) => d.deviceId === overlay.cameraDeviceId)?.label || "Camera"
    : "Default camera";

  return (
    <section className="panel record-page">
         <div className="record-layout">
        <div className="record-preview-col">
          <div className="record-block record-block-source">
            <div className="record-block-head">
              <span className="record-block-icon"><Monitor size={16} /></span>
              <div>
                <div className="record-block-title">What to capture</div>
              </div>
            </div>
            <div className="capture-mode-grid">
              {/* A <div>, not a <button> — it hosts a real nested dropdown trigger button
                  (see TargetDropdown), and a button can't nest a button. */}
              <div
                role="button"
                tabIndex={0}
                aria-pressed={captureMode === "display"}
                className={`capture-tile${captureMode === "display" ? " active" : ""}`}
                aria-disabled={recording || busy}
                onClick={() => {
                  if (!recording && !busy) setCaptureMode("display");
                }}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === " ") && !recording && !busy) {
                    e.preventDefault();
                    setCaptureMode("display");
                  }
                }}
              >
                <div className="capture-tile-head">
                  <Monitor size={36} />
                  <span>Display</span>
                </div>
                <TargetDropdown
                  targets={displayTargets}
                  value={captureMode === "display" ? targetId : ""}
                  disabled={recording || busy}
                  placeholderLabel="Select"
                  onOpen={() => refetchTargets()}
                  onSelect={(id) => {
                    setCaptureMode("display");
                    setTargetId(id);
                  }}
                />
              </div>

              <div
                role="button"
                tabIndex={0}
                aria-pressed={captureMode === "window"}
                className={`capture-tile${captureMode === "window" ? " active" : ""}`}
                aria-disabled={recording || busy}
                onClick={() => {
                  if (!recording && !busy) setCaptureMode("window");
                }}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === " ") && !recording && !busy) {
                    e.preventDefault();
                    setCaptureMode("window");
                  }
                }}
              >
                <div className="capture-tile-head">
                  <AppWindow size={36} />
                  <span>Window</span>
                </div>
                <TargetDropdown
                  targets={windowTargets}
                  value={captureMode === "window" ? targetId : ""}
                  disabled={recording || busy}
                  placeholderLabel="Select"
                  onOpen={() => refetchTargets()}
                  onSelect={(id) => {
                    setCaptureMode("window");
                    setTargetId(id);
                  }}
                />
              </div>

              {/* A <div>, not a <button> like the other tiles — it hosts a real nested
                  "Select area…" button (see below), and a button can't nest a button. */}
              <div
                role="button"
                tabIndex={0}
                aria-pressed={captureMode === "area"}
                className={`capture-tile${captureMode === "area" ? " active" : ""}`}
                aria-disabled={recording || busy}
                onClick={() => {
                  if (!recording && !busy) setCaptureMode("area");
                }}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === " ") && !recording && !busy) {
                    e.preventDefault();
                    setCaptureMode("area");
                  }
                }}
              >
                <div className="capture-tile-head">
                  <Crop size={36} />
                  <span>Area</span>
                </div>
                <button
                  type="button"
                  className="capture-tile-action"
                  disabled={recording || busy || selectingArea}
                  onClick={(e) => {
                    e.stopPropagation();
                    openAreaSelector();
                  }}
                >
                  {selectingArea ? "Selecting…" : "Select area…"}
                </button>
              </div>

              <button
                type="button"
                className={`capture-tile${captureMode === "camera" ? " active" : ""}`}
                disabled={recording || busy}
                onClick={() => setCaptureMode("camera")}
              >
                {captureMode === "camera" && !camPreviewError ? (
                  <div className="capture-tile-camera-preview">
                    <video
                      ref={camPreviewVideoRef}
                      autoPlay
                      muted
                      playsInline
                      style={overlay.mirrorCamera ? undefined : { transform: "scaleX(-1)" }}
                    />
                  </div>
                ) : (
                  <>
                    <div className="capture-tile-head">
                      <Camera size={36} />
                      <span>Camera only</span>
                    </div>
                    {/* Read-only — the actual picker lives in the Camera block below, same
                        as every other capture mode. */}
                    <p className="capture-tile-note">
                      {captureMode === "camera" ? "Camera unavailable" : selectedCameraLabel}
                    </p>
                  </>
                )}
              </button>
            </div>
            {screenPermissionDenied && (
              <p className="error">
                Screen Recording permission is required.{" "}
                <button type="button" className="link-btn" onClick={() => window.api.capture.openScreenRecordingSettings()}>
                  Open System Settings
                </button>
                , enable it there, then restart Doculigent.
              </p>
            )}
          </div>

          <fieldset className="record-block record-block-camera" disabled={recording || busy}>
            <div className="record-block-head">
              <span className="record-block-icon"><Video size={16} /></span>
              <div>
                {captureMode === "camera" || overlay.showCamera ? (
                  <div className="record-block-title-picker">
                    <select
                      className="record-block-title-select"
                      value={overlay.cameraDeviceId ?? ""}
                      onChange={(e) => setOverlay({ ...overlay, cameraDeviceId: e.target.value || null })}
                    >
                      <option value="">Default camera</option>
                      {cameraDevices.map((d, i) => (
                        <option key={d.deviceId || i} value={d.deviceId}>
                          {d.label || `Camera ${i + 1}`}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={12} className="record-block-sub-picker-icon" />
                  </div>
                ) : (
                  <div className="record-block-title">Camera</div>
                )}
              </div>
              <div className="camera-header-toggles">
                {(captureMode === "camera" || overlay.showCamera) &&
                  (() => {
                    const { label, color, bg } = BLUR_META[overlay.cameraBlur];
                    return (
                      <button
                        type="button"
                        className={`header-icon-toggle${overlay.cameraBlur !== "none" ? " on" : ""}`}
                        style={{ color, backgroundColor: bg }}
                        aria-pressed={overlay.cameraBlur !== "none"}
                        aria-label={label}
                        title={blurLoading ? "Loading blur model…" : label}
                        data-tooltip={blurLoading ? "Loading blur model…" : label}
                        disabled={blurLoading}
                        onClick={() => {
                          const next = BLUR_CYCLE[(BLUR_CYCLE.indexOf(overlay.cameraBlur) + 1) % BLUR_CYCLE.length];
                          setOverlay({ ...overlay, cameraBlur: next });
                          if (next !== "none") {
                            setBlurLoading(true);
                            preloadCameraBlurModel().finally(() => setBlurLoading(false));
                          }
                        }}
                      >
                        <BlurIcon level={overlay.cameraBlur} />
                      </button>
                    );
                  })()}
                {(captureMode === "camera" || overlay.showCamera) && (
                  <button
                    type="button"
                    className={`header-toggle${overlay.mirrorCamera ? " on" : ""}`}
                    aria-pressed={overlay.mirrorCamera}
                    onClick={() => setOverlay({ ...overlay, mirrorCamera: !overlay.mirrorCamera })}
                  >
                    <span>Mirror</span>
                    <span className="header-toggle-switch" aria-hidden="true">
                      <span className="header-toggle-knob" />
                    </span>
                  </button>
                )}
                {captureMode !== "camera" && (
                  <button
                    type="button"
                    className={`header-toggle${overlay.showCamera ? " on" : ""}`}
                    aria-pressed={overlay.showCamera}
                    onClick={() => setOverlay({ ...overlay, showCamera: !overlay.showCamera })}
                  >
                    <span>{overlay.showCamera ? "On" : "Off"}</span>
                    <span className="header-toggle-switch" aria-hidden="true">
                      <span className="header-toggle-knob" />
                    </span>
                  </button>
                )}
              </div>
            </div>
            {/* Shape/position/size are no longer set here at all — the bubble configures its
                own look via its in-window toolbar, and is dragged/resized directly on
                screen, the way Cap and similar tools work (see CameraBubblePage.tsx). */}
          </fieldset>

          <div className="record-audio-row">
            <fieldset className="record-block record-block-audio" disabled={recording || busy}>
              <div className="record-block-head">
                <span className="record-block-icon"><Mic size={16} /></span>
                <div className="record-block-title-slot">
                  {mic.muted ? (
                    <div className="record-block-title">Microphone</div>
                  ) : (
                    <div className="record-block-title-picker">
                      <select
                        className="record-block-title-select"
                        value={mic.deviceId ?? ""}
                        onChange={(e) => setMic({ ...mic, deviceId: e.target.value || null })}
                      >
                        <option value="">Default microphone</option>
                        {micDevices.map((d, i) => (
                          <option key={d.deviceId || i} value={d.deviceId}>
                            {d.label || `Microphone ${i + 1}`}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={12} className="record-block-sub-picker-icon" />
                    </div>
                  )}
                  {!mic.muted && (
                    <div className="record-block-sub-meter">
                      <div
                        className="record-block-sub-meter-fill"
                        style={{ width: `${Math.min(100, (micLevel / 160) * 100)}%` }}
                      />
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className={`header-toggle${!mic.muted ? " on" : ""}`}
                  aria-pressed={!mic.muted}
                  onClick={() => setMic({ ...mic, muted: !mic.muted })}
                >
                  <span>Mute</span>
                  <span className="header-toggle-switch" aria-hidden="true">
                    <span className="header-toggle-knob" />
                  </span>
                </button>
              </div>
            </fieldset>

            <div className="record-block record-block-system-audio">
              <div className="record-block-head">
                <span className="record-block-icon"><Volume2 size={16} /></span>
                <div className="record-block-title-slot">
                  <div className="record-block-title">System sound</div>
                  {systemAudio.enabled && (
                    <div className="record-block-sub-meter" title={systemAudioError ?? undefined}>
                      <div
                        className="record-block-sub-meter-fill"
                        style={{ width: `${Math.min(100, (systemAudioLevel / 160) * 100)}%` }}
                      />
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className={`header-toggle${systemAudio.enabled ? " on" : ""}`}
                  aria-pressed={systemAudio.enabled}
                  disabled={displayTargets.length === 0 || recording || busy}
                  onClick={() => setSystemAudio({ ...systemAudio, enabled: !systemAudio.enabled })}
                >
                  <span>{systemAudio.enabled ? "On" : "Off"}</span>
                  <span className="header-toggle-switch" aria-hidden="true">
                    <span className="header-toggle-knob" />
                  </span>
                </button>
              </div>
            </div>
          </div>

          <div className="record-cta">
            {!recording ? (
              <>
                <button
                  className="record-cta-btn"
                  onClick={handleStart}
                  disabled={startDisabled || countdownRemaining !== null}
                  title={saving ? "Finishing the previous recording…" : undefined}
                >
                  <span className="record-cta-dot" />
                  {countdownRemaining !== null ? "Starting…" : busy ? "Starting…" : "Start recording"}
                </button>
                <div className="record-countdown-stepper" title="Countdown before recording starts">
                  <button
                    type="button"
                    className="record-countdown-step-btn"
                    disabled={countdownSecs <= 0 || countdownRemaining !== null}
                    onClick={() => setCountdownSecs((s) => Math.max(0, s - 1))}
                  >
                    −
                  </button>
                  <span className="record-countdown-step-value">{countdownSecs}s</span>
                  <button
                    type="button"
                    className="record-countdown-step-btn"
                    disabled={countdownSecs >= 10 || countdownRemaining !== null}
                    onClick={() => setCountdownSecs((s) => Math.min(10, s + 1))}
                  >
                    +
                  </button>
                </div>
              </>
            ) : (
              <button className="record-cta-btn stop" onClick={handleStop} disabled={busy}>
                <span className="record-cta-square" />
                {busy ? "Stopping…" : "Stop recording"}
              </button>
            )}
          </div>

          {micError && <p className="error">Mic unavailable: {micError}</p>}
        </div>

        <div className="record-controls-col">
          <div className="record-block record-block-draw">
            <div className="record-block-head">
              <span className="record-block-icon"><Pencil size={16} /></span>
              <div>
                <div className="record-block-title">Draw on screen</div>
                <p className="record-block-sub" title="Works anywhere — not just while this app has focus">
                  Annotate live while you record · Show/hide: Ctrl+Shift+A · Clear: Ctrl+Shift+X
                </p>
              </div>
            </div>
            <AnnotationToolbar />
          </div>

          <div className="record-block record-block-output">
            <div className="record-block-head">
              <span className="record-block-icon"><FolderOpen size={16} /></span>
              <div>
                <div className="record-block-title">Save to</div>
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

      {/* Covers the whole tab, not just a card in one column — recording save is a
          nav-locking, background-processed operation (see Layout/RecordingSaveToast), so
          nothing on this page is actionable while it's in flight anyway. Disappears back to
          the ordinary blocks the instant `saving` clears (saveStatus flips to ready/failed/
          cancelled) — the completion popup itself is RecordingSaveToast, rendered globally
          by Layout so it's visible even if the user already navigated away from Record. */}
      {saving && (
        <div className="record-processing-overlay">
          <Loader2 className="record-processing-spin" size={32} />
          <span className="record-processing-label">Processing recording…</span>
          <div className="record-processing-bar">
            <div className="record-processing-bar-fill" style={{ width: `${saveStatus?.percent ?? 0}%` }} />
          </div>
          {saveStatus?.status === "processing" && (
            <button
              type="button"
              className="record-processing-cancel"
              disabled={cancelling}
              onClick={async () => {
                setCancelling(true);
                setCancelError(null);
                try {
                  await cancelSave();
                } catch (e) {
                  setCancelError(String(e));
                } finally {
                  setCancelling(false);
                }
              }}
            >
              {cancelling ? "Cancelling…" : "Cancel"}
            </button>
          )}
          {cancelError && <p className="record-processing-cancel-error">Couldn't cancel: {cancelError}</p>}
        </div>
      )}

      {error && <p className="error">{error}</p>}
      {!error && warning && <p className="error">{warning}</p>}
    </section>
  );
}
