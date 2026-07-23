/** Augments electron-vite's ImportMetaEnv (see node_modules/electron-vite/node.d.ts) for
 *  main-process code that reads build-time env vars — currently just authConfig.ts. Lives
 *  under shared/ (rather than electron/) so it's picked up by both tsconfig.node.json and
 *  tsconfig.web.json, which both include "shared/**". */
interface ImportMetaEnv {
  readonly VITE_WEB_URL: string;
  readonly VITE_SUPABASE_URL: string;
}
