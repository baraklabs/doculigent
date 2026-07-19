import { useEffect, useState } from "react";
import type { LlmCapability, LlmModelProfile, LlmProviderKind } from "@shared/types/models";
import type { WhisperModelSize, WhisperModelStatus } from "@shared/constants/whisperModels";
import { WHISPER_MODELS, DEFAULT_WHISPER_MODEL } from "@shared/constants/whisperModels";
import { AI_PROVIDERS } from "../providers/ai";
import { SettingsService } from "../services/settings/SettingsService";
import {
  useActiveLlmProfileId,
  useDeleteLlmProfile,
  useLlmProfiles,
  useSaveLlmProfile,
  useSetActiveLlmProfile,
  useTestLlmConnection,
} from "../hooks/useLlmProfiles";

const SECTIONS = [
  { id: "models", label: "Model Config" },
  { id: "transcription", label: "Transcription" },
] as const;

function providerLabel(kind: LlmProviderKind): string {
  return AI_PROVIDERS.find((p) => p.kind === kind)?.label ?? kind;
}

interface ModelFormProps {
  initial: LlmModelProfile;
  isNew: boolean;
  onCancel: () => void;
  onSaved: () => void;
}

/** Add/edit form for one saved model profile. Kind is only changeable while adding (it
 *  drives the baseUrl/model defaults); editing an existing profile keeps its kind fixed
 *  so switching providers doesn't silently clobber a hand-tuned baseUrl. */
function ModelForm({ initial, isNew, onCancel, onSaved }: ModelFormProps) {
  const [profile, setProfile] = useState<LlmModelProfile>(initial);
  const [apiKey, setApiKey] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const saveProfile = useSaveLlmProfile();
  const testConnection = useTestLlmConnection();

  async function pickKind(kind: LlmProviderKind) {
    const template = await SettingsService.defaultProfileTemplate(kind);
    setProfile({ ...template, id: profile.id, name: providerLabel(kind) });
    setTestResult(null);
  }

  function toggleCapability(capability: LlmCapability) {
    const has = profile.capabilities.includes(capability);
    // Every profile needs at least one capability — a custom endpoint with neither
    // checked couldn't be used anywhere, so the last box can't be unchecked.
    if (has && profile.capabilities.length === 1) return;
    setProfile({
      ...profile,
      capabilities: has ? profile.capabilities.filter((c) => c !== capability) : [...profile.capabilities, capability],
    });
  }

  async function handleTest() {
    setTestResult(null);
    const result = await testConnection.mutateAsync({ profile, apiKey: apiKey || undefined });
    setTestResult(result);
  }

  async function handleSave() {
    await saveProfile.mutateAsync({ profile, apiKey: apiKey || undefined });
    onSaved();
  }

  return (
    <div className="model-form">
      {isNew ? (
        <label className="field">
          <span>Provider</span>
          <select value={profile.kind} onChange={(e) => pickKind(e.target.value as LlmProviderKind)}>
            {AI_PROVIDERS.map((p) => (
              <option key={p.kind} value={p.kind}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="muted">{providerLabel(profile.kind)}</p>
      )}

      <label className="field">
        <span>Title</span>
        <input value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} />
        <small className="field-hint">
          A name you'll recognize — handy since different providers can use the same model identifier.
        </small>
      </label>

      <label className="field">
        <span>Base URL</span>
        <input value={profile.baseUrl} onChange={(e) => setProfile({ ...profile, baseUrl: e.target.value })} />
      </label>

      <label className="field">
        <span>Model identifier</span>
        <input
          value={profile.model}
          placeholder="e.g. openai/gpt-4o-mini"
          onChange={(e) => setProfile({ ...profile, model: e.target.value })}
        />
      </label>

      {profile.needsKey && (
        <label className="field">
          <span>
            API key <span className="field-hint-inline">— stored in your OS keychain</span>
          </span>
          <input
            type="password"
            value={apiKey}
            placeholder={isNew ? "sk-…" : "Leave blank to keep the saved key"}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
      )}

      {profile.kind === "custom" && (
        <div className="field">
          <span>Capabilities</span>
          <div className="capability-checkboxes">
            <label>
              <input
                type="checkbox"
                checked={profile.capabilities.includes("chat")}
                onChange={() => toggleCapability("chat")}
              />
              Chat / summaries
            </label>
            <label>
              <input
                type="checkbox"
                checked={profile.capabilities.includes("transcribe")}
                onChange={() => toggleCapability("transcribe")}
              />
              Transcription
            </label>
          </div>
          <small className="field-hint">
            What this endpoint actually supports — unlike the built-in providers, a custom endpoint could be
            either. Only "Chat / summaries" profiles can be set as the active model below; transcription-capable
            custom profiles aren't wired into the Transcription tab yet.
          </small>
        </div>
      )}

      <div className="actions">
        <button type="button" onClick={handleTest} disabled={testConnection.isPending}>
          {testConnection.isPending ? "Testing…" : "Test connection"}
        </button>
        <button type="button" className="primary" onClick={handleSave} disabled={saveProfile.isPending || !profile.name.trim()}>
          {saveProfile.isPending ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>

      {testResult && <p className={testResult.ok ? "muted" : "error"}>{testResult.ok ? "✓ " : "✗ "}{testResult.message}</p>}
    </div>
  );
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

/** Lets the user pick which local Whisper model size (tiny/base/small) transcription
 *  runs with — see shared/constants/whisperModels.ts for the size/accuracy/speed/hardware
 *  tradeoff and electron/main/transcription/whisper.ts for how a change here takes effect
 *  on the next transcription call (no restart needed) — and manage which sizes' files are
 *  actually downloaded (see electron/main/transcription/modelCache.ts). */
function TranscriptionSettings() {
  const [model, setModel] = useState<WhisperModelSize>(DEFAULT_WHISPER_MODEL);
  const [statuses, setStatuses] = useState<WhisperModelStatus[] | null>(null);
  const [cacheDir, setCacheDir] = useState("");
  const [loading, setLoading] = useState(true);
  const [busySize, setBusySize] = useState<WhisperModelSize | null>(null);

  function refreshStatuses() {
    return SettingsService.getWhisperModelStatuses().then(setStatuses);
  }

  useEffect(() => {
    Promise.all([SettingsService.getWhisperModel().then(setModel), refreshStatuses(), SettingsService.getWhisperModelsDir().then(setCacheDir)]).finally(
      () => setLoading(false)
    );
  }, []);

  async function handleChange(size: WhisperModelSize) {
    setModel(size);
    await SettingsService.setWhisperModel(size);
  }

  async function handleDownload(size: WhisperModelSize) {
    setBusySize(size);
    try {
      await SettingsService.downloadWhisperModel(size);
      await refreshStatuses();
    } finally {
      setBusySize(null);
    }
  }

  async function handleDelete(size: WhisperModelSize) {
    setBusySize(size);
    try {
      await SettingsService.deleteWhisperModel(size);
      await refreshStatuses();
    } finally {
      setBusySize(null);
    }
  }

  const selected = WHISPER_MODELS.find((m) => m.size === model);
  const statusFor = (size: WhisperModelSize) => statuses?.find((s) => s.size === size);

  return (
    <>
      <h1>Transcription</h1>
      <p className="muted">
        Which local Whisper model size to use for transcription (Meeting tab live captions, and the Library/AI
        Assistant tabs' full-recording transcripts). Bigger models are more accurate — especially for non-English
        languages — but take longer to download once and to transcribe each chunk.
      </p>

      {loading ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="field">
          <span>Model size</span>
          <div className="model-size-options">
            {WHISPER_MODELS.map((m) => {
              const status = statusFor(m.size);
              const active = model === m.size;
              const busy = busySize === m.size;
              return (
                <div key={m.size} className={`model-size-card${active ? " active" : ""}`}>
                  <button type="button" className="model-size-card-main" onClick={() => handleChange(m.size)}>
                    <span className="model-size-card-label">
                      {m.label}
                      {active && <span className="badge">Active</span>}
                    </span>
                    <span className="model-size-card-status">
                      {status?.downloaded ? `Downloaded · ${formatMb(status.sizeBytes)}` : `Not downloaded · ~${m.approxDownloadMb}MB`}
                    </span>
                  </button>
                  {status?.downloaded ? (
                    <button
                      type="button"
                      className="model-size-card-action remove"
                      onClick={() => handleDelete(m.size)}
                      disabled={busy}
                    >
                      {busy ? "Removing…" : "Remove"}
                    </button>
                  ) : (
                    <button type="button" className="model-size-card-action" onClick={() => handleDownload(m.size)} disabled={busy}>
                      {busy ? "Downloading…" : "Download"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <small className="field-hint">
            {selected?.description} {selected?.recommendedFor}
          </small>
          <small className="field-hint">
            Stored in {cacheDir || "…"} —{" "}
            <button type="button" className="link-btn" onClick={() => SettingsService.openWhisperModelsDir()}>
              open folder
            </button>
          </small>
        </div>
      )}
    </>
  );
}

export function SettingsPage() {
  const [section, setSection] = useState<(typeof SECTIONS)[number]["id"]>("models");
  const { data: profiles = [], isLoading } = useLlmProfiles();
  const { data: activeId } = useActiveLlmProfileId();
  const [editing, setEditing] = useState<{ profile: LlmModelProfile; isNew: boolean } | null>(null);
  const deleteProfile = useDeleteLlmProfile();
  const setActive = useSetActiveLlmProfile();

  async function startAdd() {
    const template = await SettingsService.defaultProfileTemplate("ollama");
    setEditing({ profile: { ...template, name: providerLabel("ollama") }, isNew: true });
  }

  return (
    <div className="settings-layout">
      <nav className="settings-nav">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={s.id === section ? "settings-nav-item active" : "settings-nav-item"}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>

      <section className="panel settings-content">
        {section === "transcription" ? (
          <TranscriptionSettings />
        ) : (
          <>
            <h1>Model Config</h1>
            <p className="muted">
              AI models available for summaries, chat, and the AI Assistant tab — run locally (Ollama, LM Studio) or
              BYOK (OpenAI, OpenRouter, Anthropic, custom).
            </p>

            {isLoading && <p className="muted">Loading…</p>}

            {!editing && (
              <>
                <div className="model-list">
                  {profiles.map((p) => {
                    const canChat = p.capabilities.includes("chat");
                    return (
                    <div key={p.id} className="model-row">
                      <div className="model-row-info">
                        <h3>
                          {p.name} {p.id === activeId && <span className="badge">Active</span>}
                        </h3>
                        <p className="muted sub">
                          {providerLabel(p.kind)} · {p.model || "no model set"}
                          {p.kind === "custom" && ` · ${p.capabilities.map((c) => (c === "chat" ? "Chat" : "Transcription")).join(" + ")}`}
                        </p>
                      </div>
                      <div className="actions">
                        {p.id !== activeId && canChat && (
                          <button type="button" onClick={() => setActive.mutate(p.id)} disabled={setActive.isPending}>
                            Use this model
                          </button>
                        )}
                        {p.id !== activeId && !canChat && (
                          <span className="muted field-hint-inline" title="This profile isn't tagged for chat/summaries, so it can't be the active model">
                            Not chat-capable
                          </span>
                        )}
                        <button type="button" onClick={() => setEditing({ profile: p, isNew: false })}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="danger"
                          onClick={() => deleteProfile.mutate(p.id)}
                          disabled={deleteProfile.isPending}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    );
                  })}
                  {!isLoading && profiles.length === 0 && <p className="muted">No models configured yet.</p>}
                </div>

                <div className="actions">
                  <button type="button" className="primary" onClick={startAdd}>
                    + Add model
                  </button>
                </div>
              </>
            )}

            {editing && (
              <ModelForm
                initial={editing.profile}
                isNew={editing.isNew}
                onCancel={() => setEditing(null)}
                onSaved={() => setEditing(null)}
              />
            )}
          </>
        )}
      </section>
    </div>
  );
}
