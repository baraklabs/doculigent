import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import type { StorageProviderKind } from "@shared/types/storage";
import { useCreateStorageTeam, useDeleteStorageTeam, useStoragePreference, useStorageTeams } from "../hooks/useStorage";
import { StorageFileBrowser } from "./StorageFileBrowser";
import { useToast } from "../hooks/useToast";
import "./TeamsSection.css";

function storageLabel(provider: StorageProviderKind): string {
  return provider === "google_drive" ? "Google Drive" : "S3 bucket";
}

export function LocalStorageTeamView() {
  const { data: preference } = useStoragePreference();
  const provider = preference?.provider ?? "s3";
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);

  return selectedTeamId ? (
    <LocalStorageTeamDetail teamId={selectedTeamId} provider={provider} onBack={() => setSelectedTeamId(null)} />
  ) : (
    <LocalStorageTeamList provider={provider} onSelect={setSelectedTeamId} />
  );
}

function LocalStorageTeamList({
  provider,
  onSelect,
}: {
  provider: StorageProviderKind;
  onSelect: (teamId: string) => void;
}) {
  const { data: teams = [], isLoading } = useStorageTeams();
  const [showCreate, setShowCreate] = useState(false);

  return (
    <div className="teams-list-view">
      <div className="teams-list-view-head">
        <p className="muted">
          Teams here are folders in your own {storageLabel(provider)} —{" "}
          <Link to="/settings?section=storage">Settings &gt; Storage</Link>.
        </p>
        <button type="button" className="primary" onClick={() => setShowCreate(true)}>
          <Plus size={14} /> Create team
        </button>
      </div>

      {isLoading && <p className="muted">Loading…</p>}
      {!isLoading && teams.length === 0 && <p className="muted">No teams yet — create one to start uploading.</p>}

      <div className="teams-grid">
        {teams.map((t) => (
          <button key={t.id} type="button" className="team-card" onClick={() => onSelect(t.id)}>
            <h3>{t.name}</h3>
          </button>
        ))}
      </div>

      {showCreate && (
        <CreateStorageTeamModal
          provider={provider}
          onClose={() => setShowCreate(false)}
          onCreated={(teamId) => {
            setShowCreate(false);
            onSelect(teamId);
          }}
        />
      )}
    </div>
  );
}

function CreateStorageTeamModal({
  provider,
  onClose,
  onCreated,
}: {
  provider: StorageProviderKind;
  onClose: () => void;
  onCreated: (teamId: string) => void;
}) {
  const createTeam = useCreateStorageTeam();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setError(null);
    try {
      const team = await createTeam.mutateAsync(trimmed);
      onCreated(team.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Create a team</h2>
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
            <small className="field-hint">Creates a folder with this name in your {storageLabel(provider)}.</small>
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
      </div>
    </div>
  );
}

function LocalStorageTeamDetail({
  teamId,
  provider,
  onBack,
}: {
  teamId: string;
  provider: StorageProviderKind;
  onBack: () => void;
}) {
  const toast = useToast();
  const deleteTeam = useDeleteStorageTeam();
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function handleDelete() {
    try {
      await deleteTeam.mutateAsync(teamId);
      onBack();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err), { title: "Couldn't delete team" });
      setConfirmDelete(false);
    }
  }

  return (
    <div className="teams-detail-col">
      <button type="button" className="teams-back-btn" onClick={onBack}>
        <ArrowLeft size={14} /> All teams
      </button>

      <div className="teams-detail-header">
        <h2>{teamId}</h2>
        <button type="button" className="danger" onClick={() => setConfirmDelete(true)}>
          <Trash2 size={14} /> Delete team
        </button>
      </div>

      <p className="notice">
        Files upload straight to this folder in your own {storageLabel(provider)}. Team member invites aren't
        available with this storage option — switch back to Doculigent Cloud in{" "}
        <Link to="/settings?section=storage">Settings &gt; Storage</Link> to invite people.
      </p>

      <StorageFileBrowser teamId={teamId} />

      {confirmDelete && (
        <div className="modal-backdrop" onClick={() => setConfirmDelete(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Delete "{teamId}"?</h2>
            <p className="muted">
              This deletes the "{teamId}" folder and everything inside it from your {storageLabel(provider)}, and
              removes any synced copies from your Library. This can't be undone.
            </p>
            <div className="actions modal-actions">
              <button type="button" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button type="button" className="danger" onClick={handleDelete} disabled={deleteTeam.isPending}>
                {deleteTeam.isPending ? "Deleting…" : "Delete team"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
