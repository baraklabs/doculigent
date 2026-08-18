import { desktopCapturer, session } from "electron";

// The non-native (no gdigrab) screen recording path uses getDisplayMedia + this handler
// instead of the legacy getUserMedia({chromeMediaSource: "desktop"}) constraints — the
// legacy API has no way to suppress the OS cursor from the captured frames, which was
// baking a real cursor into screen.mp4 underneath the app's own synthetic cursor overlay
// (drawn from cursor.json) applied on top of it afterward. getDisplayMedia's `cursor:
// "never"` constraint is the only way to ask Chromium not to composite the system cursor
// into the stream at all.
//
// This handler exists so the renderer can keep its own custom target picker (RecordPage's
// capture-target list) instead of Chromium's native "choose what to share" dialog —
// setDisplayMediaRequestHandler lets the app supply the already-chosen source directly.
let pendingTargetId: string | null = null;

export function setPendingDisplayMediaTarget(targetId: string | null): void {
  console.log("[displayMedia] setPendingDisplayMediaTarget", { targetId });
  pendingTargetId = targetId;
}

export function registerDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      const targetId = pendingTargetId;
      console.log("[displayMedia] request handler fired", { targetId });
      if (!targetId) {
        console.error("[displayMedia] no pending target set — denying request");
        callback({});
        return;
      }
      try {
        const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
        const source = sources.find((s) => s.id === targetId);
        console.log("[displayMedia] resolved source", {
          found: !!source,
          name: source?.name,
          availableIds: sources.map((s) => s.id),
        });
        callback(source ? { video: source } : {});
      } catch (e) {
        console.error("[displayMedia] failed to resolve source", e);
        callback({});
      }
    },
    { useSystemPicker: false }
  );
}
