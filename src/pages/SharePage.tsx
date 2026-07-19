import { useParams } from "react-router-dom";

/** Sharing itself is still a Phase 2 stub (prompt.md: cloud sharing/sync explicitly out
 *  of scope for this pass) — doculigent.com sign-in is now real, see store/authStore.ts. */
export function SharePage() {
  const { id } = useParams<{ id: string }>();
  return (
    <section className="panel share">
      <h1>Share</h1>
      <p className="notice">
        Sharing requires a doculigent.com account and is a Phase 2 feature (see prompt.md's roadmap) — not built in
        this local-first pass. Recording <code>{id}</code> is safe in your local Library either way.
      </p>
    </section>
  );
}
