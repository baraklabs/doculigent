import { protocol, net } from "electron";
import { pathToFileURL } from "node:url";
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

/** Must run after app 'ready' — serves the requested absolute path via net.fetch on its
 *  file:// URL, which (unlike a raw file:// <video src>) honors Range headers for seeking. */
export function registerMediaHandler(): void {
  protocol.handle(MEDIA_SCHEME, (request) => {
    const url = new URL(request.url);
    const filePath = decodeURIComponent(url.pathname.replace(/^\//, ""));
    return net.fetch(pathToFileURL(filePath).toString());
  });
}
