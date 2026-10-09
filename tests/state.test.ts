import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { environmentManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { mergeSnapshot, showSaved, stateQuery } from "../client/state-query";
import { pluginDataPath } from "../server/bot-home";
import { BotStore } from "../server/state";
import type { BotState, StateSnapshot } from "../shared/bot";
import { defined, makeBot, useTempPaseoHome } from "./helpers";

let file = 0;
function newStore(): BotStore {
  return new BotStore(join(pluginDataPath(), `state-${++file}.json`));
}

const withBot =
  (id: string) =>
  (values: BotState): BotState => ({ ...values, bots: [...values.bots, makeBot({ id })] });

describe("BotStore", () => {
  useTempPaseoHome("paseo-bots-state-");

  it("starts empty and saves only over the revision it read", async () => {
    const store = newStore();
    const first = await store.read();
    expect(first.values.bots).toEqual([]);
    const saved = await store.write(first.revision, withBot("a")(first.values));
    expect(saved.status).toBe("saved");
    const stale = await store.write(first.revision, withBot("b")(first.values));
    expect(stale.status).toBe("conflict");
    expect((await store.read()).values.bots.map((bot) => bot.id)).toEqual(["a"]);
  });

  it("keeps every change when the app and the control server write at once", async () => {
    const store = newStore();
    const opened = await store.read();
    const control = Array.from({ length: 10 }, (_, index) => store.update(withBot(`c-${index}`)));
    const app = store.write(opened.revision, withBot("ui")(opened.values));
    await Promise.all(control);
    expect((await app).status).toBe("conflict");
    const current = await store.read();
    expect((await store.write(current.revision, withBot("ui")(current.values))).status).toBe("saved");
    const ids = (await store.read()).values.bots.map((bot) => bot.id).sort();
    expect(ids).toEqual([...Array.from({ length: 10 }, (_, index) => `c-${index}`), "ui"].sort());
  });

  it("sets a broken file aside and starts fresh", async () => {
    const store = newStore();
    await writeFile(store.path, "{ not json");
    expect((await store.read()).values.bots).toEqual([]);
    const names = await readdir(pluginDataPath());
    expect(names.some((name) => name.startsWith(`state-${file}.json.corrupt-`))).toBe(true);
  });
});

describe("the app's state query", () => {
  useTempPaseoHome("paseo-bots-state-");
  it("picks up a change made outside the app on the next poll", async () => {
    environmentManager.setIsServer(() => false);
    const store = newStore();
    const client = new QueryClient();
    const observer = new QueryObserver(client, { ...stateQuery(() => store.read()), refetchInterval: 20 });
    const seen: string[][] = [];
    const stop = observer.subscribe((result) => {
      if (result.data) seen.push(result.data.values.bots.map((bot) => bot.id));
    });
    await vi.waitFor(() => expect(seen.at(-1)).toEqual([]));
    await store.update(withBot("from-control"));
    await vi.waitFor(() => expect(seen.at(-1)).toEqual(["from-control"]));
    stop();
    client.clear();
    environmentManager.setIsServer(() => true);
  });

  it("keeps the same object while the revision holds, and unchanged bots by identity", async () => {
    const store = newStore();
    await store.update(withBot("a"));
    const first = await store.read();
    expect(mergeSnapshot(first, await store.read())).toBe(first);
    await store.update(withBot("b"));
    const merged = mergeSnapshot(first, await store.read());
    expect(merged.values.bots[0]).toBe(first.values.bots[0]);
    expect(merged.values.bots.map((bot) => bot.id)).toEqual(["a", "b"]);
  });

  it("shows a saved snapshot over a poll that was under way", async () => {
    const store = newStore();
    const client = new QueryClient();
    let release: () => void = () => {};
    const slow = async () => {
      const before = await store.read();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return before;
    };
    const options = stateQuery(slow);
    const polling = client.fetchQuery(options).catch(() => null);
    const saved = await store.update(withBot("saved"));
    await showSaved(client, saved);
    release();
    await polling;
    const shown = defined(client.getQueryData<StateSnapshot>(options.queryKey));
    expect(shown.values.bots.map((bot) => bot.id)).toEqual(["saved"]);
    client.clear();
  });
});
