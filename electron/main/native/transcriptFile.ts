/**
 * Writes/removes a .srt subtitle file alongside a recording's media file, so a
 * transcript isn't just locked inside the app's own database — it's portable the same
 * way most video editors, players, and platforms expect (drop the video + .srt into
 * anything and it picks up captions).
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Transcript } from "@shared/types/models";

function srtTimestamp(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

function toSrt(transcript: Transcript): string {
  return transcript.segments
    .map((seg, i) => {
      const speaker = seg.speaker ? `${seg.speaker}: ` : "";
      return `${i + 1}\n${srtTimestamp(seg.start)} --> ${srtTimestamp(seg.end)}\n${speaker}${seg.text}\n`;
    })
    .join("\n");
}

export function transcriptFilePath(mediaFilePath: string): string {
  return path.join(path.dirname(mediaFilePath), "transcript.srt");
}

export async function writeTranscriptFile(mediaFilePath: string, transcript: Transcript): Promise<void> {
  await fs.writeFile(transcriptFilePath(mediaFilePath), toSrt(transcript), "utf-8");
}

export async function removeTranscriptFile(mediaFilePath: string): Promise<void> {
  await fs.rm(transcriptFilePath(mediaFilePath), { force: true });
}
