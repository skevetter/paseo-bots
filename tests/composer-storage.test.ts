import * as React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComposerDraftState } from "../client/chat/composer/draftState";
import { restoreFailedSend } from "../client/chat/composer/logic";
import { editDraft, submitDraft } from "../client/chat/composer/submission";

const stored = new Map<string, string>();
const roots: ReactTestRenderer[] = [];
const nativeStorage = {
  multiGet: (keys: string[], done: (errors: null, pairs: [string, string | null][]) => void) =>
    done(
      null,
      keys.map((key) => [key, stored.get(key) ?? null]),
    ),
  multiSet: (pairs: [string, string][], done: (errors: null) => void) => {
    for (const [key, value] of pairs) stored.set(key, value);
    done(null);
  },
};

afterEach(async () => {
  for (const root of roots.splice(0)) await act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  stored.clear();
});

describe.each(["web", "ios"])("production composer storage on %s", (platform) => {
  it("keeps an admitted request through restoration, memory remount and persisted reload", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.doMock("react", () => React);
    vi.doMock("react-native", () => ({
      Platform: { OS: platform },
      NativeModules: { RNCAsyncStorage: nativeStorage },
      TurboModuleRegistry: { get: () => nativeStorage },
    }));
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    });
    // Fresh module instances exercise platform initialization and persisted reload, not a serializer echo.
    vi.resetModules();
    const store = await import("../client/chat/composer/drafts");
    await store.loadDrafts();
    const { useComposerDraft } = await import("../client/chat/composer/draftState");
    const composer: { current: ComposerDraftState | null } = { current: null };
    function Composer() {
      composer.current = useComposerDraft("task");
      return null;
    }
    const mount = async () => {
      const renderer: { current: ReactTestRenderer | null } = { current: null };
      await act(() => {
        renderer.current = create(React.createElement(Composer));
      });
      if (!renderer.current) throw new Error("Composer did not mount");
      roots.push(renderer.current);
      return renderer.current;
    };
    const initial = await mount();
    const first = submitDraft({ text: "Publish the report", attachments: [] });
    const restored = restoreFailedSend(first, { text: "", attachments: [] });
    await act(() => {
      if (!composer.current) throw new Error("Missing mounted composer");
      composer.current.replace(restored);
    });
    await act(() => initial.unmount());
    const remounted = await mount();
    if (!composer.current) throw new Error("Missing remounted composer");
    expect(submitDraft(composer.current.latest.current).messageId).toBe(first.messageId);
    await act(() => remounted.unmount());
    expect(submitDraft(store.getDraft("task") ?? { text: "", attachments: [] }).messageId).toBe(
      first.messageId,
    );
    await vi.advanceTimersByTimeAsync(200);
    vi.resetModules();
    const reloaded = await import("../client/chat/composer/drafts");
    await reloaded.loadDrafts();
    const draft = reloaded.getDraft("task");
    if (!draft) throw new Error("Missing restored draft after reload");
    const retry = submitDraft(editDraft(draft, { text: draft.text }));
    expect(retry.messageId).toBe(first.messageId);
    expect(submitDraft(editDraft(draft, { text: "Publish the corrected report" })).messageId).not.toBe(
      first.messageId,
    );
    expect(submitDraft({ text: draft.text, attachments: [] }).messageId).not.toBe(first.messageId);
  });
});
