import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTrimVideo, useVideo } from "../hooks/useVideos";

/** Minimal trim editor — metadata-only stub (see FUNCTIONALITY.md §9): updates the
 *  recorded duration but doesn't re-encode. Real impl: ffmpeg `-ss <start> -to <end> -c copy`. */
export function EditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: video, isLoading } = useVideo(id);
  const trimVideo = useTrimVideo();

  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  useEffect(() => {
    if (video) setEnd(video.durationSecs);
  }, [video]);

  if (isLoading) {
    return (
      <section className="panel">
        <h1>Edit</h1>
        <p className="muted">Loading…</p>
      </section>
    );
  }
  if (!video) {
    return (
      <section className="panel">
        <h1>Edit</h1>
        <p className="muted">Recording not found.</p>
      </section>
    );
  }

  async function applyTrim() {
    await trimVideo.mutateAsync({ id: video!.id, startSecs: start, endSecs: end });
  }

  return (
    <section className="panel editor">
      <h1>Edit</h1>
      <p className="muted">Trim the start and end. File: {video.filePath}</p>

      <div className="timeline">
        <div
          className="timeline-selection"
          style={{
            left: `${(start / video.durationSecs) * 100}%`,
            right: `${100 - (end / video.durationSecs) * 100}%`,
          }}
        />
      </div>

      <div className="trim-controls">
        <label>
          In {start.toFixed(1)}s
          <input
            type="range"
            min={0}
            max={video.durationSecs}
            step={0.1}
            value={start}
            onChange={(e) => setStart(Math.min(Number(e.target.value), end))}
          />
        </label>
        <label>
          Out {end.toFixed(1)}s
          <input
            type="range"
            min={0}
            max={video.durationSecs}
            step={0.1}
            value={end}
            onChange={(e) => setEnd(Math.max(Number(e.target.value), start))}
          />
        </label>
      </div>

      <div className="actions">
        <button onClick={applyTrim} disabled={trimVideo.isPending}>
          {trimVideo.isPending ? "Trimming…" : "Apply trim"}
        </button>
        <button className="primary" onClick={() => navigate(`/library/${video.id}/ai`)}>
          Next: Transcribe →
        </button>
      </div>

      {trimVideo.isError && <p className="error">{String(trimVideo.error)}</p>}
    </section>
  );
}
