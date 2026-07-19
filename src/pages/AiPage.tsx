import { useParams } from "react-router-dom";
import { useVideo } from "../hooks/useVideos";
import { AiWorkspace } from "../components/AiWorkspace";

/** Transcript+chat scoped to one video by route id — see AiWorkspace for the actual UI,
 *  shared with the AI Assistant tab (AiAssistantPage). */
export function AiPage() {
  const { id } = useParams<{ id: string }>();
  const { data: video } = useVideo(id);

  if (!video) {
    return (
      <section className="panel">
        <h1>Hey AI</h1>
        <p className="muted">Loading…</p>
      </section>
    );
  }

  return <AiWorkspace key={video.id} video={video} />;
}
