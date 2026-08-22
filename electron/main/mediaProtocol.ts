import { protocol } from "electron";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { MEDIA_SCHEME } from "@shared/constants/media";

/** Must run before app 'ready' — marks the scheme privileged so a <video src> using it
 *  gets fetch/CORS/range-request support like a normal https resource. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: true },
    },
  ]);
}

const MIME_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

function contentTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/** `bytes=start-end` / `bytes=start-` / `bytes=-suffixLength`, resolved against the real
 *  file size into an inclusive [start, end]. `null` = no (or unparseable) Range header,
 *  serve the whole file; `"unsatisfiable"` = a syntactically valid range that falls
 *  outside the file, which owes the caller a 416 rather than a body. */
function parseRange(header: string | null, size: number): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  let start: number;
  let end: number;
  if (rawStart === "") {
    // Suffix range — the *last* N bytes, which is how a player grabs an mp4's trailing
    // moov atom before it can play (or seek) anything at all.
    const suffix = Number(rawEnd);
    if (suffix <= 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return "unsatisfiable";
  return { start, end };
}

function fileStream(filePath: string, range?: { start: number; end: number }): ReadableStream {
  const stream = fs.createReadStream(filePath, range);
  return Readable.toWeb(stream) as unknown as ReadableStream;
}

/** Must run after app 'ready' — serves the requested absolute path with real HTTP byte-range
 *  semantics, which is what makes a <video src> on this scheme seekable at all.
 *
 *  This used to hand the request straight to `net.fetch()` on the path's file:// URL, on the
 *  assumption that Chromium's own file loader would honor the forwarded `Range` header. It
 *  does not: that response comes back `200` with no `Content-Length` and no `Accept-Ranges`,
 *  so Chromium's media pipeline classifies the resource as a *live stream* and reports
 *  `video.seekable` as `[0, 0]`. Per spec, a `currentTime` assignment outside `seekable` is
 *  clamped to the nearest seekable position — i.e. every seek silently snapped back to the
 *  first frame, while playback (which never seeks) worked fine. It only reproduced on the
 *  screen track because that's an mp4 with a real, finite duration; a MediaRecorder camera
 *  .webm reports `duration: Infinity`, which takes a different branch in Chromium and stays
 *  seekable by accident.
 *
 *  So the ranges are served here directly off the file instead: `Accept-Ranges: bytes` plus
 *  an explicit `Content-Length` on every response, `206` + `Content-Range` for a range
 *  request, `416` for one that falls outside the file. */
export function registerMediaHandler(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url);
    const filePath = decodeURIComponent(url.pathname.replace(/^\//, ""));

    let size: number;
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) return new Response(null, { status: 404 });
      size = stat.size;
    } catch {
      return new Response(null, { status: 404 });
    }

    const contentType = contentTypeFor(filePath);
    const range = parseRange(request.headers.get("Range"), size);

    if (range === "unsatisfiable") {
      return new Response(null, {
        status: 416,
        headers: {
          "Content-Range": `bytes */${size}`,
          "Accept-Ranges": "bytes",
          "Content-Type": contentType,
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    const isHead = request.method === "HEAD";
    if (range) {
      const length = range.end - range.start + 1;
      return new Response(isHead ? null : fileStream(filePath, range), {
        status: 206,
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(length),
          "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
          // The scheme itself is registered with corsEnabled (see registerMediaScheme), but
          // that only lets it *make/receive* CORS requests — Chromium still taints a canvas
          // drawn from a cross-origin <video>/<img> (media:// is always a different origin
          // from the renderer page) unless the response itself grants access. Without this,
          // playback works fine (it doesn't need CORS) but canvas.toBlob()/toDataURL() in
          // PreviewCompositor's export path throws "Tainted canvases may not be exported."
          // A blanket "*" is fine here: this scheme only ever serves whatever absolute path
          // the app itself constructs (via mediaUrl()), never third-party content.
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    return new Response(isHead ? null : fileStream(filePath), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(size),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
    });
  });
}
