import { EventEmitter, once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { autoStarter, withoutStart } from "../client/autoStart";
import type { Selection } from "../client/sidebar/types";

/** The selection state and an effect that offers it on every change, as SelectedChat does. */
function chatView(initial: Selection, start: (prompt: string) => Promise<void>) {
  let selection: Selection | null = initial;
  const errors: unknown[] = [];
  const offer = autoStarter({
    start: (request) => start(request.prompt),
    clear: (id) => {
      selection = withoutStart(selection, id);
    },
    onError: (error) => errors.push(error),
  });
  return {
    errors,
    get selection() {
      return selection;
    },
    select(next: Selection, ready = true) {
      selection = next;
      offer(next, ready);
    },
    render(ready = true) {
      if (selection) offer(selection, ready);
    },
  };
}

const setup = (id: string) => ({ botId: "bot-1", chatId: null, start: { id, prompt: "Set me up" } });

describe("starting a chat from the selection", () => {
  it("starts the setup chat once on a new-chat view that is already open, however often Start is pressed", async () => {
    const events = new EventEmitter();
    const prompts: string[] = [];
    const view = chatView({ botId: "bot-1", chatId: null }, async (prompt) => {
      prompts.push(prompt);
      await once(events, "started");
    });
    view.render();
    view.select(setup("a"));
    view.render();
    view.select(setup("b"));
    expect(prompts).toEqual(["Set me up"]);
    expect(view.selection).toEqual({ botId: "bot-1", chatId: null });
    events.emit("started");
    view.render();
    expect(prompts).toHaveLength(1);
  });

  it("waits for the host, reports a start that failed, and starts the next request", async () => {
    const prompts: string[] = [];
    const view = chatView({ botId: "bot-1", chatId: null }, async (prompt) => {
      prompts.push(prompt);
      if (prompts.length === 1) throw new Error("The host went away.");
    });
    view.select(setup("a"), false);
    expect(prompts).toEqual([]);
    view.render();
    await vi.waitFor(() => expect(view.errors).toEqual([new Error("The host went away.")]));
    view.select(setup("b"));
    expect(prompts).toEqual(["Set me up", "Set me up"]);
  });

  it("sends nothing for a chat that already exists", () => {
    const prompts: string[] = [];
    const view = chatView({ botId: "bot-1", chatId: "chat-1" }, async (prompt) => {
      prompts.push(prompt);
    });
    view.select({ botId: "bot-1", chatId: "chat-1", start: { id: "a", prompt: "Set me up" } });
    expect(prompts).toEqual([]);
  });
});
