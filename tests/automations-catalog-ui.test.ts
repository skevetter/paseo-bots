import { describe, expect, it } from "vitest";
import {
  type CatalogRunState,
  catalogApplyBody,
  catalogChange,
  catalogListInput,
  catalogPages,
  catalogRevertRequest,
  catalogRunRequest,
  freezeCatalogRequest,
  INITIAL_CATALOG_CHANGE,
  INITIAL_CATALOG_PAGES,
  INITIAL_CATALOG_REVERT,
  selectCatalogIds,
} from "../client/automations/catalog-state";
import type { AutomationChangeRequest, AutomationPreview, AutomationReceipt } from "../shared/automations";
import { resolveBot } from "../shared/policies";
import { makeBot } from "./helpers";

function request(overrides: Partial<AutomationChangeRequest> = {}): AutomationChangeRequest {
  return {
    operationId: "operation-1",
    revision: "revision-1",
    targetIds: ["opaque/target:one"],
    enabled: false,
    ...overrides,
  };
}
function preview(input = request()): AutomationPreview {
  return {
    request: input,
    digest: "reviewed-digest",
    compatible: true,
    warnings: [],
    activeRunsUnaffected: true,
    rows: input.targetIds.map((id) => ({
      id,
      botId: `bot/${id}`,
      botName: "Same display name",
      routineId: `routine/${id}`,
      routineName: "Same routine name",
      beforeEnabled: true,
      afterEnabled: input.enabled,
      routineHash: "routine-hash",
      resolution: resolveBot({}, makeBot()),
      incompatibilities: [],
    })),
  };
}
function ready(input = request(), value = preview(input)) {
  const state = catalogChange(INITIAL_CATALOG_CHANGE, { type: "begin", request: input });
  return catalogChange(state, {
    type: "preview",
    generation: state.generation,
    result: { status: "previewed", preview: value },
  });
}
function receipt(): AutomationReceipt {
  return {
    operationId: "operation-1",
    kind: "automations.change",
    bodyHash: "body-hash",
    appliedAt: "2026-10-23T00:00:00Z",
    created: [],
    createdCount: 0,
    notes: [],
    originalRevision: "revision-1",
    newRevision: "revision-2",
    automations: {
      rows: [
        {
          targetId: "opaque/target:one",
          botId: "bot",
          routineId: "routine",
          before: true,
          after: false,
          afterHash: "after-hash",
        },
      ],
    },
  };
}

describe("catalog exact selection and server pagination", () => {
  it("keeps 100 exact opaque target IDs through page and global filter changes", () => {
    const firstIds = Array.from(
      { length: 100 },
      (_, index) => `opaque:not-a-bot-or-routine/${index}:same-name`,
    );
    let selected = selectCatalogIds([], firstIds);
    const first = catalogPages(INITIAL_CATALOG_PAGES, { type: "next", cursor: "opaque+/cursor:2==" });
    expect(catalogListInput(first).cursor).toBe("opaque+/cursor:2==");
    selected = selectCatalogIds(selected, [firstIds[14], "another-page:opaque/target"]);
    const filtered = catalogPages(first, {
      type: "filter",
      filters: { teamId: "exact/team", provider: "omp", enabled: false, attention: "unknown_outcomes" },
    });
    expect(catalogListInput(filtered)).toEqual({
      teamId: "exact/team",
      provider: "omp",
      enabled: false,
      attention: "unknown_outcomes",
      cursor: undefined,
      limit: 100,
    });
    expect(selected).toEqual([...firstIds, "another-page:opaque/target"]);
    const frozen = freezeCatalogRequest(request({ targetIds: selected }));
    selected.splice(0, selected.length, "replacement");
    expect(frozen.targetIds).toEqual([...firstIds, "another-page:opaque/target"]);
  });
  it("refuses oversized page additions atomically and rejects duplicate apply targets", () => {
    const selected = Array.from({ length: 499 }, (_, index) => `target:${index}`);
    expect(() => selectCatalogIds(selected, ["new-1", "new-2"])).toThrow("at most 500");
    expect(selected).toEqual(Array.from({ length: 499 }, (_, index) => `target:${index}`));
    expect(selectCatalogIds(selected, [selected[0], "last"])).toEqual([...selected, "last"]);
    expect(() => freezeCatalogRequest(request({ targetIds: ["same", "same"] }))).toThrow("only once");
  });
  it("returns to the exact prior cursor without parsing it and clears cursor on reload", () => {
    const second = catalogPages(INITIAL_CATALOG_PAGES, { type: "next", cursor: "cursor:opaque/second" });
    const third = catalogPages(second, { type: "next", cursor: "cursor:opaque/third" });
    expect(catalogListInput(catalogPages(third, { type: "previous" })).cursor).toBe("cursor:opaque/second");
    expect(catalogPages(second, { type: "next", cursor: null })).toBe(second);
    expect(catalogListInput(catalogPages(third, { type: "reload" })).cursor).toBeUndefined();
  });
});

describe("catalog reviewed change boundary", () => {
  it("freezes request before preview and refuses a late response from a replaced generation", () => {
    const input = request();
    const first = catalogChange(INITIAL_CATALOG_CHANGE, { type: "begin", request: input });
    input.targetIds[0] = "mutated-live-selection";
    input.enabled = true;
    expect(first.request?.targetIds).toEqual(["opaque/target:one"]);
    expect(first.request?.enabled).toBe(false);
    const second = catalogChange(first, {
      type: "begin",
      request: request({ operationId: "operation-2", enabled: true }),
    });
    const late = catalogChange(second, {
      type: "preview",
      generation: first.generation,
      result: { status: "previewed", preview: preview() },
    });
    expect(late).toBe(second);
    expect(() => catalogApplyBody(late)).toThrow("Preview");
    const reviewed = catalogChange(late, {
      type: "preview",
      generation: second.generation,
      result: { status: "previewed", preview: preview(second.request ?? request()) },
    });
    expect(catalogApplyBody(reviewed).request.operationId).toBe("operation-2");
    expect(catalogApplyBody(reviewed).request.enabled).toBe(true);
  });
  it("blocks stale operations until successful explicit refresh and a new preview", () => {
    const conflict = catalogChange(ready(), {
      type: "apply",
      result: { status: "conflict", error: "State revision changed" },
    });
    expect(conflict.error).toContain("Refresh catalog");
    expect(() => catalogApplyBody(conflict)).toThrow("Preview");
    expect(catalogChange(conflict, { type: "begin", request: request({ operationId: "new-op" }) })).toBe(
      conflict,
    );
    const refreshed = catalogChange(conflict, { type: "refreshed" });
    expect(() => catalogApplyBody(refreshed)).toThrow("Preview");
    const next = catalogChange(refreshed, {
      type: "begin",
      request: request({ operationId: "new-op", revision: "new-revision" }),
    });
    expect(next.phase).toBe("previewing");
    expect(next.preview).toBeNull();
    expect(next.request?.revision).toBe("new-revision");
  });
  it("preserves exact body and digest on uncertain apply, blocking replacement or dismissal", () => {
    const reviewed = ready();
    const body = catalogApplyBody(reviewed);
    const pending = catalogChange(reviewed, { type: "applying" });
    expect(catalogChange(pending, { type: "close" })).toBe(pending);
    const uncertain = catalogChange(pending, {
      type: "apply-error",
      error: "Socket closed after server write",
    });
    expect(catalogApplyBody(uncertain)).toEqual(body);
    expect(catalogApplyBody(uncertain).request).toBe(body.request);
    expect(
      catalogChange(uncertain, { type: "begin", request: request({ operationId: "replacement" }) }),
    ).toBe(uncertain);
    expect(catalogChange(uncertain, { type: "close" })).toBe(uncertain);
    const replayed = catalogChange(uncertain, {
      type: "apply",
      result: { status: "replayed", receipt: receipt(), revision: "revision-2" },
    });
    expect(replayed.receipt).toEqual(receipt());
    expect(() => catalogApplyBody(replayed)).toThrow("Preview");
  });
});

describe("catalog explicit recovery and incompatibility", () => {
  it("refuses missing, repeated or changed reviewed rows even when their request envelope matches", () => {
    const input = request({ targetIds: ["opaque-one", "opaque-two"] });
    const shown = preview(input);
    const missing = ready(input, { ...shown, rows: shown.rows.slice(0, 1) });
    expect(missing.phase).toBe("conflict");
    const repeated = ready(input, { ...shown, rows: [shown.rows[0], shown.rows[0]] });
    expect(repeated.phase).toBe("conflict");
    const changed = ready(input, {
      ...shown,
      rows: shown.rows.map((row) => ({ ...row, afterEnabled: true })),
    });
    expect(changed.phase).toBe("conflict");
    expect(() => catalogApplyBody(changed)).toThrow("Preview");
  });
  it("requires an explicit refresh after a provider-only revert conflict without losing the applied receipt", () => {
    const applied = catalogChange(ready(), {
      type: "apply",
      result: { status: "applied", receipt: receipt(), revision: "revision-2" },
    });
    const conflict = catalogChange(applied, { type: "require-refresh" });
    expect(conflict.needsRefresh).toBe(true);
    expect(conflict.receipt).toBe(applied.receipt);
    expect(catalogChange(conflict, { type: "begin", request: request({ operationId: "replacement" }) })).toBe(
      conflict,
    );
    const refreshed = catalogChange(conflict, { type: "refreshed" });
    expect(refreshed.needsRefresh).toBe(false);
    expect(refreshed.receipt).toBe(applied.receipt);
    expect(refreshed.request).toBe(applied.request);
  });
  it("rejects mismatched preview identities and blocks all targets for one incompatibility", () => {
    const input = request();
    const mismatch = ready(input, preview(request({ targetIds: ["unexpected-target"] })));
    expect(mismatch.phase).toBe("conflict");
    expect(() => catalogApplyBody(mismatch)).toThrow("Preview");
    const incompatible = preview();
    incompatible.rows[0].incompatibilities = [
      { code: "capability_unsupported", field: "model", message: "Model no longer exists" },
    ];
    expect(() => catalogApplyBody(ready(request(), incompatible))).toThrow("incompatible targets");
  });
});

describe("catalog manual workload and revert retry identity", () => {
  it("reuses an uncertain run identity despite a new proposed UUID and accepts new work only explicitly", () => {
    const input = { botId: "opaque/bot", routineId: "opaque:routine", requestId: "manual-workload-1" };
    const frozen = catalogRunRequest(undefined, input);
    input.requestId = "mutated-after-call";
    const state: CatalogRunState = {
      request: frozen,
      phase: "uncertain",
      error: "Network lost",
      runId: null,
    };
    expect(catalogRunRequest(state, { ...input, requestId: "tempting-retry-uuid" })).toBe(frozen);
    const done: CatalogRunState = { ...state, phase: "done", runId: "observed-run-id" };
    expect(() => catalogRunRequest(done, { ...input, requestId: "new-uuid" })).toThrow("Choose New run");
    expect(catalogRunRequest(done, { ...input, requestId: "new-uuid" }, true).requestId).toBe("new-uuid");
    expect(() => catalogRunRequest(done, frozen, true)).toThrow("new request identity");
  });
  it("never reuses one routine's workload for another opaque identity", () => {
    const input = { botId: "opaque/bot", routineId: "opaque:routine", requestId: "manual-workload-1" };
    const state: CatalogRunState = {
      request: { ...input },
      phase: "uncertain",
      error: "Network lost",
      runId: null,
    };
    expect(() => catalogRunRequest(state, { ...input, routineId: "other/routine" })).toThrow(
      "different routine",
    );
  });
  it("preserves original revision and operation ID through uncertain revert even after catalog refresh", () => {
    const original = catalogRevertRequest(INITIAL_CATALOG_REVERT, {
      operationId: "revert-1",
      revision: "r1",
      appliedOperationId: "apply-1",
    });
    const uncertain = { ...INITIAL_CATALOG_REVERT, request: original, phase: "uncertain" as const };
    const retried = catalogRevertRequest(uncertain, {
      operationId: "revert-2",
      revision: "r2",
      appliedOperationId: "apply-1",
    });
    expect(retried).toBe(original);
    expect(retried.revision).toBe("r1");
    const conflict = { ...uncertain, phase: "conflict" as const };
    expect(
      catalogRevertRequest(conflict, {
        operationId: "revert-3",
        revision: "r3",
        appliedOperationId: "apply-1",
      }),
    ).toEqual({ operationId: "revert-3", revision: "r3", appliedOperationId: "apply-1" });
  });
});
