import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Cloud, Database } from "lucide-react";
import type { GoogleDriveConfig, S3Config, StorageProviderKind, StoragePreference } from "@shared/types/storage";
import { useSetStoragePreference, useStoragePreference, useTestStoragePreference } from "../../hooks/useStorage";
import { useGoogleDriveSignIn, useGoogleDriveSignOut, useGoogleDriveStatus } from "../../hooks/useGoogleDrive";
import { useAuthStore } from "../../store/authStore";

function GoogleGMark() {
  return (
    <svg viewBox="0 0 48 48" width="1em" height="1em" style={{ display: "block" }}>
      <path
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
        fill="#4285F4"
      />
      <path
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
        fill="#34A853"
      />
      <path d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34A21.93 21.93 0 002 24c0 3.55.85 6.91 2.34 9.88l7.35-5.7z" fill="#FBBC05" />
      <path
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
        fill="#EA4335"
      />
    </svg>
  );
}

function GoogleDriveMark() {
  return (
    <svg viewBox="0 0 87.3 78" width="1em" height="1em" style={{ display: "block" }}>
      <path d="M6.6 66.85l3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da" />
      <path
        d="M43.65 25L29.9 1.2c-1.35.8-2.5 1.9-3.3 3.3L1.2 47.5c-.8 1.4-1.2 2.95-1.2 4.5h27.5z"
        fill="#00ac47"
      />
      <path d="M73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75L86.1 55.85c.8-1.4 1.2-2.95 1.2-4.5h-27.5l5.85 12.6z" fill="#ea4335" />
      <path d="M43.65 25L57.4 1.2c-1.35-.8-2.9-1.2-4.5-1.2H34.4c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d" />
      <path d="M59.8 52H27.5l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc" />
      <path
        d="M73.4 26.5L60.85 4.5c-.8-1.4-1.95-2.5-3.3-3.3L43.65 25l16.15 27h27.45c0-1.55-.4-3.1-1.2-4.5z"
        fill="#ffba00"
      />
    </svg>
  );
}

const EMPTY_S3: S3Config = { accessKeyId: "", region: "", bucket: "", folder: "", endpoint: "" };
const EMPTY_GOOGLE_DRIVE: GoogleDriveConfig = { folder: "" };

interface TestResult {
  ok: boolean;
  message: string;
}

export function StorageSection() {
  const { data: preference, isLoading } = useStoragePreference();
  const setPreference = useSetStoragePreference();
  const testConnection = useTestStoragePreference();
  const navigate = useNavigate();
  const session = useAuthStore((s) => s.session);
  const authReady = useAuthStore((s) => s.ready);

  const { data: googleStatus } = useGoogleDriveStatus();
  const googleSignIn = useGoogleDriveSignIn();
  const googleSignOut = useGoogleDriveSignOut();

  // Lets a deep link (e.g. RecordPage's "storage isn't set up" toast) land here with a
  // specific destination already highlighted — ?provider=doculigent — instead of showing
  // whatever's currently saved and making the user click again to get to the fix.
  const [searchParams] = useSearchParams();
  const requestedProvider = searchParams.get("provider");

  const [openModal, setOpenModal] = useState<StorageProviderKind | null>(null);
  const [s3, setS3] = useState<S3Config>(EMPTY_S3);
  const [s3Secret, setS3Secret] = useState("");
  const [googleDrive, setGoogleDrive] = useState<GoogleDriveConfig>(EMPTY_GOOGLE_DRIVE);
  const [result, setResult] = useState<TestResult | null>(null);

  useEffect(() => {
    if (preference?.s3) setS3(preference.s3);
    if (preference?.googleDrive) setGoogleDrive(preference.googleDrive);
  }, [preference]);

  useEffect(() => {
    if (requestedProvider === "doculigent" || requestedProvider === "s3" || requestedProvider === "google_drive") {
      setOpenModal(requestedProvider);
    }
  }, [requestedProvider]);

  const activeProvider = preference?.provider ?? "doculigent";
  const basePreference: StoragePreference = preference ?? { provider: "doculigent" };
  const needsSignIn = authReady && !session;

  function closeModal() {
    setOpenModal(null);
    setResult(null);
    googleSignIn.reset();
  }

  async function useProvider(next: StoragePreference) {
    setResult(null);
    try {
      await setPreference.mutateAsync({
        preference: next,
        s3SecretKey: next.provider === "s3" ? s3Secret || undefined : undefined,
      });
      setResult({ ok: true, message: "Now using this storage for uploads and shares." });
      if (next.provider === "s3") setS3Secret("");
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function useDoculigent() {
    if (needsSignIn) {
      navigate("/account");
      return;
    }
    await useProvider({ ...basePreference, provider: "doculigent" });
  }

  async function saveS3() {
    setResult(null);
    try {
      await setPreference.mutateAsync({
        preference: { ...basePreference, provider: activeProvider, s3 },
        s3SecretKey: s3Secret || undefined,
      });
      setResult({ ok: true, message: "Saved — the bucket/folder is ready." });
      setS3Secret("");
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function testS3() {
    setResult(await testConnection.mutateAsync({ preference: { ...basePreference, provider: "s3", s3 }, s3SecretKey: s3Secret || undefined }));
  }

  async function useS3() {
    await useProvider({ ...basePreference, provider: "s3", s3 });
  }

  async function saveGoogleDrive() {
    setResult(null);
    try {
      await setPreference.mutateAsync({ preference: { ...basePreference, provider: activeProvider, googleDrive } });
      setResult({ ok: true, message: "Saved." });
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function useGoogleDrive() {
    setResult(null);
    try {
      if (!googleStatus?.connected) await googleSignIn.mutateAsync();
      await useProvider({ ...basePreference, provider: "google_drive", googleDrive });
      closeModal();
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function connectGoogle() {
    setResult(null);
    try {
      await googleSignIn.mutateAsync();
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function disconnectGoogle() {
    setResult(null);
    try {
      await googleSignOut.mutateAsync();
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <section className="panel settings-content">
      <p className="muted">
        Choose where recordings and team files go when you upload or share. Doculigent Cloud keeps full team support
        (invites, shared roster); bringing your own S3 bucket uses infrastructure you already own, with team shown
        as a local file list. Google Drive doesn't support team — switch to Doculigent Cloud for that.
      </p>

      {isLoading ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <div className="storage-grid">
            <button
              type="button"
              className={activeProvider === "doculigent" ? "storage-card active" : "storage-card"}
              onClick={() => setOpenModal("doculigent")}
            >
              {activeProvider === "doculigent" && <span className="storage-card-badge">Active</span>}
              <span className="storage-card-icon doculigent">
                <Cloud size={22} />
              </span>
              <span className="storage-card-title">Doculigent Cloud</span>
              <span className="storage-card-blurb">Sign in with doculigent.com. Full team support.</span>
              <span className="storage-card-status">
                {!authReady ? "…" : session ? `Signed in as ${session.user.email || session.user.name}` : "Not signed in"}
              </span>
            </button>

            <button
              type="button"
              className={activeProvider === "s3" ? "storage-card active" : "storage-card"}
              onClick={() => setOpenModal("s3")}
            >
              {activeProvider === "s3" && <span className="storage-card-badge">Active</span>}
              <span className="storage-card-icon s3">
                <Database size={22} />
              </span>
              <span className="storage-card-title">Bring your own S3</span>
              <span className="storage-card-blurb">Upload to a bucket you own.</span>
              <span className="storage-card-status">
                {preference?.s3?.bucket ? `Bucket: ${preference.s3.bucket}` : "Not configured"}
              </span>
            </button>

            <button
              type="button"
              className={activeProvider === "google_drive" ? "storage-card active" : "storage-card"}
              onClick={() => setOpenModal("google_drive")}
            >
              {activeProvider === "google_drive" && <span className="storage-card-badge">Active</span>}
              <span className="storage-card-icon google">
                <GoogleDriveMark />
              </span>
              <span className="storage-card-title">Google Drive</span>
              <span className="storage-card-blurb">Upload to your google drive.</span>
              <span className="storage-card-status">
                {googleStatus?.connected ? `Connected as ${googleStatus.email}` : "Not connected"}
              </span>
            </button>
          </div>

          {result && !openModal && <p className={result.ok ? "notice" : "error"}>{result.message}</p>}
        </>
      )}

      {openModal === "doculigent" && (
        <div className="modal-backdrop" onClick={closeModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Doculigent Cloud</h2>
            <p className="muted">
              Sign in with your doculigent.com account. Full team support — invite members, shared roster.
            </p>
            <div className="field">
              <span>Account</span>
              {!authReady ? (
                <p className="muted">Loading…</p>
              ) : session ? (
                <p>
                  {session.user.name} <span className="muted sub">({session.user.email})</span>
                </p>
              ) : (
                <p className="muted">You're not signed in yet.</p>
              )}
            </div>

            <div className="actions modal-actions">
              {activeProvider === "doculigent" ? (
                <span className="muted field-hint-inline">In use</span>
              ) : (
                <button type="button" className="primary" onClick={useDoculigent} disabled={setPreference.isPending}>
                  {needsSignIn
                    ? "Sign in to use Doculigent Cloud"
                    : setPreference.isPending
                      ? "Switching…"
                      : "Switch to Doculigent Cloud"}
                </button>
              )}
              <button type="button" onClick={closeModal}>
                Close
              </button>
            </div>

            {result && <p className={result.ok ? "notice" : "error"}>{result.message}</p>}
          </div>
        </div>
      )}

      {openModal === "s3" && (
        <div className="modal-backdrop" onClick={closeModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Bring your own S3</h2>
            <p className="muted">Upload to a bucket you own. Team becomes a local file list.</p>

            <div className="field">
              <span>Access Key ID</span>
              <input value={s3.accessKeyId} onChange={(e) => setS3({ ...s3, accessKeyId: e.target.value })} />
            </div>
            <div className="field">
              <span>Secret Access Key</span>
              <input
                type="password"
                value={s3Secret}
                onChange={(e) => setS3Secret(e.target.value)}
                placeholder={preference?.s3 ? "Leave blank to keep the saved key" : ""}
              />
            </div>
            <div className="field">
              <span>Region</span>
              <input value={s3.region} onChange={(e) => setS3({ ...s3, region: e.target.value })} placeholder="us-east-1" />
            </div>
            <div className="field">
              <span>Bucket</span>
              <input value={s3.bucket} onChange={(e) => setS3({ ...s3, bucket: e.target.value })} />
            </div>
            <div className="field">
              <span>Folder</span>
              <input value={s3.folder} onChange={(e) => setS3({ ...s3, folder: e.target.value })} placeholder="Doculigent" />
              <small className="field-hint storage-path-preview">
                <code>{s3.bucket || "bucket"}/{s3.folder || "Doculigent"}/teams/…</code> for team uploads
                <br />
                <code>{s3.bucket || "bucket"}/{s3.folder || "Doculigent"}/shared/…</code> for shared links
              </small>
            </div>
            <div className="field">
              <span>Endpoint (optional)</span>
              <input
                value={s3.endpoint ?? ""}
                onChange={(e) => setS3({ ...s3, endpoint: e.target.value })}
                placeholder="For S3-compatible services like R2, B2, MinIO"
              />
            </div>

            <div className="actions modal-actions">
              <button
                type="button"
                onClick={testS3}
                disabled={testConnection.isPending || !s3.accessKeyId || !s3.region || !s3.bucket}
              >
                {testConnection.isPending ? "Testing…" : "Test"}
              </button>
              <button
                type="button"
                onClick={saveS3}
                disabled={setPreference.isPending || !s3.accessKeyId || !s3.region || !s3.bucket}
              >
                {setPreference.isPending ? "Saving…" : "Save"}
              </button>
              {activeProvider === "s3" ? (
                <span className="muted field-hint-inline">(In Use)</span>
              ) : (
                <button
                  type="button"
                  className="primary"
                  onClick={useS3}
                  disabled={setPreference.isPending || !s3.accessKeyId || !s3.region || !s3.bucket}
                >
                  {setPreference.isPending ? "Switching…" : "Switch to S3"}
                </button>
              )}
              <button type="button" onClick={closeModal}>
                Close
              </button>
            </div>

            {result && <p className={result.ok ? "notice" : "error"}>{result.message}</p>}
          </div>
        </div>
      )}

      {openModal === "google_drive" && (
        <div className="modal-backdrop" onClick={closeModal}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Google Drive</h2>
            <p className="muted">Upload to your google drive.</p>

            <div className="field google-account-field">
              <span>Account</span>
              {googleStatus?.connected ? (
                <div className="google-account-row">
                  <p>Connected as {googleStatus.email}</p>
                  <button
                    type="button"
                    className="google-signout-btn"
                    onClick={disconnectGoogle}
                    disabled={googleSignOut.isPending}
                  >
                    {googleSignOut.isPending ? "Signing out…" : "Sign out"}
                  </button>
                </div>
              ) : (
                <>
                  <p className="muted">Not connected yet.</p>
                  <button
                    type="button"
                    className="google-signin-btn"
                    onClick={connectGoogle}
                    disabled={googleSignIn.isPending}
                  >
                    <GoogleGMark />
                    {googleSignIn.isPending ? "Connecting…" : "Connect Google account"}
                  </button>
                </>
              )}
            </div>

            <div className="field">
              <span>Folder</span>
              <input
                value={googleDrive.folder}
                onChange={(e) => setGoogleDrive({ ...googleDrive, folder: e.target.value })}
                placeholder="Doculigent"
              />
              <small className="field-hint storage-path-preview">
                <code>{googleDrive.folder || "Doculigent"}/shared/…</code> for shared links
                <br />
                Team isn't supported with Google Drive.
              </small>
            </div>

            <div className="actions modal-actions">
              <button type="button" onClick={saveGoogleDrive} disabled={setPreference.isPending}>
                {setPreference.isPending ? "Saving…" : "Save"}
              </button>
              {activeProvider === "google_drive" ? (
                <span className="muted field-hint-inline">In use</span>
              ) : (
                <button
                  type="button"
                  className="primary"
                  onClick={useGoogleDrive}
                  disabled={setPreference.isPending || googleSignIn.isPending}
                >
                  {setPreference.isPending
                    ? "Switching…"
                    : googleSignIn.isPending
                      ? "Connecting…"
                      : "Switch to Google Drive"}
                </button>
              )}
              <button type="button" onClick={closeModal}>
                Close
              </button>
            </div>

            {result && <p className={result.ok ? "notice" : "error"}>{result.message}</p>}
          </div>
        </div>
      )}
    </section>
  );
}
