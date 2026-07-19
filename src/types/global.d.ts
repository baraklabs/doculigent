import type { MusentricApi } from "@shared/types/api";

declare global {
  interface Window {
    api: MusentricApi;
  }
}

export {};
