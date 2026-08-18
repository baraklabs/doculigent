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

type Phase = "options" | "recording" | "encoding" | "done" | "error";

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
  const [resultPath, setResultPath] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const cancelCaptureRef = useRef<(() => void) | null>(null);
  const exportIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPhase("options");
    setProgress(0);
    setResultPath(null);
    setErrorMessage(null);
  }, [open]);

  useEffect(() => {
    return window.api.editProjects.onExportProgress(({ exportId, percent }) => {
      if (exportId !== exportIdRef.current) return;
      setProgress(percent / 100);
    });
  }, []);

  if (!open) return null;

  const dismissible = phase === "options" || phase === "done" || phase === "error";

  async function handleExport() {
    const compositor = compositorRef.current;
    if (!compositor) return;
    const tier = RESOLUTION_TIERS.find((t) => t.id === resolutionId) ?? RESOLUTION_TIERS[1];
    const { width, height } = resolveDimensions(tier, layoutFormat);

    setPhase("recording");
    setProgress(0);
    setErrorMessage(null);
    const { promise, cancel } = compositor.exportVideo({ fps, onProgress: setProgress });
    cancelCaptureRef.current = cancel;

    try {
      const captured = await promise;
      cancelCaptureRef.current = null;

      const exportId = crypto.randomUUID();
      exportIdRef.current = exportId;
      setPhase("encoding");
      setProgress(0);
      const webmBytes = await captured.blob.arrayBuffer();
      const result = await window.api.editProjects.export(exportId, {
        webmBytes,
        title,
        durationSecs: captured.durationSecs,
        width,
        height,
        fps,
      });
      exportIdRef.current = null;

      if (result.canceled) {
        setPhase("options");
        return;
      }
      setResultPath(result.filePath ?? null);
      setPhase("done");
      toast.success("Video exported");
    } catch (e) {
      cancelCaptureRef.current = null;
      exportIdRef.current = null;
      if (e instanceof ExportCancelledError) {
        setPhase("options");
        return;
      }
      setErrorMessage(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  function handleCancel() {
    if (phase === "recording") {
      cancelCaptureRef.current?.();
      return;
    }
    if (phase === "encoding" && exportIdRef.current) {
      window.api.editProjects.exportCancel(exportIdRef.current);
    }
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

        {(phase === "recording" || phase === "encoding") && (
          <div className="export-dialog-progress">
            <Loader2 size={22} className="export-dialog-spin" />
            <p className="export-dialog-progress-label">
              {phase === "recording" ? "Rendering…" : "Exporting video…"}
            </p>
            <div className="progress-bar-track">
              <div className="progress-bar-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <span className="export-dialog-progress-pct">{Math.round(progress * 100)}%</span>
            <button type="button" className="edit-topbar-btn" onClick={handleCancel}>
              Cancel
            </button>
          </div>
        )}

        {phase === "done" && (
          <div className="export-dialog-result">
            <Check size={28} className="export-dialog-result-icon" />
            <p>Exported successfully.</p>
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
