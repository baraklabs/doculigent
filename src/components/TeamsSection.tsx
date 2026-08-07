import { useEffect, useState, type ChangeEvent, type DragEvent, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Cloud, Loader2, LogIn, Plus, Trash2, Upload, UserPlus, Users } from "lucide-react";
import type { TeamFile, TeamMember } from "@shared/types/team";
import { planLabel, teamLimitForTier } from "@shared/constants/plans";
import {
  teamErrorCode,
  teamErrorMessage,
  teamErrorStatus,
  useCreateTeam,
  useDeleteTeam,
  useDeleteTeamFile,
  useInviteMember,
  useRemoveMember,
  useSyncedTeamFileIds,
  useTeam,
  useTeamFiles,
  useTeams,
  useUploadTeamFile,
} from "../hooks/useTeams";
import { TeamsService } from "../services/teams/TeamsService";
import { useAuthStore } from "../store/authStore";
import { useToast } from "../hooks/useToast";
import { useStoragePreference } from "../hooks/useStorage";
import { LocalStorageTeamView } from "./LocalStorageTeamView";
import "./TeamsSection.css";

const MEDIA_EXTENSIONS = new Set([
  "mp4", "mov", "mkv", "avi", "webm", "m4v", "wmv", "flv",
  "mp3", "wav", "m4a", "aac", "flac", "ogg", "wma",
]);

function isMediaFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase();
  return !!ext && MEDIA_EXTENSIONS.has(ext);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function TeamsSection() {
  const navigate = useNavigate();
  const session = useAuthStore((s) => s.session);
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const { data: storagePreference, isLoading: storagePreferenceLoading } = useStoragePreference();

  if (storagePreferenceLoading) {
    return (
      <div className="shared-empty">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (storagePreference && storagePreference.provider !== "doculigent") {
    return <LocalStorageTeamView />;
  }

  if (!session) {
    return (
      <div className="shared-empty">
        <Users size={26} className="shared-empty-icon" />
        <h2>Sign in to collaborate</h2>
        <p className="muted">Sign in with doculigent.com to create teams and share files with colleagues.</p>
        <div className="actions shared-empty-actions">
          <button type="button" className="primary" onClick={() => navigate("/account")}>
            <LogIn size={14} /> Go to Account
          </button>
        </div>

        <div className="shared-empty-divider">
          <span>or</span>
        </div>

        <p className="muted sub">Prefer your own storage?</p>
        <div className="actions shared-empty-actions">
          <button type="button" onClick={() => navigate("/settings?section=storage")}>
            <Cloud size={14} /> Set up bring-your-own S3
          </button>
        </div>
      </div>
    );
  }

  return selectedTeamId ? (
    <TeamDetail teamId={selectedTeamId} onBack={() => setSelectedTeamId(null)} />
  ) : (
    <TeamList onSelect={setSelectedTeamId} />
  );
}

function TeamList({ onSelect }: { onSelect: (teamId: string) => void }) {
  const { data: teams = [], isLoading } = useTeams();
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="teams-list-view">
      <div className="teams-list-view-head">
        <p className="muted">Teams you own or belong to.</p>
        <button type="button" className="primary" onClick={() => setShowCreate(true)}>
          <Plus size={14} /> Create team
        </button>
      </div>

      {isLoading && <p className="muted">Loading…</p>}
      {!isLoading && teams.length === 0 && <p className="muted">You're not on any teams yet.</p>}

      <div className="teams-grid">
        {teams.map((t) => (
          <button key={t.id} type="button" className="team-card" onClick={() => onSelect(t.id)}>
            <h3>{t.name}</h3>
            <div className="team-card-meta">
              <span className="muted">
                <Users size={12} /> {t.memberCount} member{t.memberCount === 1 ? "" : "s"}
              </span>
              <span className={t.isOwner ? "badge locality-badge cloud" : "badge cap-badge cap-chat"}>
                {t.isOwner ? "Owner" : "Member"}
              </span>
            </div>
          </button>
        ))}
      </div>

      {showCreate && <CreateTeamModal onClose={() => setShowCreate(false)} onCreated={onSelect} />}
    </div>
  );
}

function CreateTeamModal({ onClose, onCreated }: { onClose: () => void; onCreated: (teamId: string) => void }) {
  const session = useAuthStore((s) => s.session);
  const createTeam = useCreateTeam();
  const [name, setName] = useState("");
  const [limitReached, setLimitReached] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const planTier = session?.user.plan?.tier ?? "free";
  const teamLimit = teamLimitForTier(planTier);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    try {
      const team = await createTeam.mutateAsync(trimmed);
      onCreated(team.id);
    } catch (err) {
      if (teamErrorCode(err) === "team_limit_reached") setLimitReached(true);
      else setError(teamErrorMessage(err));
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Create a team</h2>

        {limitReached ? (
          <>
            <p className="muted">
              The {planLabel(planTier)} plan is capped at {teamLimit} team{teamLimit === 1 ? "" : "s"}. Upgrade to
              create more.
            </p>
            <div className="actions modal-actions">
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="primary cta-highlight"
                onClick={() => window.open("https://doculigent.com/pricing", "_blank")}
              >
                Upgrade
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="field">
              <span>Team name</span>
              <input
                autoFocus
                type="text"
                value={name}
                maxLength={150}
                placeholder="e.g. Marketing"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            {error && <p className="error">{error}</p>}
            <div className="actions modal-actions">
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={!name.trim() || createTeam.isPending}>
                {createTeam.isPending ? "Creating…" : "Create"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function AddMemberModal({ teamId, onClose }: { teamId: string; onClose: () => void }) {
  const inviteMember = useInviteMember(teamId);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    setError(null);
    try {
      await inviteMember.mutateAsync(trimmed);
      onClose();
    } catch (err) {
      setError(teamErrorMessage(err));
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add a member</h2>
        <form onSubmit={handleSubmit}>
          <div className="field">
            <span>Email</span>
            <input
              autoFocus
              type="text"
              value={email}
              placeholder="teammate@example.com"
              onChange={(e) => setEmail(e.target.value)}
            />
            <small className="field-hint">
              If they don't have a doculigent.com account yet, they'll be added automatically once they sign up.
            </small>
          </div>
          {error && <p className="error">{error}</p>}
          <div className="actions modal-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={!email.trim() || inviteMember.isPending}>
              {inviteMember.isPending ? "Adding…" : "Add"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface ConfirmModalProps {
  title: string;
  message: string;
  confirmLabel: string;
  pending?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

function ConfirmModal({ title, message, confirmLabel, pending, onConfirm, onClose }: ConfirmModalProps) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <p className="muted">{message}</p>
        <div className="actions modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="danger" onClick={onConfirm} disabled={pending}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}


function useTeamFileSync(teamId: string, files: TeamFile[] | undefined): Set<string> {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: syncedFileIds = [] } = useSyncedTeamFileIds();
  const syncedIds = new Set(syncedFileIds);

  useEffect(() => {
    if (!files) return;
    for (const file of files) {
      if (syncedIds.has(file.id)) continue;
      TeamsService.downloadToLibrary(teamId, file.id)
        .then(() => queryClient.invalidateQueries({ queryKey: ["teamSyncedFileIds"] }))
        .catch((err) => {
          if (teamErrorStatus(err) === 404 || /not found/i.test(teamErrorMessage(err))) return;
          toast.error(teamErrorMessage(err), { title: `Couldn't sync "${file.name}"` });
        });
    }
  }, [files, syncedFileIds]);

  return syncedIds;
}

function TeamDetail({ teamId, onBack }: { teamId: string; onBack: () => void }) {
  const toast = useToast();
  const { data, isLoading, error } = useTeam(teamId);
  const deleteTeam = useDeleteTeam();
  const { data: files, isLoading: filesLoading } = useTeamFiles(teamId, "active");

  const [showAddMember, setShowAddMember] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<TeamMember | null>(null);
  const [confirmDeleteTeam, setConfirmDeleteTeam] = useState(false);
  const [deleteFileTarget, setDeleteFileTarget] = useState<TeamFile | null>(null);

  const removeMember = useRemoveMember(teamId);
  const uploadFile = useUploadTeamFile(teamId);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  useEffect(() => TeamsService.onUploadProgress(({ percent }) => setUploadPercent(percent)), []);

  const deleteFile = useDeleteTeamFile(teamId);
  const syncedIds = useTeamFileSync(teamId, files);

  const [dragActive, setDragActive] = useState(false);

  if (isLoading) {
    return (
      <div className="teams-detail-col">
        <BackButton onBack={onBack} />
        <p className="muted">Loading…</p>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="teams-detail-col">
        <BackButton onBack={onBack} />
        <p className="error">{teamErrorMessage(error) || "Couldn't load this team."}</p>
      </div>
    );
  }

  const { team, members } = data;

  async function uploadPath(filePath: string, displayName?: string): Promise<boolean> {
    setUploadPercent(0);
    try {
      await uploadFile.mutateAsync({ filePath, displayName });
      return true;
    } catch (err) {
      const code = teamErrorCode(err);
      toast.error(
        code === "quota_exceeded" || teamErrorMessage(err).toLowerCase().includes("quota")
          ? "This upload would exceed your storage quota."
          : teamErrorMessage(err),
        { title: `Couldn't upload "${displayName ?? filePath}"` }
      );
      return false;
    } finally {
      setUploadPercent(null);
    }
  }

  async function uploadMany(filePaths: string[]) {
    let uploaded = 0;
    for (const filePath of filePaths) {
      if (await uploadPath(filePath)) uploaded++;
    }
    if (uploaded > 0) toast.success(`${uploaded} file${uploaded === 1 ? "" : "s"} uploaded`);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragActive(false);
    const dropped = Array.from(e.dataTransfer.files);
    const media = dropped.filter((f) => isMediaFile(f.name));
    if (media.length < dropped.length) {
      toast.warning("Only video and audio files can be uploaded — the rest were skipped.");
    }
    if (media.length === 0) return;
    void uploadMany(media.map((f) => window.api.system.getPathForFile(f)));
  }

  function handleFileInputChange(e: ChangeEvent<HTMLInputElement>) {
    const chosen = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (chosen.length === 0) return;
    void uploadMany(chosen.map((f) => window.api.system.getPathForFile(f)));
  }

  async function confirmDeleteFile() {
    if (!deleteFileTarget) return;
    try {
      await deleteFile.mutateAsync({ fileId: deleteFileTarget.id, alreadyTrashed: false });
      setDeleteFileTarget(null);
    } catch (err) {
      toast.error(teamErrorMessage(err), { title: "Couldn't delete file" });
    }
  }

  async function confirmRemoveMember() {
    if (!removeTarget) return;
    try {
      await removeMember.mutateAsync(removeTarget.id);
      setRemoveTarget(null);
    } catch (err) {
      toast.error(teamErrorMessage(err), { title: "Couldn't remove member" });
    }
  }

  async function confirmDeleteTeamAction() {
    try {
      await deleteTeam.mutateAsync(team.id);
      onBack();
    } catch (err) {
      toast.error(teamErrorMessage(err), { title: "Couldn't delete team" });
      setConfirmDeleteTeam(false);
    }
  }

  return (
    <div className="teams-detail-col">
      <BackButton onBack={onBack} />

      <div className="teams-detail-header">
        <h2>{team.name}</h2>
        {team.isOwner && (
          <button type="button" className="danger" onClick={() => setConfirmDeleteTeam(true)}>
            <Trash2 size={14} /> Delete team
          </button>
        )}
      </div>

      <div className="field">
        <span>Members ({members.length})</span>
        <div className="model-list">
          {members.map((m) => (
            <div key={m.id} className="model-row">
              <div className="model-row-info">
                <h3>
                  {m.email} {m.isOwner && <span className="badge locality-badge cloud">Owner</span>}
                  {m.status === "pending" && <span className="badge cap-badge cap-chat">Pending</span>}
                </h3>
              </div>
              {!m.isOwner && (
                <div className="actions">
                  <button type="button" className="danger" onClick={() => setRemoveTarget(m)}>
                    Remove
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        {team.isOwner && (
          <div className="actions" style={{ marginTop: 8 }}>
            <button type="button" onClick={() => setShowAddMember(true)}>
              <UserPlus size={14} /> Add member
            </button>
          </div>
        )}
      </div>

      <div className="field">
        <span>Files</span>

        <div
          className={dragActive ? "teams-dropzone drag-active" : "teams-dropzone"}
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={handleDrop}
        >
          <Upload size={20} />
          <p>Drag video or audio files here, or click to browse</p>
          <input
            type="file"
            multiple
            accept="video/*,audio/*"
            className="teams-dropzone-input"
            onChange={handleFileInputChange}
          />
        </div>

        {uploadPercent !== null && (
          <div className="progress">
            <div className="progress-fill" style={{ width: `${uploadPercent}%` }} />
          </div>
        )}

        {filesLoading && <p className="muted">Loading…</p>}
        {!filesLoading && (files ?? []).length === 0 && <p className="muted">No files here.</p>}

        <div className="model-list">
          {(files ?? []).map((f) => (
            <div key={f.id} className="model-row">
              <div className="model-row-info">
                <h3>{f.name}</h3>
                <p className="muted sub">
                  {formatBytes(f.sizeBytes)} · {f.mimeType ?? "unknown type"}
                </p>
              </div>
              <div className="actions">
                {syncedIds.has(f.id) ? (
                  <span className="sync-status synced">
                    <Check size={14} /> Synced
                  </span>
                ) : (
                  <span className="sync-status syncing">
                    <Loader2 size={14} className="spin" /> Syncing…
                  </span>
                )}
                <button type="button" className="danger" onClick={() => setDeleteFileTarget(f)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {showAddMember && <AddMemberModal teamId={teamId} onClose={() => setShowAddMember(false)} />}

      {removeTarget && (
        <ConfirmModal
          title={`Remove ${removeTarget.email}?`}
          message="They'll lose access to every file in this team."
          confirmLabel={removeMember.isPending ? "Removing…" : "Remove"}
          pending={removeMember.isPending}
          onConfirm={confirmRemoveMember}
          onClose={() => setRemoveTarget(null)}
        />
      )}

      {confirmDeleteTeam && (
        <ConfirmModal
          title={`Delete "${team.name}"?`}
          message="This permanently deletes every file this team owns. This can't be undone."
          confirmLabel={deleteTeam.isPending ? "Deleting…" : "Delete team"}
          pending={deleteTeam.isPending}
          onConfirm={confirmDeleteTeamAction}
          onClose={() => setConfirmDeleteTeam(false)}
        />
      )}

      {deleteFileTarget && (
        <ConfirmModal
          title={`Delete "${deleteFileTarget.name}"?`}
          message="This removes it from the team and deletes the synced copy from your Library. This can't be undone."
          confirmLabel={deleteFile.isPending ? "Deleting…" : "Delete"}
          pending={deleteFile.isPending}
          onConfirm={confirmDeleteFile}
          onClose={() => setDeleteFileTarget(null)}
        />
      )}
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" className="teams-back-btn" onClick={onBack}>
      <ArrowLeft size={14} /> All teams
    </button>
  );
}
