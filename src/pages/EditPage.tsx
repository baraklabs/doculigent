import { ComingSoon } from "../components/ComingSoon";
import "./EditPage.css";

export function EditPage() {
  return (
    <section className="panel edit-coming-soon">
      <ComingSoon
        icon="🎬"
        title="Edit is coming soon"
        subtitle="A fresh multi-clip editor — trim, zoom, captions, AI powered and more."
      />
    </section>
  );
}
