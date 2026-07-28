import { mediaUrl } from "@shared/constants/media";

export interface DetectedMedia {
  kind: "video" | "audio";
  durationSecs: number;
}

export function detectMediaKind(filePath: string): Promise<DetectedMedia> {
  return new Promise((resolve, reject) => {
    const el = document.createElement("video");
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      resolve({
        kind: el.videoWidth > 0 && el.videoHeight > 0 ? "video" : "audio",
        durationSecs: el.duration,
      });
      el.src = "";
    };
    el.onerror = () => {
      reject(new Error("Couldn't read this file — is it a supported audio/video format?"));
      el.src = "";
    };
    el.src = mediaUrl(filePath);
  });
}
