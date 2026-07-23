import type { DoculigentApi } from "@shared/types/api";

declare global {
  interface Window {
    api: DoculigentApi;
  }
}

export {};
