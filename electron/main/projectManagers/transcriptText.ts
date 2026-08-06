import type { Transcript } from "@shared/types/models";

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function transcriptToPlainText(transcript: Transcript): string {
  return transcript.segments.map((s) => `[${fmt(s.start)}] ${s.speaker}: ${s.text}`).join("\n");
}
