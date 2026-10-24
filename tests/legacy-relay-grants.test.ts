import { createHash } from "node:crypto";
import { chmod, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pluginDataPath } from "../server/bot-home";
import {
  type LegacyRelayGrant,
  LegacyRelayGrantError,
  publishLegacyRelayGrant,
  readLegacyRelayGrant,
} from "../server/legacy-relay-grants";
import { useTempPaseoHome } from "./helpers";

const grant = (agentId: string, overrides: Partial<LegacyRelayGrant> = {}): LegacyRelayGrant => ({
  botId: "bot-one",
  agentId,
  frozen: { tools: true, apps: false },
  permissions: { contactBots: "ask", apps: [], appLimits: {} },
  ...overrides,
});

const receiptFile = (agentId: string) =>
  join(pluginDataPath(), "legacy-relay-grants", `${createHash("sha256").update(agentId).digest("hex")}.json`);

describe("legacy relay grant receipts", () => {
  useTempPaseoHome("legacy-relay-grants-");

  it("replays an exact grant and reads it back unchanged", async () => {
    const original = grant("agent-replay");
    await publishLegacyRelayGrant(original);
    await publishLegacyRelayGrant(original);
    expect(await readLegacyRelayGrant("agent-replay")).toEqual(original);
  });

  it("refuses a conflicting grant for the same agent and leaves the original bytes untouched", async () => {
    await publishLegacyRelayGrant(grant("agent-conflict"));
    const before = await readFile(receiptFile("agent-conflict"), "utf8");
    const conflicting = grant("agent-conflict", {
      permissions: { contactBots: "allow", apps: [], appLimits: {} },
    });
    await expect(publishLegacyRelayGrant(conflicting)).rejects.toThrow(LegacyRelayGrantError);
    expect(await readFile(receiptFile("agent-conflict"), "utf8")).toBe(before);
  });

  it("returns null for an absent receipt and for an invalid agent id", async () => {
    expect(await readLegacyRelayGrant("agent-absent")).toBeNull();
    expect(await readLegacyRelayGrant("Bad/Id")).toBeNull();
  });

  it("fails closed on a checksum-tampered receipt", async () => {
    await publishLegacyRelayGrant(grant("agent-tamper"));
    const text = await readFile(receiptFile("agent-tamper"), "utf8");
    await writeFile(receiptFile("agent-tamper"), text.replace('"ask"', '"allow"'));
    await expect(readLegacyRelayGrant("agent-tamper")).rejects.toThrow(LegacyRelayGrantError);
  });

  it("fails closed on a receipt that names another agent", async () => {
    await publishLegacyRelayGrant(grant("agent-owner"));
    await publishLegacyRelayGrant(grant("agent-other"));
    await writeFile(receiptFile("agent-other"), await readFile(receiptFile("agent-owner"), "utf8"));
    await chmod(receiptFile("agent-other"), 0o600);
    await expect(readLegacyRelayGrant("agent-other")).rejects.toThrow(LegacyRelayGrantError);
  });

  it("fails closed on an oversized receipt", async () => {
    await publishLegacyRelayGrant(grant("agent-oversize"));
    await writeFile(receiptFile("agent-oversize"), "x".repeat(64 * 1024 + 1));
    await chmod(receiptFile("agent-oversize"), 0o600);
    await expect(readLegacyRelayGrant("agent-oversize")).rejects.toThrow(LegacyRelayGrantError);
  });

  it("fails closed on a receipt readable by other users", async () => {
    await publishLegacyRelayGrant(grant("agent-mode"));
    await chmod(receiptFile("agent-mode"), 0o644);
    await expect(readLegacyRelayGrant("agent-mode")).rejects.toThrow(LegacyRelayGrantError);
    await expect(publishLegacyRelayGrant(grant("agent-mode"))).rejects.toThrow(LegacyRelayGrantError);
  });

  it("fails closed on a symlinked receipt", async () => {
    await publishLegacyRelayGrant(grant("agent-link-target"));
    await publishLegacyRelayGrant(grant("agent-link"));
    await rm(receiptFile("agent-link"));
    await symlink(receiptFile("agent-link-target"), receiptFile("agent-link"));
    await expect(readLegacyRelayGrant("agent-link")).rejects.toThrow(LegacyRelayGrantError);
  });
});

describe("legacy relay grant publication boundaries", () => {
  useTempPaseoHome("legacy-relay-grant-boundaries-");

  it("refuses a grant that cannot be read after restart without publishing a receipt", async () => {
    const original = grant("agent-write-oversize", {
      permissions: { contactBots: "ask", apps: ["x".repeat(64 * 1024)], appLimits: {} },
    });
    await expect(publishLegacyRelayGrant(original)).rejects.toThrow(LegacyRelayGrantError);
    expect(await readLegacyRelayGrant(original.agentId)).toBeNull();
  });

  it("refuses an unsupported receipt version even with an intact checksum", async () => {
    await publishLegacyRelayGrant(grant("agent-future"));
    const file = JSON.parse(await readFile(receiptFile("agent-future"), "utf8"));
    file.body.version = 2;
    file.checksum = createHash("sha256").update(JSON.stringify(file.body)).digest("hex");
    await writeFile(receiptFile("agent-future"), JSON.stringify(file));
    await expect(readLegacyRelayGrant("agent-future")).rejects.toThrow(LegacyRelayGrantError);
  });

  it("refuses a namespace readable by other users without repairing it", async () => {
    const original = grant("agent-directory");
    await publishLegacyRelayGrant(original);
    const directory = join(pluginDataPath(), "legacy-relay-grants");
    await chmod(directory, 0o755);
    try {
      await expect(readLegacyRelayGrant(original.agentId)).rejects.toThrow(LegacyRelayGrantError);
      await expect(publishLegacyRelayGrant(original)).rejects.toThrow(LegacyRelayGrantError);
    } finally {
      await chmod(directory, 0o700);
    }
  });

  it("refuses a symlinked namespace rather than reading or publishing through it", async () => {
    const original = grant("agent-directory-link");
    await publishLegacyRelayGrant(original);
    const directory = join(pluginDataPath(), "legacy-relay-grants");
    await rename(directory, `${directory}-original`);
    try {
      await symlink(`${directory}-original`, directory);
      await expect(readLegacyRelayGrant(original.agentId)).rejects.toThrow(LegacyRelayGrantError);
      await expect(publishLegacyRelayGrant(original)).rejects.toThrow(LegacyRelayGrantError);
    } finally {
      await rm(directory, { force: true });
      await rename(`${directory}-original`, directory);
    }
  });
});
