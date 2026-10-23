export interface CapacityLimits {
  global: number;
  perProvider: number;
  perBot: number;
  perResource: number;
}

export const DEFAULT_CAPACITY: CapacityLimits = {
  global: 4,
  perProvider: 2,
  perBot: 1,
  perResource: 1,
};

export interface Reservation {
  provider: string;
  botId: string;
  resourceIds: string[];
}

export function capacityBlock(
  candidate: Reservation,
  active: readonly Reservation[],
  limits: CapacityLimits,
): string | null {
  if (active.length >= limits.global) return "global";
  let providerCount = 0;
  let botCount = 0;
  for (const reservation of active) {
    if (reservation.provider === candidate.provider) providerCount += 1;
    if (reservation.botId === candidate.botId) botCount += 1;
  }
  if (providerCount >= limits.perProvider) return "provider";
  if (botCount >= limits.perBot) return "bot";
  return resourceBlock(candidate.resourceIds, active, limits.perResource);
}

function resourceBlock(
  resourceIds: readonly string[],
  active: readonly Reservation[],
  limit: number,
): string | null {
  for (const resourceId of new Set(resourceIds)) {
    const count = active.reduce(
      (total, reservation) => total + Number(reservation.resourceIds.includes(resourceId)),
      0,
    );
    if (count >= limit) return `resource:${resourceId}`;
  }
  return null;
}

export function overlapDecision(
  mode: "skip" | "queue" | "coalesce",
  active: boolean,
  queued: boolean,
): "admit" | "skip" | "queue" | "coalesce" {
  if (!active && !queued) return "admit";
  if (mode === "skip") return "skip";
  if (mode === "coalesce" && queued) return "coalesce";
  return "queue";
}

export interface RetryDelayInput {
  attempt: number;
  now: number;
  retryAfterMs?: number;
  jitter: () => number;
}

// The result is an absolute admission time, so callers can persist it across restarts.
export function retryDelay(input: RetryDelayInput): number | null {
  if (input.attempt !== 1 && input.attempt !== 2) return null;
  const base = input.attempt === 1 ? 2_000 : 8_000;
  const jitter = Math.min(1_000, Math.max(0, Math.floor(input.jitter() * 1_000)));
  return input.now + Math.max(base + jitter, input.retryAfterMs ?? 0);
}

// Construct only when the provider proves the failed operation had no external effect.
export class ProvenInfrastructureError extends Error {
  readonly noEffect = true;

  constructor(
    message: string,
    readonly provider: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProvenInfrastructureError";
  }
}

export interface ProviderCircuitState {
  failures: number;
  openUntil: number;
  probe: boolean;
}

export function providerCircuitDecision(
  state: ProviderCircuitState,
  now: number,
): { allowed: boolean; state: ProviderCircuitState } {
  if (state.probe) return { allowed: false, state };
  if (state.failures < 3) return { allowed: true, state };
  if (now < state.openUntil) return { allowed: false, state };
  return { allowed: true, state: { ...state, probe: true } };
}

export function providerCircuitFailure(state: ProviderCircuitState, now: number): ProviderCircuitState {
  const failures = state.failures + 1;
  return {
    failures,
    openUntil: failures >= 3 ? now + 30_000 : 0,
    probe: false,
  };
}

export function providerCircuitSuccess(): ProviderCircuitState {
  return { failures: 0, openUntil: 0, probe: false };
}
