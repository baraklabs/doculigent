import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { AppWindow, Cloud, Cpu, Download, PanelLeftClose, PanelLeftOpen, SlidersHorizontal } from "lucide-react";
import type {
  AppIntegration,
  AppIntegrationKind,
  AutoTranscribeSettings,
  LlmCapability,
  LlmModelProfile,
  LlmProviderKind,
} from "@shared/types/models";
import type { WhisperModelSize, WhisperModelStatus } from "@shared/constants/whisperModels";
import { WHISPER_MODELS } from "@shared/constants/whisperModels";
import { isBilledTier } from "@shared/constants/plans";
import { AI_PROVIDERS, LOCAL_LLM_PROVIDERS } from "../providers/ai";
import { APP_PROVIDERS, appProviderMeta } from "../providers/apps";
import { SettingsService } from "../services/settings/SettingsService";
import { useAuthStore } from "../store/authStore";
import { useDeleteLlmProfile, useLlmProfiles, useSaveLlmProfile, useTestLlmConnection } from "../hooks/useLlmProfiles";
import {
  useAppIntegrations,
  useDeleteAppIntegration,
  useSaveAppIntegration,
  useTestAppConnection,
} from "../hooks/useAppIntegrations";
import { useAutoTranscribeSettings, useSetAutoTranscribeSettings } from "../hooks/useAutoTranscribeSettings";
import { StorageSection } from "./settings/StorageSection";
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

interface AppIntegrationFormProps {
  kind: AppIntegrationKind;
  initial: AppIntegration | null;
  onCancel: () => void;
  onSaved: () => void;
}

function AppIntegrationForm({ kind, initial, onCancel, onSaved }: AppIntegrationFormProps) {
  const meta = appProviderMeta(kind);
  const isNew = !initial;
  const [name, setName] = useState(initial?.name ?? meta.label);
  const [secret, setSecret] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const saveIntegration = useSaveAppIntegration();
  const testConnection = useTestAppConnection();

  async function handleTest() {
    setTestResult(null);
    const result = await testConnection.mutateAsync({
      kind,
      integrationId: initial?.id ?? null,
      secret: secret || undefined,
    });
    setTestResult(result);
  }

  async function handleSave() {
    const integration: AppIntegration = { id: initial?.id ?? crypto.randomUUID(), kind, name: name.trim() };
    await saveIntegration.mutateAsync({ integration, secret: secret || undefined });
    onSaved();
  }

  return (
    <div className="model-form">
      <p className="muted app-form-kind">
        <span
          className={meta.multicolor ? "app-icon multicolor" : "app-icon"}
          style={meta.multicolor ? undefined : { background: meta.accent }}
        >
          {meta.icon}
        </span>
        {meta.label}
      </p>

      <label className="field">
        <span>Title</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
        <small className="field-hint">
          A name you'll recognize — handy if you connect more than one {meta.label} account.
        </small>
      </label>

      <label className="field">
        <span>
          {meta.secretLabel} <span className="field-hint-inline">— stored in your OS keychain</span>
        </span>
        <input
          type="password"
          value={secret}
          placeholder={isNew ? meta.secretPlaceholder : "Leave blank to keep the saved value"}
          onChange={(e) => setSecret(e.target.value)}
        />
        <small className="field-hint">{meta.testHint}</small>
      </label>

      <div className="actions">
        <button type="button" onClick={handleTest} disabled={testConnection.isPending || (isNew && !secret)}>
          {testConnection.isPending ? "Testing…" : "Test connection"}
        </button>
        <button
          type="button"
          className="primary"
          onClick={handleSave}
          disabled={saveIntegration.isPending || !name.trim() || (isNew && !secret)}
        >
          {saveIntegration.isPending ? "Saving…" : "Save"}
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

function capabilityLabel(capabilities: LlmCapability[]): string {
  if (capabilities.includes("chat") && capabilities.includes("transcribe")) return "Multimodel";
  return capabilities.includes("chat") ? "AI summary" : "Transcription";
}

function capabilityBadgeClass(capabilities: LlmCapability[]): string {
  if (capabilities.includes("chat") && capabilities.includes("transcribe")) return "cap-both";
  return capabilities.includes("chat") ? "cap-chat" : "cap-transcribe";
}

const LOCALHOST_RE = /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i;

function isLocalModel(kind: LlmProviderKind, baseUrl: string): boolean {
  return LOCAL_LLM_PROVIDERS.includes(kind) || LOCALHOST_RE.test(baseUrl.trim());
}

function useWhisperModels() {
  const [statuses, setStatuses] = useState<WhisperModelStatus[] | null>(null);
  const [cacheDir, setCacheDir] = useState("");
  const [loading, setLoading] = useState(true);
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

  function forceStatus(size: WhisperModelSize, downloaded: boolean) {
    setStatuses((prev) => {
      const base = prev ?? WHISPER_MODELS.map((m) => ({ size: m.size, downloaded: false, sizeBytes: 0, downloading: false }));
      return base.map((s) => (s.size === size ? { ...s, downloaded, sizeBytes: downloaded ? s.sizeBytes : 0 } : s));
    });
  }

  useEffect(() => {
    Promise.all([refreshStatuses(), SettingsService.getWhisperModelsDir().then(setCacheDir)]).finally(() => setLoading(false));
  }, []);

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
    const downloading = downloadingLocally.has(m.size) || (status?.downloading ?? false);
    const removing = removingLocally.has(m.size);
    const reallyDownloaded = !downloading && (status?.downloaded ?? false);
    return { m, status, downloading, removing, reallyDownloaded };
  });

  return { loading, cacheDir, entries, handleDownload, handleDelete };
}

const SECTIONS = [
  { id: "models", label: "Models", icon: <Cpu size={16} /> },
  { id: "apps", label: "Apps", icon: <AppWindow size={16} /> },
  { id: "storage", label: "Storage", icon: <Cloud size={16} /> },
  { id: "preferences", label: "Preferences", icon: <SlidersHorizontal size={16} /> },
] as const;
type SettingsSectionId = (typeof SECTIONS)[number]["id"];
const SECTION_IDS = SECTIONS.map((s) => s.id) as string[];

interface PrefToggleProps {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

function PrefToggle({ label, hint, checked, onChange }: PrefToggleProps) {
  return (
    <button
      type="button"
      className={checked ? "pref-toggle on" : "pref-toggle"}
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
    >
      <span className="pref-toggle-text">
        <span className="pref-toggle-label">{label}</span>
        {hint && <span className="muted sub">{hint}</span>}
      </span>
      <span className="pref-toggle-switch" aria-hidden="true">
        <span className="pref-toggle-knob" />
      </span>
    </button>
  );
}

const NAV_COLLAPSED_KEY = "settings.navCollapsed";

export function SettingsPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [section, setSection] = useState<SettingsSectionId>(() => {
    const requested = searchParams.get("section");
    return requested && SECTION_IDS.includes(requested) ? (requested as SettingsSectionId) : "models";
  });
  const [navCollapsed, setNavCollapsed] = useState(() => localStorage.getItem(NAV_COLLAPSED_KEY) === "1");
  useEffect(() => {
    localStorage.setItem(NAV_COLLAPSED_KEY, navCollapsed ? "1" : "0");
  }, [navCollapsed]);
  const session = useAuthStore((s) => s.session);
  const authReady = useAuthStore((s) => s.ready);
  const isPaid = !!session?.user.plan && isBilledTier(session.user.plan.tier);

  const { data: profiles = [], isLoading } = useLlmProfiles();
  const [editing, setEditing] = useState<{ profile: LlmModelProfile; isNew: boolean } | null>(null);
  const [filter, setFilter] = useState<CapabilityFilter>("all");
  const deleteProfile = useDeleteLlmProfile();
  const whisper = useWhisperModels();
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

  const { data: integrations = [], isLoading: integrationsLoading } = useAppIntegrations();
  const deleteIntegration = useDeleteAppIntegration();
  const [addingKind, setAddingKind] = useState<AppIntegrationKind | null>(null);
  const [editingIntegration, setEditingIntegration] = useState<AppIntegration | null>(null);
  function closeIntegrationModal() {
    setAddingKind(null);
    setEditingIntegration(null);
  }

  const { data: autoTranscribe } = useAutoTranscribeSettings();
  const setAutoTranscribe = useSetAutoTranscribeSettings();

  function toggleAutoTranscribeAll(on: boolean) {
    const next: AutoTranscribeSettings = {
      all: on,
      recording: on,
      videoImport: on,
      audioImport: on,
      teamsContent: on,
    };
    setAutoTranscribe.mutate(next);
  }

  function toggleAutoTranscribeOne(key: keyof Omit<AutoTranscribeSettings, "all">, on: boolean) {
    if (!autoTranscribe) return;
    const next: AutoTranscribeSettings = { ...autoTranscribe, [key]: on };
    next.all = next.recording && next.videoImport && next.audioImport && next.teamsContent;
    setAutoTranscribe.mutate(next);
  }

  return (
    <div className="settings-layout">
      <nav className={navCollapsed ? "settings-nav collapsed" : "settings-nav"}>
        <button
          type="button"
          className="settings-nav-toggle"
          title={navCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => setNavCollapsed((c) => !c)}
        >
          {navCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={s.id === section ? "settings-nav-item active" : "settings-nav-item"}
            title={navCollapsed ? s.label : undefined}
            onClick={() => setSection(s.id)}
          >
            <span className="settings-nav-icon">{s.icon}</span>
            {!navCollapsed && s.label}
          </button>
        ))}
      </nav>

      {section === "apps" ? (
        <section className="panel settings-content">
          <p className="muted">
            Connect external apps so Doculigent can work with the tools your team already uses.
          </p>

          <div className="field">
            <span>Add an app</span>
            <div className="app-add-grid">
              {APP_PROVIDERS.map((p) => (
                <button key={p.kind} type="button" className="app-add-card" onClick={() => setAddingKind(p.kind)}>
                  <span
                    className={p.multicolor ? "app-icon multicolor" : "app-icon"}
                    style={p.multicolor ? undefined : { background: p.accent }}
                  >
                    {p.icon}
                  </span>
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span>Connected apps</span>

            {integrationsLoading && <p className="muted">Loading…</p>}

            <div className="model-list">
              {integrations.map((a) => {
                const meta = appProviderMeta(a.kind);
                return (
                  <div key={a.id} className="model-row">
                    <div className="model-row-info">
                      <h3>
                        <span
                          className={meta.multicolor ? "app-icon multicolor" : "app-icon"}
                          style={meta.multicolor ? undefined : { background: meta.accent }}
                        >
                          {meta.icon}
                        </span>
                        {a.name}
                      </h3>
                      <p className="muted sub">{meta.label}</p>
                    </div>
                    <div className="actions">
                      <button type="button" onClick={() => setEditingIntegration(a)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => deleteIntegration.mutate(a.id)}
                        disabled={deleteIntegration.isPending}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                );
              })}

              {!integrationsLoading && integrations.length === 0 && (
                <p className="muted">No apps connected yet.</p>
              )}
            </div>
          </div>
        </section>
      ) : section === "storage" ? (
        <StorageSection />
      ) : section === "preferences" ? (
        <section className="panel settings-content">
          <p className="muted">Choose what gets transcribed automatically, without tapping Transcribe by hand.</p>

          <div className="field">
            <span>Library</span>
            <div className="pref-toggle-list">
              <PrefToggle
                label="Auto-transcribe all"
                hint="Turns every option below on or off at once"
                checked={!!autoTranscribe?.all}
                onChange={toggleAutoTranscribeAll}
              />
              <PrefToggle
                label="Recordings"
                hint="Screen and meeting recordings, right after they finish saving"
                checked={!!autoTranscribe?.recording}
                onChange={(on) => toggleAutoTranscribeOne("recording", on)}
              />
              <PrefToggle
                label="Video import"
                hint="Video files imported into the Library"
                checked={!!autoTranscribe?.videoImport}
                onChange={(on) => toggleAutoTranscribeOne("videoImport", on)}
              />
              <PrefToggle
                label="Audio import"
                hint="Audio files imported into the Library"
                checked={!!autoTranscribe?.audioImport}
                onChange={(on) => toggleAutoTranscribeOne("audioImport", on)}
              />
              <PrefToggle
                label="Teams content"
                hint="Transcibe eveything once your team member uploads video/audio"
                checked={!!autoTranscribe?.teamsContent}
                onChange={(on) => toggleAutoTranscribeOne("teamsContent", on)}
              />
            </div>
          </div>
        </section>
      ) : (
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
      )}

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

      {(addingKind || editingIntegration) && (
        <div className="modal-backdrop" onClick={closeIntegrationModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>
              {editingIntegration
                ? `Edit ${appProviderMeta(editingIntegration.kind).label}`
                : `Add ${appProviderMeta(addingKind!).label}`}
            </h2>
            <AppIntegrationForm
              kind={editingIntegration?.kind ?? addingKind!}
              initial={editingIntegration}
              onCancel={closeIntegrationModal}
              onSaved={closeIntegrationModal}
            />
          </div>
        </div>
      )}
    </div>
  );
}
