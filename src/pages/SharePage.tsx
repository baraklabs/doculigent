import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useVideo } from "../hooks/useVideos";
import { teamErrorCode, teamErrorMessage, useTeams, useUploadTeamFile } from "../hooks/useTeams";
import { useStoragePreference } from "../hooks/useStorage";
import { ShareToStoragePanel } from "../components/ShareToStoragePanel";
import { TeamsService } from "../services/teams/TeamsService";
import { useAuthStore } from "../store/authStore";
import "./SharePage.css";

export function SharePage() {
  const { id } = useParams<{ id: string }>();
  const { data: video } = useVideo(id);
  const { data: storagePreference, isLoading: storagePreferenceLoading } = useStoragePreference();

  if (storagePreferenceLoading) {
    return (
      <section className="panel share">
        <h1>Share</h1>
        <p className="muted">Loading…</p>
      </section>
    );
  }

  if (storagePreference && storagePreference.provider !== "doculigent") {
    return (
      <section className="panel share">
        <h1>Share</h1>
        <ShareToStoragePanel video={video ? { filePath: video.filePath, title: video.title } : undefined} />
      </section>
    );
  }

  return <DoculigentTeamShare video={video ? { filePath: video.filePath, title: video.title } : undefined} />;
}

function DoculigentTeamShare({ video }: { video?: { filePath: string; title: string } }) {
  const session = useAuthStore((s) => s.session);
  const { data: teams = [], isLoading: teamsLoading } = useTeams(!!session);
  const [teamId, setTeamId] = useState<string>("");
  useEffect(() => {
    if (!teamId && teams.length > 0) setTeamId(teams[0].id);
  }, [teams, teamId]);

  const uploadFile = useUploadTeamFile(teamId);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  useEffect(() => TeamsService.onUploadProgress(({ percent }) => setUploadPercent(percent)), []);

  async function handleShare() {
    if (!video || !teamId) return;
    setResult(null);
    setUploadPercent(0);
    try {
      await uploadFile.mutateAsync({ filePath: video.filePath, displayName: video.title });
      setResult({ ok: true, message: `Sent to the selected team.` });
    } catch (err) {
      const code = teamErrorCode(err);
      setResult({
        ok: false,
        message:
          code === "quota_exceeded" || teamErrorMessage(err).toLowerCase().includes("quota")
            ? "This would exceed your storage quota."
            : teamErrorMessage(err),
      });
    } finally {
      setUploadPercent(null);
    }
  }

  if (!session) {
    return (
      <section className="panel share">
        <h1>Share</h1>
        <p className="notice">
          Sign in with doculigent.com to share recordings with a team — <Link to="/account">go to Account</Link>.
        </p>
      </section>
    );
  }

  return (
    <section className="panel share">
      <h1>Share</h1>
      {!teamsLoading && teams.length === 0 && (
        <p className="notice">
          You're not on any team yet — create one in Library &gt; Team, then come back here to share this recording.
        </p>
      )}

      {teams.length > 0 && (
        <>
          <p className="muted">Send "{video?.title ?? "this recording"}" to a team's file list.</p>
          <div className="field">
            <span>Team</span>
            <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>

          {uploadPercent !== null && (
            <div className="progress">
              <div className="progress-fill" style={{ width: `${uploadPercent}%` }} />
            </div>
          )}

          <div className="actions">
            <button
              type="button"
              className="primary"
              onClick={handleShare}
              disabled={!video || !teamId || uploadPercent !== null}
            >
              {uploadPercent !== null ? "Sending…" : "Send to team"}
            </button>
          </div>

          {result && <p className={result.ok ? "share-result" : "error"}>{result.message}</p>}
        </>
      )}
    </section>
  );
}
