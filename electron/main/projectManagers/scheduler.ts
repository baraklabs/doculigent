
import * as store from "../native/settingsStore";
import { runProjectManager } from "./run";

const CHECK_INTERVAL_MS = 60_000;

function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function ranToday(lastRunAt: string | null | undefined): boolean {
  if (!lastRunAt) return false;
  const last = new Date(lastRunAt);
  const now = new Date();
  return (
    last.getFullYear() === now.getFullYear() && last.getMonth() === now.getMonth() && last.getDate() === now.getDate()
  );
}

async function tick(): Promise<void> {
  const current = nowHHMM();
  const due = store
    .listProjectManagers()
    .filter((pm) => pm.triggerMode === "scheduled" && pm.scheduleTime === current && !ranToday(pm.lastRunAt));

  for (const pm of due) {
    try {
      await runProjectManager(pm);
    } finally {
      store.saveProjectManager({ ...pm, lastRunAt: new Date().toISOString() });
    }
  }
}

export function startProjectManagerScheduler(): void {
  setInterval(() => {
    tick().catch(() => {});
  }, CHECK_INTERVAL_MS);
}
