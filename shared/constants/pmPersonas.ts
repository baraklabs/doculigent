import type { CustomPersona } from "../types/persona";

export interface PmPersonaDef {
  id: string;
  name: string;
  description: string;
  focus: string;
  filePrompt?: string | null;
  summaryPrompt?: string | null;
}

export const PM_PERSONAS: PmPersonaDef[] = [
  {
    id: "scrum-master",
    name: "Scrum Master",
    description: "Tracks progress, blockers, and action items across the team's demo/standup recordings.",
    focus:
      "what was demoed and its apparent completeness, blockers or risks mentioned, decisions made, " +
      "action items and who owns them, and anything that affects sprint scope or timeline",
  },
  {
    id: "sales",
    name: "Sales",
    description: "Surfaces customer pain points, objections, and buying signals from calls/demos.",
    focus:
      "customer pain points, objections raised, competitor mentions, buying/closing signals, " +
      "feature requests tied to a deal, and next steps or follow-ups needed to move the deal forward",
  },
  {
    id: "product-manager",
    name: "Product Manager",
    description: "Extracts feature feedback, usability issues, and roadmap signals.",
    focus:
      "feature feedback (positive and negative), usability friction, feature requests, " +
      "prioritization signals, and anything with roadmap implications",
  },
  {
    id: "support",
    name: "Customer Success",
    description: "Flags satisfaction, complaints, and churn risk from customer-facing recordings.",
    focus:
      "customer satisfaction or frustration, complaints, unresolved issues, churn risk signals, " +
      "and feature requests raised as a workaround for a problem",
  },
];

const FALLBACK_PERSONA: PmPersonaDef = {
  id: "unknown",
  name: "Unknown persona",
  description: "This persona no longer exists.",
  focus: "whatever seems most relevant to this team",
};

export function pmPersonaDef(id: string): PmPersonaDef {
  return PM_PERSONAS.find((p) => p.id === id) ?? PM_PERSONAS[0];
}

export function resolvePersonaById(id: string, savedPersonas: CustomPersona[]): PmPersonaDef {
  const saved = savedPersonas.find((p) => p.id === id);
  if (saved) {
    const builtIn = PM_PERSONAS.find((p) => p.id === id);
    return {
      id: saved.id,
      name: saved.name,
      description: builtIn?.description ?? "Custom persona",
      focus: saved.focus,
      filePrompt: saved.filePrompt,
      summaryPrompt: saved.summaryPrompt,
    };
  }
  const builtIn = PM_PERSONAS.find((p) => p.id === id);
  if (builtIn) return builtIn;
  return FALLBACK_PERSONA;
}

export function listAllPersonas(savedPersonas: CustomPersona[]): PmPersonaDef[] {
  const builtInIds = new Set(PM_PERSONAS.map((p) => p.id));
  const builtIns = PM_PERSONAS.map((p) => resolvePersonaById(p.id, savedPersonas));
  const customOnly = savedPersonas.filter((p) => !builtInIds.has(p.id)).map((p) => resolvePersonaById(p.id, savedPersonas));
  return [...builtIns, ...customOnly];
}

export const DEFAULT_QUICK_PROMPT = "Give a quick insight: 2-3 bullet points, terse, only the most important takeaways for this role.";
export const DEFAULT_DETAILED_PROMPT =
  "Give a detailed insight: a thorough analysis for this role, organized with headings/bullets as useful.";
