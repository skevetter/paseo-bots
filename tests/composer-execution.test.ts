import { describe, expect, it } from "vitest";
import { type DeliveryTarget, deliverMessage } from "../client/chat/composer/delivery";
import { conversationKind, startsNewTask } from "../client/chat/composer/execution";
import type { BotHost } from "../client/data";
import { RUN_LABEL } from "../shared/managed-runs";

function conversation(isLocal = true) {
  const original = ["Private result from the earlier task"];
  const tasks: string[][] = [];
  const host = {
    api: {
      agents: {
        ref: (id: string) => ({
          send: async (text: string) => {
            if (id !== "existing") throw new Error("Wrong conversation");
            original.push(text);
          },
        }),
      },
    },
    isLocal,
  } as BotHost;
  const target: DeliveryTarget = {
    host,
    agentId: "existing",
    kind: "loading",
    sendBehavior: "steer",
    onStart: async (message) => {
      tasks.push([message.text]);
    },
  };
  return { original, tasks, target };
}

const message = { text: "Do the next task", attachments: [], messageId: "intent-next-task" };

describe("conversation execution boundaries", () => {
  it.each([undefined, "legacy", "managed"] as const)(
    "does not turn an existing legacy conversation into a task when future mode is %s",
    async (executionMode) => {
      const chat = conversation();
      chat.target.kind = conversationKind({
        agentId: "existing",
        agent: { id: "existing", labels: {} },
        agentReady: true,
        isLocal: true,
      });
      expect(startsNewTask(chat.target.kind, { executionMode }, true)).toBe(false);
      await deliverMessage(message, chat.target);
      expect(chat.original).toEqual(["Private result from the earlier task", "Do the next task"]);
      expect(chat.tasks).toEqual([]);
    },
  );

  it.each(["legacy", "managed"] as const)(
    "keeps a managed record isolated even when future bot execution is %s",
    async (executionMode) => {
      const chat = conversation();
      chat.target.kind = conversationKind({
        agentId: "existing",
        agent: { id: "existing", labels: { [RUN_LABEL]: "run-original" } },
        agentReady: true,
        isLocal: true,
      });
      expect(startsNewTask(chat.target.kind, { executionMode }, true)).toBe(true);
      await deliverMessage(message, chat.target);
      expect(chat.original).toEqual(["Private result from the earlier task"]);
      expect(chat.tasks).toEqual([["Do the next task"]]);
    },
  );

  it.each([
    { agent: null, agentReady: false },
    { agent: { id: "another", labels: {} }, agentReady: true },
    { agent: { id: "existing", labels: {} }, agentReady: false },
  ])("refuses mutation without loaded identity evidence: %j", async (evidence) => {
    const chat = conversation();
    chat.target.kind = conversationKind({ agentId: "existing", isLocal: true, ...evidence });
    await expect(deliverMessage(message, chat.target)).rejects.toThrow("unavailable");
    expect(chat.original).toEqual(["Private result from the earlier task"]);
    expect(chat.tasks).toEqual([]);
  });

  it("continues remote manual chats on their selected host, never through local task admission", async () => {
    const chat = conversation(false);
    chat.target.kind = conversationKind({
      agentId: "existing",
      agent: { id: "existing", labels: {} },
      agentReady: true,
      isLocal: false,
    });
    await deliverMessage(message, chat.target);
    expect(chat.original).toEqual(["Private result from the earlier task", "Do the next task"]);
    expect(chat.tasks).toEqual([]);
    expect(startsNewTask("new", { executionMode: "managed" }, false)).toBe(false);
  });

  it("does not interpret an empty run label as permission to bypass task admission", async () => {
    const chat = conversation();
    chat.target.kind = conversationKind({
      agentId: "existing",
      agent: { id: "existing", labels: { [RUN_LABEL]: "" } },
      agentReady: true,
      isLocal: true,
    });
    await deliverMessage(message, chat.target);
    expect(chat.original).toEqual(["Private result from the earlier task"]);
    expect(chat.tasks).toEqual([["Do the next task"]]);
  });

  it("does not treat an offline existing conversation as a request to create a new task", async () => {
    const chat = conversation();
    chat.target.kind = "legacy";
    chat.target.host = { ...chat.target.host, api: null };
    await expect(deliverMessage(message, chat.target)).rejects.toThrow("unavailable");
    expect(chat.original).toEqual(["Private result from the earlier task"]);
    expect(chat.tasks).toEqual([]);
  });
});
