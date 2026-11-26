import { create } from "zustand";

export type ColorMode = "light" | "dark" | "auto";
export type ThemeId =
  | "indigo" | "violet" | "ocean" | "sky" | "teal" | "emerald" | "lime"
  | "amber" | "coral" | "rose" | "crimson" | "graphite"
  | "cobalt" | "mint" | "gold" | "magenta" | "plum" | "slate" | "custom";

export const COLOR_MODES: ColorMode[] = ["auto", "light", "dark"];
export const THEMES: { id: Exclude<ThemeId, "custom">; label: string; swatch: string }[] = [
  { id: "indigo", label: "Default", swatch: "#5b4bf5" },
  { id: "violet", label: "Violet", swatch: "#8b3fe0" },
  { id: "ocean", label: "Ocean", swatch: "#0b7fd6" },
  { id: "sky", label: "Sky", swatch: "#0ea5c6" },
  { id: "teal", label: "Teal", swatch: "#0f9488" },
  { id: "emerald", label: "Emerald", swatch: "#12935f" },
  { id: "lime", label: "Lime", swatch: "#6a9b12" },
  { id: "amber", label: "Amber", swatch: "#c76a00" },
  { id: "coral", label: "Coral", swatch: "#e5603d" },
  { id: "rose", label: "Rose", swatch: "#d6336c" },
  { id: "crimson", label: "Crimson", swatch: "#c42a2a" },
  { id: "graphite", label: "Graphite", swatch: "#3f4756" },
  { id: "cobalt", label: "Cobalt", swatch: "#2f5de0" },
  { id: "mint", label: "Mint", swatch: "#14a37f" },
  { id: "gold", label: "Gold", swatch: "#b8860b" },
  { id: "magenta", label: "Magenta", swatch: "#c026a8" },
  { id: "plum", label: "Plum", swatch: "#7a2f6b" },
  { id: "slate", label: "Slate", swatch: "#4a6178" },
];
export const DEFAULT_CUSTOM_COLOR = "#e0457b";

const MODE_KEY = "appearance.colorMode";
const THEME_KEY = "appearance.theme";
const CUSTOM_KEY = "appearance.customColor";
const DARK_QUERY = "(prefers-color-scheme: dark)";
const DERIVED_PROPS = [
  "--accent", "--accent-strong", "--accent-soft", "--accent-rgb", "--on-accent",
  "--bg-glow-1", "--bg-glow-2", "--bg-glow-3",
];

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — choice just won't persist */
  }
}

const isHex = (v: string | null): v is string => !!v && /^#[0-9a-f]{6}$/i.test(v);

function initialMode(): ColorMode {
  const v = read(MODE_KEY);
  return v === "light" || v === "dark" || v === "auto" ? v : "auto";
}
function initialTheme(): ThemeId {
  const v = read(THEME_KEY);
  return v === "custom" || THEMES.some((t) => t.id === v) ? (v as ThemeId) : "indigo";
}
function initialCustom(): string {
  const v = read(CUSTOM_KEY);
  return isHex(v) ? v : DEFAULT_CUSTOM_COLOR;
}

export function resolveMode(mode: ColorMode): "light" | "dark" {
  if (mode === "auto") return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
  return mode;
}

// ---- colour maths -------------------------------------------------------------------

function hexToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l * 100];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s * 100, l * 100];
}

function hsl(h: number, s: number, l: number): string {
  return `hsl(${Math.round(((h % 360) + 360) % 360)} ${Math.round(s)}% ${Math.round(l)}%)`;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function luminance([r, g, b]: [number, number, number]): number {
  const c = [r, g, b].map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** Derive the whole accent palette (light or dark variant) from one base colour. */
function deriveAccent(hex: string, dark: boolean): Record<string, string> {
  const [h, s0, l0] = hexToHsl(hex);
  const s = Math.max(s0, 25);
  const accentL = dark ? Math.max(l0, 62) : Math.min(l0, 50);
  const strongL = dark ? Math.min(accentL + 10, 80) : Math.max(accentL - 10, 18);
  const rgb = hslToRgb(h, s, accentL);
  return {
    "--accent": hsl(h, s, accentL),
    "--accent-strong": hsl(h, s, strongL),
    "--accent-soft": dark ? hsl(h, Math.min(s, 45), 18) : hsl(h, Math.min(s, 100), 95),
    "--accent-rgb": rgb.join(", "),
    "--on-accent": luminance(rgb) > 0.4 ? "#10121a" : "#ffffff",
    "--bg-glow-1": dark ? hsl(h, 45, 17) : hsl(h, 100, 92),
    "--bg-glow-2": dark ? hsl(h + 40, 45, 15) : hsl(h + 40, 100, 92),
    "--bg-glow-3": dark ? hsl(h - 40, 45, 16) : hsl(h - 40, 100, 94),
  };
}

function apply(mode: ColorMode, theme: ThemeId, custom: string) {
  const root = document.documentElement;
  const resolved = resolveMode(mode);
  root.dataset.mode = resolved;
  root.dataset.theme = theme;

  // The default theme lives in CSS (:root / :root[data-mode="dark"]); everything else is derived.
  const base = theme === "custom" ? custom : THEMES.find((t) => t.id === theme)?.swatch;
  if (theme === "indigo" || !base) {
    DERIVED_PROPS.forEach((p) => root.style.removeProperty(p));
    return;
  }
  const props = deriveAccent(base, resolved === "dark");
  for (const [k, v] of Object.entries(props)) root.style.setProperty(k, v);
}

interface ThemeState {
  mode: ColorMode;
  theme: ThemeId;
  customColor: string;
  setMode: (mode: ColorMode) => void;
  setTheme: (theme: ThemeId) => void;
  /** Pick a custom colour; also switches to the custom theme. */
  setCustomColor: (hex: string) => void;
  /** Header toggle: auto → light → dark → auto. */
  cycleMode: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  mode: initialMode(),
  theme: initialTheme(),
  customColor: initialCustom(),
  setMode(mode) {
    write(MODE_KEY, mode);
    set({ mode });
    apply(mode, get().theme, get().customColor);
  },
  setTheme(theme) {
    write(THEME_KEY, theme);
    set({ theme });
    apply(get().mode, theme, get().customColor);
  },
  setCustomColor(hex) {
    if (!isHex(hex)) return;
    write(CUSTOM_KEY, hex);
    write(THEME_KEY, "custom");
    set({ customColor: hex, theme: "custom" });
    apply(get().mode, "custom", hex);
  },
  cycleMode() {
    const order: ColorMode[] = ["auto", "light", "dark"];
    get().setMode(order[(order.indexOf(get().mode) + 1) % order.length]);
  },
}));

/** Call once before first render so there's no flash; also follows OS changes while in Auto. */
export function initTheme() {
  const { mode, theme, customColor } = useThemeStore.getState();
  apply(mode, theme, customColor);
  window.matchMedia(DARK_QUERY).addEventListener("change", () => {
    const s = useThemeStore.getState();
    if (s.mode === "auto") apply(s.mode, s.theme, s.customColor);
  });
}
