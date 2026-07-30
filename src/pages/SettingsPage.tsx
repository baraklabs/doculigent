import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Download } from "lucide-react";
import type { LlmCapability, LlmModelProfile, LlmProviderKind } from "@shared/types/models";
import type { WhisperModelSize, WhisperModelStatus } from "@shared/constants/whisperModels";
import { WHISPER_MODELS } from "@shared/constants/whisperModels";
import { isBilledTier } from "@shared/constants/plans";
import { AI_PROVIDERS, LOCAL_LLM_PROVIDERS } from "../providers/ai";
import { SettingsService } from "../services/settings/SettingsService";
import { useAuthStore } from "../store/authStore";
import { useDeleteLlmProfile, useLlmProfiles, useSaveLlmProfile, useTestLlmConnection } from "../hooks/useLlmProfiles";
import "./SettingsPage.css";

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
 *  so switching providers doesn't silently clobber a hand-tuned baseUrl. Every kind — not
 *  just "custom" — can be tagged for AI summary (chat/summaries), Transcription, or both,
 *  since the same OpenAI-compatible endpoint (built-in or BYOK) may serve either role. */
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
    // Every profile needs at least one capability — a model tagged for neither couldn't
    // be used anywhere, so the last box can't be unchecked.
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

      <div className="field">
        <span>Use for</span>
        <div className="capability-checkboxes">
          <label>
            <input
              type="checkbox"
              checked={profile.capabilities.includes("chat")}
              onChange={() => toggleCapability("chat")}
            />
            AI summary
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
          What this model is used for — AI summary powers chat/summaries/AI Assistant, Transcription powers the
          Meeting tab and Library. Check both for Multimodel if the endpoint supports it.
        </small>
      </div>

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

type CapabilityFilter = "all" | "chat" | "transcribe" | "both";

const CAPABILITY_FILTERS: { id: CapabilityFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "chat", label: "AI summary" },
  { id: "transcribe", label: "Transcription" },
  { id: "both", label: "Multimodel" },
];

function matchesFilter(capabilities: LlmCapability[], filter: CapabilityFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "chat":
      return capabilities.includes("chat");
    case "transcribe":
      return capabilities.includes("transcribe");
    case "both":
      return capabilities.includes("chat") && capabilities.includes("transcribe");
  }
}

/** Mirrors the filter chips' wording — something tagged for both capabilities reads as
 *  "Multimodel" rather than spelling out "AI summary + Transcription". */
function capabilityLabel(capabilities: LlmCapability[]): string {
  if (capabilities.includes("chat") && capabilities.includes("transcribe")) return "Multimodel";
  return capabilities.includes("chat") ? "AI summary" : "Transcription";
}

/** CSS suffix for the capability badge's color — kept alongside capabilityLabel so the
 *  wording and coloring can never drift out of sync with each other. */
function capabilityBadgeClass(capabilities: LlmCapability[]): string {
  if (capabilities.includes("chat") && capabilities.includes("transcribe")) return "cap-both";
  return capabilities.includes("chat") ? "cap-chat" : "cap-transcribe";
}

const LOCALHOST_RE = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i;

/** Ollama/LM Studio are always local; any other provider (including "custom"/BYOK) still
 *  counts as local if its base URL actually points at localhost — a self-hosted OpenAI-
 *  compatible server is just as "on this machine" as Ollama is, even though its `kind`
 *  can't say so. */
function isLocalModel(kind: LlmProviderKind, baseUrl: string): boolean {
  return LOCAL_LLM_PROVIDERS.includes(kind) || LOCALHOST_RE.test(baseUrl.trim());
}

/** Tracks which local Whisper model sizes (tiny/base/small) are downloaded — see
 *  shared/constants/whisperModels.ts for the size/accuracy/speed/hardware tradeoff and
 *  electron/main/transcription/modelCache.ts for how "downloaded" gets computed. Returns
 *  plain data/handlers rather than JSX so SettingsPage can render Whisper sizes as rows in
 *  the same filtered list as LLM profiles instead of a separate section.
 *
 *  Deliberately no "active" model here — which downloaded size actually transcribes is
 *  chosen from the Meeting tab instead (see MeetingPage.tsx's model picker), since that's
 *  where the accuracy/speed tradeoff actually matters moment to moment; this hook only ever
 *  adds/removes files from disk. */
function useWhisperModels() {
  const [statuses, setStatuses] = useState<WhisperModelStatus[] | null>(null);
  const [cacheDir, setCacheDir] = useState("");
  const [loading, setLoading] = useState(true);
  // Sets rather than single sizes — otherwise starting a second download/remove while the
  // first is still in flight overwrites the tracked size and the first row's button springs
  // back to its idle label even though that download/removal is still running. Kept
  // separate (rather than one generic "busy" set) because a download in progress writes its
  // files incrementally, so `status.downloaded` (any bytes on disk > 0) can flip true well
  // before the download actually finishes — without this split, that false-positive
  // "downloaded" pushed the row into its Remove-button branch while a download was still
  // running, showing "Removing…" for a download.
  const [downloadingLocally, setDownloadingLocally] = useState<ReadonlySet<WhisperModelSize>>(new Set());
  const [removingLocally, setRemovingLocally] = useState<ReadonlySet<WhisperModelSize>>(new Set());

  function setInSet(setter: typeof setDownloadingLocally, size: WhisperModelSize, on: boolean) {
    setter((prev) => {
      const next = new Set(prev);
      if (on) next.add(size);
      else next.delete(size);
      return next;
    });
  }

  function refreshStatuses() {
    return SettingsService.getWhisperModelStatuses().then(setStatuses);
  }

  // Forces one size's entry to a known value after an action we just confidently performed
  // ourselves (a download/delete call that resolved without throwing) — independent of
  // whatever refreshStatuses' disk re-read reports for it. That read can still come back
  // stale right after the action (a slower earlier statuses fetch settling after this one,
  // or the model cache's write not having fully landed on disk yet), which otherwise left
  // the button showing its pre-action label until something else (e.g. leaving and
  // returning to this tab) forced a fresh read.
  function forceStatus(size: WhisperModelSize, downloaded: boolean) {
    setStatuses((prev) => {
      const base = prev ?? WHISPER_MODELS.map((m) => ({ size: m.size, downloaded: false, sizeBytes: 0, downloading: false }));
      return base.map((s) => (s.size === size ? { ...s, downloaded, sizeBytes: downloaded ? s.sizeBytes : 0 } : s));
    });
  }

  useEffect(() => {
    Promise.all([refreshStatuses(), SettingsService.getWhisperModelsDir().then(setCacheDir)]).finally(() => setLoading(false));
  }, []);

  // `downloading` is tracked in the main process, not just by this hook's own
  // handleDownload — so a download kicked off before this instance mounted (e.g. the user
  // clicked Download, navigated away and back, remounting this component and losing its
  // local busySizes) still needs to show "Downloading…" and then flip to "Remove" once it
  // lands. Poll while any size is in flight; stop as soon as none are.
  useEffect(() => {
    if (!statuses?.some((s) => s.downloading)) return;
    const interval = setInterval(refreshStatuses, 1500);
    return () => clearInterval(interval);
  }, [statuses]);

  async function handleDownload(size: WhisperModelSize) {
    setInSet(setDownloadingLocally, size, true);
    try {
      await SettingsService.downloadWhisperModel(size);
      await refreshStatuses();
      forceStatus(size, true);
    } finally {
      setInSet(setDownloadingLocally, size, false);
    }
  }

  async function handleDelete(size: WhisperModelSize) {
    setInSet(setRemovingLocally, size, true);
    try {
      await SettingsService.deleteWhisperModel(size);
      await refreshStatuses();
      forceStatus(size, false);
    } finally {
      setInSet(setRemovingLocally, size, false);
    }
  }

  const statusFor = (size: WhisperModelSize) => statuses?.find((s) => s.size === size);

  const entries = WHISPER_MODELS.map((m) => {
    const status = statusFor(m.size);
    // downloadingLocally covers this hook's own in-flight click; status.downloading is the
    // main process's own truth, so a download started before this instance mounted still
    // shows correctly (see the polling effect above). Takes priority over status.downloaded
    // below — the model cache writes its files incrementally, so "any bytes on disk" can go
    // true well before the download is actually finished.
    const downloading = downloadingLocally.has(m.size) || (status?.downloading ?? false);
    const removing = removingLocally.has(m.size);
    const reallyDownloaded = !downloading && (status?.downloaded ?? false);
    return { m, status, downloading, removing, reallyDownloaded };
  });

  return { loading, cacheDir, entries, handleDownload, handleDelete };
}

const SECTIONS = [{ id: "models", label: "Models" }] as const;

export function SettingsPage() {
  const navigate = useNavigate();
  const session = useAuthStore((s) => s.session);
  const authReady = useAuthStore((s) => s.ready);
  const isPaid = !!session?.user.plan && isBilledTier(session.user.plan.tier);

  const { data: profiles = [], isLoading } = useLlmProfiles();
  const [editing, setEditing] = useState<{ profile: LlmModelProfile; isNew: boolean } | null>(null);
  const [filter, setFilter] = useState<CapabilityFilter>("all");
  const deleteProfile = useDeleteLlmProfile();
  const whisper = useWhisperModels();
  // Which not-yet-downloaded size's description/hardware recommendation is shown below the
  // "Available to download" grid — set by clicking a card's label, purely to preview its
  // tradeoffs before committing to the download (no other effect).
  const [previewedSize, setPreviewedSize] = useState<WhisperModelSize | null>(null);
  const previewedWhisper = previewedSize ? WHISPER_MODELS.find((m) => m.size === previewedSize) : null;

  async function startAdd() {
    const template = await SettingsService.defaultProfileTemplate("ollama");
    setEditing({ profile: { ...template, name: providerLabel("ollama") }, isNew: true });
  }

  const transcribeOnly: LlmCapability[] = ["transcribe"];
  const doculigentCapabilities: LlmCapability[] = ["chat", "transcribe"];
  const downloadedWhisper = whisper.entries.filter((e) => e.reallyDownloaded && matchesFilter(transcribeOnly, filter));
  const downloadableWhisper = whisper.entries.filter((e) => !e.reallyDownloaded && matchesFilter(transcribeOnly, filter));
  const doculigentVisible = matchesFilter(doculigentCapabilities, filter);
  const filteredProfiles = profiles.filter((p) => matchesFilter(p.capabilities, filter));

  const isLoadingAny = isLoading || whisper.loading;
  const readyCount = filteredProfiles.length + downloadedWhisper.length + (doculigentVisible ? 1 : 0);

  return (
    <div className="settings-layout">
      <nav className="settings-nav">
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" className="settings-nav-item active">
            {s.label}
          </button>
        ))}
      </nav>

      <section className="panel settings-content">
        <p className="muted">
          Models available across the app — run locally (Ollama, LM Studio, on-device Whisper) or bring your own key
          (OpenAI, OpenRouter, Anthropic, custom). Each one can power AI summary (chat/summaries/AI Assistant),
          transcription (Meeting tab, Library), or both (Multimodel).
        </p>

        <div className="field">
          <span>Model profiles</span>

          <div className="model-filter-row">
            <div className="model-filter">
              {CAPABILITY_FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={f.id === filter ? "filter-chip active" : "filter-chip"}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <button type="button" className="primary" onClick={startAdd}>
              + Add model
            </button>
          </div>

          {isLoadingAny && <p className="muted">Loading…</p>}

          <div className="model-list">
            {(() => {
              const profileRows = filteredProfiles.map((p) => {
                const local = isLocalModel(p.kind, p.baseUrl);
                return (
                  <div key={p.id} className="model-row">
                    <div className="model-row-info">
                      <h3>
                        {p.name}
                        <span className={`badge locality-badge ${local ? "local" : "cloud"}`}>{local ? "Local" : "Cloud"}</span>
                        <span className={`badge cap-badge ${capabilityBadgeClass(p.capabilities)}`}>
                          {capabilityLabel(p.capabilities)}
                        </span>
                      </h3>
                      <p className="muted sub">
                        {providerLabel(p.kind)} · {p.model || "no model set"}
                      </p>
                    </div>
                    <div className="actions">
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
              });

              const whisperRows = downloadedWhisper.map(({ m, status, removing }) => (
                <div key={m.size} className="model-row">
                  <div className="model-row-info">
                    <h3>
                      {m.label}
                      <span className="badge locality-badge local">Local</span>
                      <span className="badge cap-badge cap-transcribe">Transcription</span>
                      <span className="info-icon" title={`${m.description} ${m.recommendedFor}`}>
                        ⓘ
                      </span>
                    </h3>
                    <p className="muted sub">On-device Whisper · Downloaded · {formatMb(status!.sizeBytes)}</p>
                  </div>
                  <div className="actions">
                    <button type="button" className="danger" onClick={() => whisper.handleDelete(m.size)} disabled={removing}>
                      {removing ? "Removing…" : "Remove"}
                    </button>
                  </div>
                </div>
              ));

              // Doculigent is Doculigent's own upsell, not just another row — it's pinned
              // to the 3rd spot (rather than wherever it'd naturally fall after profiles
              // and downloaded Whisper sizes) and visually called out, so it stays a
              // consistent, prominent landmark in the list no matter how many profiles/
              // Whisper sizes the user has.
              const rows = [...profileRows, ...whisperRows];
              if (doculigentVisible) {
                rows.splice(
                  Math.min(2, rows.length),
                  0,
                  <div key="doculigent" className="model-row doculigent-row">
                    <div className="model-row-info">
                      <h3>
                        Doculigent Model
                        <span className="badge locality-badge cloud">Cloud</span>
                        <span className="badge cap-badge cap-both">Multimodel</span>
                      </h3>
                      <p className="muted sub">Doculigent Cloud · Improve Speed &amp; accuracy, AI summary + transcription</p>
                    </div>
                    <div className="actions">
                      {authReady &&
                        (!session ? (
                          <button type="button" className="primary cta-highlight" onClick={() => navigate("/account")}>
                            Sign in
                          </button>
                        ) : !isPaid ? (
                          <button
                            type="button"
                            className="primary cta-highlight"
                            onClick={() => window.open("https://doculigent.com/pricing", "_blank")}
                          >
                            Upgrade
                          </button>
                        ) : (
                          <span className="muted field-hint-inline">Enabled</span>
                        ))}
                    </div>
                  </div>
                );
              }

              return rows;
            })()}

            {!isLoadingAny && readyCount === 0 && (
              <p className="muted">
                {profiles.length === 0 ? "No models configured yet." : "No models match this filter."}
              </p>
            )}
          </div>

          {downloadableWhisper.length > 0 && (
            <>
              <div className="model-size-divider">Available to download</div>
              <div className="model-size-options">
                {downloadableWhisper.map(({ m, downloading }) => (
                  <div key={m.size} className={`model-size-card${previewedSize === m.size ? " previewed" : ""}`}>
                    <button type="button" className="model-size-card-main" onClick={() => setPreviewedSize(m.size)}>
                      <span className="model-size-card-label">{m.label}</span>
                      <span className="model-size-card-status">
                        {downloading ? "Downloading…" : `~${m.approxDownloadMb}MB`}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="model-size-card-action"
                      onClick={() => whisper.handleDownload(m.size)}
                      disabled={downloading}
                    >
                      <Download size={13} />
                      {downloading ? "Downloading…" : "Download"}
                    </button>
                  </div>
                ))}
              </div>

              {previewedWhisper && (
                <small className="field-hint">
                  {previewedWhisper.description} {previewedWhisper.recommendedFor}
                </small>
              )}
            </>
          )}

          {!whisper.loading && (
            <small className="field-hint">
              On-device models stored in {whisper.cacheDir || "…"} —{" "}
              <button type="button" className="link-btn" onClick={() => SettingsService.openWhisperModelsDir()}>
                open folder
              </button>
            </small>
          )}
        </div>
      </section>

      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{editing.isNew ? "Add model" : "Edit model"}</h2>
            <ModelForm
              initial={editing.profile}
              isNew={editing.isNew}
              onCancel={() => setEditing(null)}
              onSaved={() => setEditing(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
