
interface PlanInfo {
  label: string;
  billed: boolean;
}

const PLANS: Record<string, PlanInfo> = {
  free: { label: "Free", billed: false },
};

export function planLabel(tier: string): string {
  return PLANS[tier]?.label ?? (tier ? tier[0].toUpperCase() + tier.slice(1) : "Unknown");
}

export function isBilledTier(tier: string): boolean {
  return PLANS[tier]?.billed ?? true;
}

export function billingIntervalLabel(interval: string): string | null {
  return interval ? `billed ${interval}` : null;
}
const TEAM_LIMITS: Record<string, number> = { free: 1, starter: 2, pro: 5, scale: 25 };

export function teamLimitForTier(tier: string): number {
  return TEAM_LIMITS[tier] ?? TEAM_LIMITS.free;
}
