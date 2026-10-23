import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchPreparedChat, prepareChat, refreshPreparedChat } from "../server/chats";
import { memoryFilePath } from "../server/memory";
import { Relay } from "../server/relay";
import type { PreparedBotChat } from "../shared/chat";
import { budgetMemory } from "../shared/memory-budget";
import { connectFakeDaemon, type FakeDaemon } from "./fake-daemon";
import { defined, fakeHost, makeBot, useTempPaseoHome } from "./helpers";

const AGENT_ID = "6f1c2a52-9d3e-4c0a-8b7e-3d2f5a1b9c10";

const ADMITTED_PLAYBOOK = {
  id: "pb-report",
  name: "Report",
  triggers: ["report"],
  instructions: "Use admitted procedure.",
};

describe("managed chat admission and cold relay recovery", () => {
  useTempPaseoHome("paseo-managed-launch-");
  let daemon: FakeDaemon;
  const relays: Relay[] = [];
  afterEach(async () => {
    for (const relay of relays.splice(0)) await relay.stop();
    await daemon.close();
  });

  it("keeps the admitted memory receipt and prompt after memory, policy and host defaults change", async () => {
    daemon = await connectFakeDaemon({ creationLifecycle: true, agentRequestReceipts: true });
    const bot = makeBot({
      cwd: "/work",
      contactBots: "off",
      playbooks: [ADMITTED_PLAYBOOK],
    });
    const host = fakeHost([bot]);
    host.attach(daemon.api);
    const relay = new Relay(host, []);
    relays.push(relay);
    const path = memoryFilePath(bot.id, "MEMORY.md");
    const memory = `${"Remember this.\n".repeat(210)}  `;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, memory);
    const prepared = await prepareChat(host, relay, bot, {
      agentId: AGENT_ID,
      idempotencyKey: "exe-admitted",
      prompt: "report",
      labels: {},
      inputArtifactRefs: ["artifact-input"],
      environmentVersion: "env-v1",
    });
    const included = budgetMemory(memory);
    expect(prepared.metadata.memoryContextReceipt).toMatchObject({
      backend: "files",
      contentHash: createHash("sha256").update(included.text.trim()).digest("hex"),
      stats: { includedLines: 200, totalLines: included.totalLines, truncation: "lines" },
    });
    expect(prepared.metadata.systemPromptHash).toBe(
      createHash("sha256").update(prepared.config.systemPrompt).digest("hex"),
    );
    expect(prepared.metadata.userPromptHash).toBe(createHash("sha256").update("report").digest("hex"));
    expect(prepared.metadata.playbooks).toEqual([
      {
        id: "pb-report",
        contentHash: createHash("sha256")
          .update(JSON.stringify(defined(bot.playbooks[0])))
          .digest("hex"),
      },
    ]);
    const cold: PreparedBotChat = JSON.parse(JSON.stringify(prepared));
    await relay.stop();
    await writeFile(path, "Changed memory must not be injected.");
    bot.soul = "Changed instructions must not be injected.";
    bot.modeId = "bypassPermissions";
    bot.playbooks = [];
    bot.contactBots = "allow";
    daemon.setProviders([
      {
        provider: "claude",
        enabled: true,
        status: "ready",
        defaultModeId: "bypassPermissions",
        models: [{ id: "new-default", label: "Changed", isDefault: true }],
      },
    ]);
    const recoveredRelay = new Relay(host, []);
    relays.push(recoveredRelay);
    const rebound = await refreshPreparedChat(recoveredRelay, cold);
    expect(rebound.metadata).toEqual(prepared.metadata);
    expect(rebound.config.toolPolicy).toEqual(prepared.config.toolPolicy);
    expect(rebound.config.systemPrompt).toBe(prepared.config.systemPrompt);
    expect(await launchPreparedChat(host, recoveredRelay, rebound)).toBe(AGENT_ID);
    const request = defined(daemon.sent.find((frame) => frame.type === "agent.create.request"));
    expect(request.config).toMatchObject({
      provider: "claude",
      model: "claude-sonnet-5-5",
      modeId: "default",
      systemPrompt: prepared.config.systemPrompt,
    });
    expect(JSON.stringify(request)).not.toContain("Changed memory");
    expect(JSON.stringify(request)).not.toContain("Changed instructions");
    const privateTools = defined(rebound.config.mcpServers?.bots);
    const publicMetadata = JSON.stringify(rebound.metadata);
    if (privateTools.type !== "http") throw new Error("Expected a private HTTP relay mount");
    expect(publicMetadata).not.toContain(privateTools.url);
    expect(publicMetadata).not.toContain(defined(privateTools.headers.Authorization));
    expect(publicMetadata).not.toContain(included.text.trim());
  });
});
