import { describe, expect, it } from "vitest";
import { applyPreview, bulkState, freezeRequest, INITIAL_BULK_STATE } from "../client/fleet/bulk-state";
import type { FleetPreview, FleetReceipt } from "../shared/fleet";
import { resolveBot } from "../shared/policies";
import { makeBot } from "./helpers";

function preview(): FleetPreview {
  const before = makeBot({ id: "opaque:a/1", provider: "source" });
  const after = { ...before, provider: "target", model: null };
  return {
    request: freezeRequest({
      operationId: "bulk-fixed",
      revision: "revision-before",
      botIds: [before.id],
      patch: { provider: "target", model: null },
      unset: [],
    }),
    digest: "digest-from-preview",
    compatible: true,
    warnings: [],
    activeChatsUnaffected: true,
    rows: [
      {
        botId: before.id,
        name: before.name,
        before,
        after,
        beforeResolution: resolveBot({}, before),
        afterResolution: resolveBot({}, after),
        incompatibilities: [],
      },
    ],
  };
}

function previewed(value = preview()) {
  return bulkState(INITIAL_BULK_STATE, {
    type: "preview",
    generation: 0,
    result: { status: "previewed", preview: value },
  });
}

describe("bulk preview boundary", () => {
  it("does not change targets or explicit null when the operator's selection and form mutate", () => {
    const input = {
      operationId: "bulk-copy",
      revision: "r1",
      botIds: ["exact:1", "exact:2"],
      patch: { model: null as string | null },
      unset: [],
    };
    const request = freezeRequest(input);
    input.botIds.splice(0, 1, "different:3");
    input.patch.model = "different-model";
    const value = preview();
    value.request = request;
    const apply = applyPreview(previewed(value));
    expect(apply.request.botIds).toEqual(["exact:1", "exact:2"]);
    expect(apply.request.patch).toEqual({ model: null });
    expect(apply.request.operationId).toBe("bulk-copy");
    expect(apply.previewDigest).toBe(value.digest);
  });

  it("invalidates a preview on any edit and discards its later in-flight result", () => {
    const initial = previewed();
    const edited = bulkState(initial, { type: "edit" });
    expect(() => applyPreview(edited)).toThrow("Preview");
    const late = bulkState(edited, {
      type: "preview",
      generation: 0,
      result: { status: "previewed", preview: preview() },
    });
    expect(late.preview).toBeNull();
    expect(late.generation).toBe(1);
    const newPreview = preview();
    newPreview.request.patch = { model: "explicit-after-edit" };
    const current = bulkState(late, {
      type: "preview",
      generation: 1,
      result: { status: "previewed", preview: newPreview },
    });
    expect(applyPreview(current).request.patch).toEqual({ model: "explicit-after-edit" });
  });

  it("retains a stale preview as evidence but refuses reapply until explicit re-preview", () => {
    const ready = previewed();
    const conflict = bulkState(ready, {
      type: "apply",
      result: { status: "conflict", error: "State revision changed." },
    });
    expect(conflict.preview).toBe(ready.preview);
    expect(conflict.error).toContain("State revision changed.");
    expect(conflict.error).toContain("explicitly preview again");
    expect(() => applyPreview(conflict)).toThrow("Preview");
    const refreshed = preview();
    refreshed.request.revision = "new-reviewed-revision";
    const reviewed = bulkState(conflict, {
      type: "preview",
      generation: 0,
      result: { status: "previewed", preview: refreshed },
    });
    expect(applyPreview(reviewed).request.revision).toBe("new-reviewed-revision");
  });

  it("preserves exact operation identity for explicit retry after an uncertain transport error", () => {
    const ready = previewed();
    const before = applyPreview(ready);
    const uncertain = bulkState(ready, { type: "error", error: "Connection closed; retry same preview." });
    expect(applyPreview(uncertain)).toEqual(before);
  });
});

describe("bulk all-or-nothing guards", () => {
  it("blocks every target when one provider cannot preserve approval semantics", () => {
    const value = preview();
    value.compatible = false;
    value.rows[0].incompatibilities = [
      { code: "approval_unverifiable", field: "provider", message: "Target approval semantics are unknown." },
    ];
    const state = previewed(value);
    expect(state.preview?.rows[0].incompatibilities).toEqual([
      { code: "approval_unverifiable", field: "provider", message: "Target approval semantics are unknown." },
    ]);
    expect(() => applyPreview(state)).toThrow("Incompatible targets");
  });

  it("also blocks inconsistent compatible results containing a field incompatibility", () => {
    const value = preview();
    value.rows[0].incompatibilities = [
      { code: "grants_not_preserved", field: "allowedTools", message: "Cannot retain grants." },
    ];
    expect(() => applyPreview(previewed(value))).toThrow("Incompatible targets");
  });

  it("rejects overlapping inherited provider and explicit dependent model overrides", () => {
    expect(() =>
      freezeRequest({
        operationId: "overlap",
        revision: "r",
        botIds: ["bot"],
        patch: { model: "explicit" },
        unset: ["provider"],
      }),
    ).toThrow("both overridden and inherited");
  });

  it("shows preview conflict without fabricating a replacement preview", () => {
    const state = bulkState(previewed(), {
      type: "preview",
      generation: 0,
      result: { status: "conflict", error: "Provider changed." },
    });
    expect(state.preview).toBeNull();
    expect(state.error).toBe("Provider changed.");
    expect(() => applyPreview(state)).toThrow("Preview");
  });

  it("keeps the server receipt and disallows applying an already applied preview", () => {
    const receipt: FleetReceipt = {
      operationId: "bulk-fixed",
      kind: "fleet.apply",
      bodyHash: "body",
      appliedAt: "2026-10-23T00:00:00Z",
      created: [],
      createdCount: 0,
      notes: [],
      originalRevision: "revision-before",
      newRevision: "revision-after",
    };
    const state = bulkState(previewed(), {
      type: "apply",
      result: { status: "replayed", receipt, revision: "revision-current" },
    });
    expect(state.receipt).toEqual(receipt);
    expect(state.preview).toBeNull();
    expect(() => applyPreview(state)).toThrow("Preview");
  });
});
