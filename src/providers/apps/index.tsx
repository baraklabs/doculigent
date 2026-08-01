import type { ReactNode } from "react";
import { BsGithub } from "react-icons/bs";
import type { AppIntegrationKind } from "@shared/types/models";

export interface AppProviderMeta {
  kind: AppIntegrationKind;
  label: string;
  icon: ReactNode;
  accent: string;
  /** True when `icon` already renders its own real brand colors (e.g. Slack's four-color
   *  mark) — the badge that wraps it should stay neutral rather than tinting/washing it
   *  out with a single background color. */
  multicolor?: boolean;
  secretLabel: string;
  secretPlaceholder: string;
  testHint: string;
}

/** Slack's mark is genuinely four-color (no accurate single-fill version exists in any
 *  open icon set — Slack had it pulled from simple-icons over brand-guideline concerns),
 *  so it's the one icon here built from Slack's official logomark paths/colors rather
 *  than a monochrome glyph tinted a single accent, unlike GitHub below. */
function SlackMark() {
  return (
    <svg viewBox="0 0 122.8 122.8" width="1em" height="1em" style={{ display: "block" }}>
      <path
        d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9z"
        fill="#E01E5A"
      />
      <path
        d="M32.3 77.6c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z"
        fill="#E01E5A"
      />
      <path
        d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2z"
        fill="#36C5F0"
      />
      <path
        d="M45.2 32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z"
        fill="#36C5F0"
      />
      <path
        d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2z"
        fill="#2EB67D"
      />
      <path
        d="M90.5 45.2c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z"
        fill="#2EB67D"
      />
      <path
        d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9z"
        fill="#ECB22E"
      />
      <path
        d="M77.6 90.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z"
        fill="#ECB22E"
      />
    </svg>
  );
}

export const APP_PROVIDERS: AppProviderMeta[] = [
  {
    kind: "github",
    label: "GitHub",
    icon: <BsGithub />,
    accent: "#181717",
    secretLabel: "Personal Access Token",
    secretPlaceholder: "ghp_…",
    testHint: "Test calls GET /user with this token — no repo access needed.",
  },
  {
    kind: "slack",
    label: "Slack",
    icon: <SlackMark />,
    accent: "#4A154B",
    multicolor: true,
    secretLabel: "Bot User OAuth Token",
    secretPlaceholder: "xoxb-…",
    testHint: "Test calls Slack's auth.test endpoint — read-only, nothing is posted.",
  },
];

export function appProviderMeta(kind: AppIntegrationKind): AppProviderMeta {
  return APP_PROVIDERS.find((p) => p.kind === kind)!;
}
