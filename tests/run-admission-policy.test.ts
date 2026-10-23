import { describe, expect, it } from "vitest";
import {
  type CapacityLimits,
  capacityBlock,
  DEFAULT_CAPACITY,
  overlapDecision,
  type ProviderCircuitState,
  providerCircuitDecision,
  providerCircuitFailure,
  providerCircuitSuccess,
  type Reservation,
  retryDelay,
} from "../server/run-admission-policy";

const LIMITS: CapacityLimits = { global: 10, perProvider: 10, perBot: 10, perResource: 10 };
const reservation = (patch: Partial<Reservation> = {}): Reservation => ({
  provider: "provider-a",
  botId: "bot-a",
  resourceIds: [],
  ...patch,
});

const DIMENSIONS = [
  { dimension: "global", reason: "global", active: reservation({ provider: "other", botId: "other" }) },
  { dimension: "perProvider", reason: "provider", active: reservation({ botId: "other" }) },
  { dimension: "perBot", reason: "bot", active: reservation({ provider: "other" }) },
  {
    dimension: "perResource",
    reason: "resource:opaque/id",
    active: reservation({ provider: "other", botId: "other", resourceIds: ["opaque/id"] }),
  },
] as const;

describe("capacity admission boundaries", () => {
  it.each(DIMENSIONS)("blocks exactly at the $dimension limit", ({ dimension, reason, active }) => {
    const limits = { ...LIMITS, [dimension]: 2 };
    const candidate = reservation({ resourceIds: ["opaque/id"] });
    expect(capacityBlock(candidate, [active], limits)).toBeNull();
    expect(capacityBlock(candidate, [active, active], limits)).toBe(reason);
  });

  it.each(DIMENSIONS)("a zero $dimension limit refuses the first reservation", ({ dimension, reason }) => {
    const candidate = reservation({ resourceIds: ["opaque/id"] });
    expect(capacityBlock(candidate, [], { ...LIMITS, [dimension]: 0 })).toBe(reason);
  });

  it("independent providers, bots and resources still contend for global capacity", () => {
    const active = ["a", "b", "c", "d"].map((id) =>
      reservation({ provider: id, botId: id, resourceIds: [id] }),
    );
    expect(capacityBlock(reservation({ provider: "e", botId: "e" }), active, DEFAULT_CAPACITY)).toBe(
      "global",
    );
  });
});

describe("opaque resource reservations", () => {
  it("counts each execution once even when either resource list repeats an ID", () => {
    const candidate = reservation({ resourceIds: ["target", "target"] });
    const active = [reservation({ resourceIds: ["target", "target"] })];
    const limits = { ...LIMITS, perResource: 2 };
    expect(capacityBlock(candidate, active, limits)).toBeNull();
    expect(capacityBlock(candidate, [...active, reservation({ resourceIds: ["target"] })], limits)).toBe(
      "resource:target",
    );
  });

  it("matches exact opaque IDs without path, case or whitespace normalization", () => {
    const active = [reservation({ resourceIds: ["a/../b", "Target", " target", "__proto__"] })];
    const limits = { ...LIMITS, perResource: 1 };
    expect(capacityBlock(reservation({ resourceIds: ["b", "target"] }), active, limits)).toBeNull();
    expect(capacityBlock(reservation({ resourceIds: ["__proto__"] }), active, limits)).toBe(
      "resource:__proto__",
    );
  });

  it("checks every candidate resource independently across providers and bots", () => {
    const active = [reservation({ provider: "other", botId: "other", resourceIds: ["second"] })];
    const candidate = reservation({ resourceIds: ["first", "second"] });
    expect(capacityBlock(candidate, active, { ...LIMITS, perResource: 1 })).toBe("resource:second");
    expect(capacityBlock(reservation(), active, { ...LIMITS, perResource: 0 })).toBeNull();
  });
});

describe("routine overlap admission", () => {
  it.each([
    ["skip", false, false, "admit"],
    ["skip", true, false, "skip"],
    ["skip", false, true, "skip"],
    ["skip", true, true, "skip"],
    ["queue", false, false, "admit"],
    ["queue", true, false, "queue"],
    ["queue", false, true, "queue"],
    ["queue", true, true, "queue"],
    ["coalesce", false, false, "admit"],
    ["coalesce", true, false, "queue"],
    ["coalesce", false, true, "coalesce"],
    ["coalesce", true, true, "coalesce"],
  ] as const)("%s with active=%s queued=%s returns %s", (mode, active, queued, decision) => {
    expect(overlapDecision(mode, active, queued)).toBe(decision);
  });
});

describe("proven infrastructure retry timing", () => {
  it.each([
    [1, 0, 12_000],
    [1, 0.5, 12_500],
    [1, 1, 13_000],
    [2, 0, 18_000],
    [2, 0.5, 18_500],
    [2, 1, 19_000],
  ])("schedules after attempt %s with jitter %s", (attempt, jitter, expected) => {
    expect(retryDelay({ attempt, now: 10_000, jitter: () => jitter })).toBe(expected);
  });

  it.each([0, 3, 4, 1.5])("does not retry attempt %s", (attempt) => {
    expect(retryDelay({ attempt, now: 10_000, jitter: () => 0.5 })).toBeNull();
  });

  it("honors Retry-After without shortening the jittered backoff", () => {
    const input = { attempt: 1, now: 10_000, jitter: () => 0.5 };
    expect(retryDelay({ ...input, retryAfterMs: 20_000 })).toBe(30_000);
    expect(retryDelay({ ...input, retryAfterMs: 1_000 })).toBe(12_500);
    expect(retryDelay({ ...input, retryAfterMs: -1_000 })).toBe(12_500);
  });

  it("bounds injected jitter at zero and one second", () => {
    expect(retryDelay({ attempt: 1, now: 0, jitter: () => -1 })).toBe(2_000);
    expect(retryDelay({ attempt: 2, now: 0, jitter: () => 2 })).toBe(9_000);
  });
});

function openCircuit(): ProviderCircuitState {
  let state = providerCircuitSuccess();
  for (const now of [0, 500, 1_000]) state = providerCircuitFailure(state, now);
  return state;
}

describe("provider circuit admission", () => {
  it("allows two consecutive failures and opens on the third for thirty seconds", () => {
    let state = providerCircuitSuccess();
    expect(providerCircuitDecision(state, 0).allowed).toBe(true);
    for (const now of [0, 500]) {
      state = providerCircuitFailure(state, now);
      expect(providerCircuitDecision(state, now).allowed).toBe(true);
    }
    state = providerCircuitFailure(state, 1_000);
    expect(providerCircuitDecision(state, 30_999).allowed).toBe(false);
    expect(providerCircuitDecision(state, 31_000).allowed).toBe(true);
  });

  it("claims only one half-open probe and retains the claim across JSON persistence", () => {
    const open = Object.freeze(openCircuit());
    const claim = providerCircuitDecision(open, 31_000);
    expect(claim.allowed).toBe(true);
    expect(open.probe).toBe(false);
    const persisted = JSON.parse(JSON.stringify(claim.state)) as ProviderCircuitState;
    expect(providerCircuitDecision(persisted, 31_000).allowed).toBe(false);
    expect(providerCircuitDecision(persisted, 100_000).allowed).toBe(false);
  });

  it("reopens for a full cooldown when the half-open probe fails", () => {
    const probe = providerCircuitDecision(openCircuit(), 31_000).state;
    const reopened = providerCircuitFailure(Object.freeze(probe), 32_000);
    expect(providerCircuitDecision(reopened, 61_999).allowed).toBe(false);
    expect(providerCircuitDecision(reopened, 62_000).allowed).toBe(true);
  });

  it("success releases the probe and resets the consecutive failure threshold", () => {
    const probe = providerCircuitDecision(openCircuit(), 31_000).state;
    expect(providerCircuitDecision(probe, 31_000).allowed).toBe(false);
    let state = providerCircuitSuccess();
    expect(providerCircuitDecision(state, 31_000).allowed).toBe(true);
    state = providerCircuitFailure(state, 32_000);
    state = providerCircuitFailure(state, 33_000);
    expect(providerCircuitDecision(state, 33_000).allowed).toBe(true);
    state = providerCircuitFailure(state, 34_000);
    expect(providerCircuitDecision(state, 34_000).allowed).toBe(false);
  });

  it("provider histories do not share an admission state", () => {
    const blocked = openCircuit();
    const healthy = providerCircuitSuccess();
    expect(providerCircuitDecision(blocked, 2_000).allowed).toBe(false);
    expect(providerCircuitDecision(healthy, 2_000).allowed).toBe(true);
  });
});
