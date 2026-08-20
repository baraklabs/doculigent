import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { S3Config, StorageProviderKind } from "@shared/types/storage";
import { useSetStoragePreference, useStoragePreference } from "../../hooks/useStorage";
import { useAuthStore } from "../../store/authStore";

const PROVIDERS: { id: StorageProviderKind; label: string; blurb: string }[] = [
  {
    id: "doculigent",
    label: "Doculigent Cloud",
    blurb: "Sign in with your doculigent.com account. Full team support — invite members, shared roster.",
  },
  {
    id: "s3",
    label: "Bring your own S3",
    blurb: "Upload to a bucket you own. Team becomes a local file list — member invites aren't available.",
  },
];

const EMPTY_S3: S3Config = { accessKeyId: "", region: "", bucket: "", folder: "", endpoint: "" };

export function StorageSection() {
  const { data: preference, isLoading } = useStoragePreference();
  const setPreference = useSetStoragePreference();
  const navigate = useNavigate();
  const session = useAuthStore((s) => s.session);
  const authReady = useAuthStore((s) => s.ready);

  // Lets a deep link (e.g. RecordPage's "storage isn't set up" toast) land here with a
  // specific destination already highlighted — ?provider=doculigent — instead of showing
  // whatever's currently saved and making the user click again to get to the fix.
  const [searchParams] = useSearchParams();
  const requestedProvider = searchParams.get("provider");
  const [selected, setSelected] = useState<StorageProviderKind | null>(
    requestedProvider === "doculigent" || requestedProvider === "s3" ? requestedProvider : null
  );
  const [s3, setS3] = useState<S3Config>(EMPTY_S3);
  const [s3Secret, setS3Secret] = useState("");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (preference?.s3) setS3(preference.s3);
  }, [preference]);

  // An S3 provider saved with no actual config (see RecordPage's storageNotSetUp — same
  // definition) isn't a real choice of "Bring your own S3", it's an unfinished/broken
  // state — default the page to Doculigent Cloud rather than highlighting the S3 tile for
  // a setup that was never actually completed.
  const savedProviderIsUsable = preference?.provider === "doculigent" || (preference?.provider === "s3" && !!preference.s3);
  const provider = selected ?? (savedProviderIsUsable ? preference!.provider : "doculigent");
  const hasSavedS3 = preference?.provider === "s3" && !!preference.s3;
  const needsSignIn = authReady && !session;

  async function saveDoculigent() {
    setResult(null);
    try {
      await setPreference.mutateAsync({ preference: { provider: "doculigent" } });
      setResult({ ok: true, message: "Switched to Doculigent Cloud." });
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function saveS3() {
    setResult(null);
    try {
      await setPreference.mutateAsync({ preference: { provider: "s3", s3 }, s3SecretKey: s3Secret || null });
      setResult({ ok: true, message: "Connected — the bucket/folder is ready." });
      setS3Secret("");
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <section className="panel settings-content">
      <p className="muted">
        Choose where recordings and team files go when you upload or share. Doculigent Cloud keeps full team support
        (invites, shared roster); bringing your own S3 bucket uses infrastructure you already own, with team shown
        as a local file list.
      </p>

      {isLoading ? (
        <p className="muted">Loading…</p>
      ) : (
        <>
          <div className="field">
            <span>Destination</span>
            <div className="model-filter">
              {PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={p.id === provider ? "filter-chip active" : "filter-chip"}
                  onClick={() => {
                    setSelected(p.id);
                    setResult(null);
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <small className="field-hint">{PROVIDERS.find((p) => p.id === provider)?.blurb}</small>
          </div>

          {provider === "doculigent" && (
            <div className="field">
              {needsSignIn ? (
                <>
                  <small className="field-hint">You're not signed in yet.</small>
                  <button type="button" className="primary cta-highlight" onClick={() => navigate("/account")}>
                    Sign in
                  </button>
                </>
              ) : (
                preference?.provider !== "doculigent" && (
                  <button type="button" className="primary" onClick={saveDoculigent} disabled={setPreference.isPending}>
                    Switch to Doculigent Cloud
                  </button>
                )
              )}
            </div>
          )}

          {provider === "s3" && (
            <>
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
                  placeholder={hasSavedS3 ? "Leave blank to keep the saved key" : ""}
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
                <input value={s3.folder} onChange={(e) => setS3({ ...s3, folder: e.target.value })} placeholder="doculigent" />
                <small className="field-hint storage-path-preview">
                  <code>{s3.bucket || "bucket"}/{s3.folder || "folder"}/teams/…</code> for team uploads
                  <br />
                  <code>{s3.bucket || "bucket"}/{s3.folder || "folder"}/shared/…</code> for shared links
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
              <div className="actions">
                <button
                  type="button"
                  className="primary"
                  onClick={saveS3}
                  disabled={setPreference.isPending || !s3.accessKeyId || !s3.region || !s3.bucket}
                >
                  {setPreference.isPending ? "Connecting…" : "Save & test connection"}
                </button>
              </div>
            </>
          )}

          {result && <p className={result.ok ? "notice" : "error"}>{result.message}</p>}
        </>
      )}
    </section>
  );
}
