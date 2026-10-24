import { describe, expect, it } from "vitest";
import { type DeliveryTarget, deliverMessage } from "../client/chat/composer/delivery";
import {
  enqueue,
  parseDrafts,
  restoreFailedSend,
  serializeDrafts,
  takeQueued,
} from "../client/chat/composer/logic";
import { editDraft, submitDraft } from "../client/chat/composer/submission";
import type { BotHost } from "../client/data";
import type { ComposerAttachment } from "../shared/attachments";

function lostReply() {
  const effects = new Map<string, string>();
  let loseReply = true;
  const target: DeliveryTarget = {
    agentId: "old-managed-record",
    kind: "managed",
    host: { api: {} } as BotHost,
    sendBehavior: "steer",
    onStart: async (message) => {
      const body = JSON.stringify([message.text, message.images, message.attachments]);
      const previous = effects.get(message.messageId);
      if (previous !== undefined && previous !== body) throw new Error("Request conflict");
      effects.set(message.messageId, body);
      if (loseReply) {
        loseReply = false;
        throw new Error("Transport closed after task creation");
      }
    },
  };
  return { effects, target };
}

const empty = { text: "", attachments: [] };
const image: ComposerAttachment = {
  kind: "image",
  id: "image",
  name: "input.png",
  mimeType: "image/png",
  size: 4,
  data: "AAAA",
};

describe("submission replay identity", () => {
  it("replays a failed queued submission using its retained queue identity", async () => {
    const host = lostReply();
    const first = submitDraft({ text: "Queued task", attachments: [] });
    const queued = { id: first.messageId, text: first.text, attachments: first.attachments };
    const attempt = takeQueued(enqueue([], queued), queued.id).item;
    if (!attempt) throw new Error("Missing queued submission");
    await expect(deliverMessage({ ...attempt, messageId: attempt.id }, host.target)).rejects.toThrow(
      "after task creation",
    );
    const retry = takeQueued(enqueue([], attempt), attempt.id).item;
    if (!retry) throw new Error("Missing requeued submission");
    await deliverMessage({ ...retry, messageId: retry.id }, host.target);
    expect([...host.effects.keys()]).toEqual([first.messageId]);
    expect(host.effects.get(first.messageId)).toBe(JSON.stringify(["Queued task", [], []]));
  });

  it("assigns different requests to edited text, changed attachments and deliberate repeated messages", async () => {
    const host = lostReply();
    const first = submitDraft({ text: "Publish the report", attachments: [] });
    await expect(deliverMessage(first, host.target)).rejects.toThrow("after task creation");
    const restored = restoreFailedSend(first, empty);
    const edited = submitDraft(editDraft(restored, { text: "Publish the corrected report" }));
    const attached = submitDraft(editDraft(restored, { attachments: [image] }));
    const deliberate = submitDraft({ text: first.text, attachments: [] });
    await deliverMessage(edited, host.target);
    await deliverMessage(attached, host.target);
    await deliverMessage(deliberate, host.target);
    expect([...host.effects.keys()]).toEqual([
      first.messageId,
      edited.messageId,
      attached.messageId,
      deliberate.messageId,
    ]);
    expect(host.effects.get(edited.messageId)).toBe(JSON.stringify(["Publish the corrected report", [], []]));
    expect(host.effects.get(attached.messageId)).toBe(
      JSON.stringify(["Publish the report", [{ data: "AAAA", mimeType: "image/png" }], []]),
    );
  });

  it("preserves concurrent V2 edits without reusing V1's admitted request identity", async () => {
    const host = lostReply();
    const first = submitDraft({ text: "First task", attachments: [] });
    await expect(deliverMessage(first, host.target)).rejects.toThrow("after task creation");
    const concurrent = editDraft(empty, { text: "V2 typed while waiting", attachments: [image] });
    const restored = restoreFailedSend(first, concurrent);
    const next = submitDraft(restored);
    await deliverMessage(next, host.target);
    expect(next.messageId).not.toBe(first.messageId);
    expect(next.text).toBe("First task\nV2 typed while waiting");
    expect(next.attachments).toEqual([image]);
    expect(host.effects.get(first.messageId)).toBe(JSON.stringify(["First task", [], []]));
    expect([...host.effects.keys()]).toEqual([first.messageId, next.messageId]);
  });

  it("invalidates replay identity when storage pressure removes attachments", () => {
    const first = submitDraft({ text: "Keep the task", attachments: [{ ...image, data: "A".repeat(5000) }] });
    const persisted = parseDrafts(
      serializeDrafts({ draft: { ...first, updatedAt: 1 } }, { maxBytes: 1000 }),
    ).draft;
    if (!persisted) throw new Error("Missing retained text draft");
    const next = submitDraft(persisted);
    expect(next.attachments).toEqual([]);
    expect(next.messageId).not.toBe(first.messageId);
  });
});
