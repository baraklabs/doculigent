import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Upload, X } from "lucide-react";
import type { LayoutFormat } from "@shared/types/models";
import { ExportCancelledError, type PreviewCompositorHandle } from "./PreviewCompositor";
import { SettingsService } from "../services/settings/SettingsService";
import { useToast } from "../hooks/useToast";
import "./ExportDialog.css";

interface ResolutionTier {
  id: string;
  label: string;
  shortEdge: number;
  longEdge: number;
}

const RESOLUTION_TIERS: ResolutionTier[] = [
  { id: "720p", label: "720p", shortEdge: 720, longEdge: 1280 },
  { id: "1080p", label: "1080p", shortEdge: 1080, longEdge: 1920 },
  { id: "1440p", label: "1440p", shortEdge: 1440, longEdge: 2560 },
  { id: "2160p", label: "4K", shortEdge: 2160, longEdge: 3840 },
];
const DEFAULT_RESOLUTION_ID = "1080p"; // matches the canvas's own native pixel size

const FRAME_RATES = [24, 30, 60] as const;
const DEFAULT_FPS: (typeof FRAME_RATES)[number] = 30;

function resolveDimensions(tier: ResolutionTier, format: LayoutFormat): { width: number; height: number } {
  return format === "reel" ? { width: tier.shortEdge, height: tier.longEdge } : { width: tier.longEdge, height: tier.shortEdge };
}

function formatElapsed(secs: number): string {
  const total = Math.max(0, Math.floor(secs));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// "recording" covers the whole render+stream phase (progress is numeric, driven by
// PreviewCompositor's own frame count — see handleExport). "finishing" is the brief tail
// after every frame's been handed off, while exportEnd flushes ffmpeg's own remaining
// internal buffer and closes out the file — genuinely encoding concurrently with
// "recording" now (see startImagePipeExport), not a separate pass after it, so it has no
// progress of its own worth showing; an indeterminate spinner instead of a second 0-100
// bar avoids a jittery double progress-source.
type Phase = "options" | "recording" | "finishing" | "done" | "error";

interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  compositorRef: React.RefObject<PreviewCompositorHandle | null>;
  layoutFormat: LayoutFormat;
  title: string;
}

export function ExportDialog({ open, onClose, compositorRef, layoutFormat, title }: ExportDialogProps) {
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>("options");
  const [resolutionId, setResolutionId] = useState(DEFAULT_RESOLUTION_ID);
  const [fps, setFps] = useState<(typeof FRAME_RATES)[number]>(DEFAULT_FPS);
  const [progress, setProgress] = useState(0);
  // ffmpeg's own encode progress (out_time_us / durationSecs — see
  // startImagePipeExport) — kept entirely separate from `progress` above (which tracks
  // frame-streaming progress, a different, unrelated 0-100) so the two can never fight
  // over the same number; only ever shown during the "finishing" phase, once streaming's
  // done and this is the only meaningful progress left.
  const [finishProgress, setFinishProgress] = useState(0);
  const [resultPath, setResultPath] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [elapsedSecs, setElapsedSecs] = useState(0);

  const cancelCaptureRef = useRef<(() => void) | null>(null);
  const exportIdRef = useRef<string | null>(null);
  const exportStartedAtRef = useRef(0);
  const elapsedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!open) return;
    setPhase("options");
    setProgress(0);
    setFinishProgress(0);
    setResultPath(null);
    setErrorMessage(null);
    setElapsedSecs(0);
    stopElapsedTimer();
  }, [open]);

  useEffect(() => {
    return window.api.editProjects.onExportProgress(({ exportId, percent }) => {
      if (exportId !== exportIdRef.current) return;
      setFinishProgress(percent / 100);
    });
  }, []);

  // Stops on unmount too, not just when a phase transition calls it explicitly (see
  // handleExport) — a plain interval, once started, keeps firing until cleared even after
  // this component stops caring about it.
  useEffect(() => stopElapsedTimer, []);

  // Starts (or restarts) the elapsed-time readout — called once the save dialog has
  // actually been confirmed (see handleExport's beginExport), not from when the export
  // button was clicked, since audio-rendering and the save dialog itself can each take a
  // moment the user didn't ask to have counted as "exporting". A plain interval rather
  // than deriving elapsed from progress, since it needs to keep counting up smoothly even
  // through stretches (a slow segment seek, ffmpeg's own tail flush) where progress itself
  // doesn't move.
  function startElapsedTimer() {
    stopElapsedTimer();
    exportStartedAtRef.current = performance.now();
    setElapsedSecs(0);
    elapsedIntervalRef.current = setInterval(() => setElapsedSecs((performance.now() - exportStartedAtRef.current) / 1000), 250);
  }

  function stopElapsedTimer() {
    if (elapsedIntervalRef.current) {
      clearInterval(elapsedIntervalRef.current);
      elapsedIntervalRef.current = null;
    }
  }

  if (!open) return null;

  const dismissible = phase === "options" || phase === "done" || phase === "error";

  async function handleExport() {
    const compositor = compositorRef.current;
    if (!compositor) return;
    const tier = RESOLUTION_TIERS.find((t) => t.id === resolutionId) ?? RESOLUTION_TIERS[1];
    const { width, height } = resolveDimensions(tier, layoutFormat);

    const exportId = crypto.randomUUID();
    exportIdRef.current = exportId;
    setPhase("recording");
    setProgress(0);
    setFinishProgress(0);
    setErrorMessage(null);
    setElapsedSecs(0);

    // Streaming export — PreviewCompositor renders and JPEG-encodes each frame itself,
    // handing them to onFrame one at a time; this component's only job is turning those
    // into the actual main-process IPC calls that stream them into ffmpeg (see
    // startImagePipeExport). beginExport fires once, after audio's been fully rendered
    // (offline) but before any frame work starts, since the ffmpeg process needs that
    // audio file to exist the moment it spawns.
    const { promise, cancel } = compositor.exportVideo({
      fps,
      onProgress: setProgress,
      decodeAudio: (filePath) => window.api.editProjects.decodeAudioToWav(filePath),
      beginExport: async (info) => {
        const begun = await window.api.editProjects.exportBegin(exportId, {
          title,
          durationSecs: info.durationSecs,
          width,
          height,
          fps,
          audioWavBytes: info.audioWavBytes,
        });
        if (begun.canceled) return false;
        startElapsedTimer();
        return true;
      },
      onFrame: (jpegBytes) => window.api.editProjects.exportFrame(exportId, jpegBytes),
    });
    cancelCaptureRef.current = cancel;

    try {
      await promise;
      cancelCaptureRef.current = null;

      setPhase("finishing");
      const result = await window.api.editProjects.exportEnd(exportId);
      exportIdRef.current = null;
      stopElapsedTimer();

      if (result.canceled) {
        setPhase("options");
        return;
      }
      setResultPath(result.filePath ?? null);
      setPhase("done");
      toast.success("Video exported");
    } catch (e) {
      cancelCaptureRef.current = null;
      stopElapsedTimer();
      // Whatever failed (a cancel, a save-dialog dismissal, a mid-stream IPC error), the
      // main process may still have a spawned ffmpeg process and/or a temp audio file
      // waiting on this exportId — give it a chance to clean those up regardless of
      // where in the pipeline things stopped. A no-op (NotFoundError) if exportBegin
      // never actually got that far.
      if (exportIdRef.current) {
        await window.api.editProjects.exportEnd(exportIdRef.current).catch(() => {});
        exportIdRef.current = null;
      }
      if (e instanceof ExportCancelledError) {
        setPhase("options");
        return;
      }
      setErrorMessage(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  function handleCancel() {
    cancelCaptureRef.current?.();
    if (exportIdRef.current) window.api.editProjects.exportCancel(exportIdRef.current);
  }

  return (
    <div className="export-dialog-backdrop" onClick={dismissible ? onClose : undefined}>
      <div className="export-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="export-dialog-header">
          <h2>Export video</h2>
          {dismissible && (
            <button type="button" className="export-dialog-close" onClick={onClose} aria-label="Close">
              <X size={16} />
            </button>
          )}
        </div>

        {phase === "options" && (
          <>
            <div className="export-dialog-section">
              <span className="export-dialog-label">Resolution</span>
              <div className="export-option-grid">
                {RESOLUTION_TIERS.map((tier) => {
                  const { width, height } = resolveDimensions(tier, layoutFormat);
                  return (
                    <button
                      key={tier.id}
                      type="button"
                      className={`export-option-tile${resolutionId === tier.id ? " active" : ""}`}
                      aria-pressed={resolutionId === tier.id}
                      onClick={() => setResolutionId(tier.id)}
                    >
                      <span className="export-option-tile-label">{tier.label}</span>
                      <span className="export-option-tile-sublabel">
                        {width}×{height}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="export-dialog-section">
              <span className="export-dialog-label">Frame rate</span>
              <div className="export-option-grid">
                {FRAME_RATES.map((rate) => (
                  <button
                    key={rate}
                    type="button"
                    className={`export-option-tile${fps === rate ? " active" : ""}`}
                    aria-pressed={fps === rate}
                    onClick={() => setFps(rate)}
                  >
                    <span className="export-option-tile-label">{rate} fps</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="export-dialog-actions">
              <button type="button" className="edit-topbar-btn" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="edit-topbar-btn primary" onClick={handleExport}>
                <Upload size={15} />
                Export
              </button>
            </div>
          </>
        )}

        {(phase === "recording" || phase === "finishing") && (
          <div className="export-dialog-progress">
            <Loader2 size={22} className="export-dialog-spin" />
            <p className="export-dialog-progress-label">{phase === "recording" ? "Exporting video…" : "Finishing up…"}</p>
            <span className="export-dialog-elapsed">{formatElapsed(elapsedSecs)} elapsed</span>
            <div className="progress-bar-track">
              <div
                className="progress-bar-fill"
                style={{ width: `${Math.round((phase === "recording" ? progress : finishProgress) * 100)}%` }}
              />
            </div>
            <span className="export-dialog-progress-pct">{Math.round((phase === "recording" ? progress : finishProgress) * 100)}%</span>
            <button type="button" className="edit-topbar-btn" onClick={handleCancel}>
              Cancel
            </button>
          </div>
        )}

        {phase === "done" && (
          <div className="export-dialog-result">
            <Check size={28} className="export-dialog-result-icon" />
            <p>Exported successfully in {formatElapsed(elapsedSecs)}.</p>
            {resultPath && (
              <p className="export-dialog-result-path" title={resultPath}>
                {resultPath}
              </p>
            )}
            <div className="export-dialog-actions">
              {resultPath && (
                <button
                  type="button"
                  className="edit-topbar-btn"
                  onClick={() => SettingsService.showItemInFolder(resultPath)}
                >
                  Show in folder
                </button>
              )}
              <button type="button" className="edit-topbar-btn primary" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        )}

        {phase === "error" && (
          <div className="export-dialog-result">
            <p className="export-dialog-error">{errorMessage ?? "Export failed."}</p>
            <div className="export-dialog-actions">
              <button type="button" className="edit-topbar-btn" onClick={onClose}>
                Close
              </button>
              <button type="button" className="edit-topbar-btn primary" onClick={() => setPhase("options")}>
                Try again
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
