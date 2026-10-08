import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { botDataPath } from "../server/bot-home";
import { exportBot, importBot } from "../server/share";
import { EMPTY_LIBRARY } from "../shared/bot";
import { makeBot, useTempPaseoHome } from "./helpers";

const ExportFiles = z.object({ files: z.record(z.string(), z.string()) });

describe("share", () => {
  useTempPaseoHome("paseo-bots-share-");

  describe("exportBot with memory", () => {
    it("exports MEMORY.md and memory/ despite broken links in the bot folder", async () => {
      const root = botDataPath("bot-mem");
      await mkdir(join(root, "memory", "notes"), { recursive: true });
      await mkdir(join(root, "skills"), { recursive: true });
      await writeFile(join(root, "MEMORY.md"), "# Memory");
      await writeFile(join(root, "memory", "people.md"), "Ada");
      await writeFile(join(root, "memory", "notes", "today.md"), "Shipped");
      await writeFile(join(root, "scratch.txt"), "not memory");
      await symlink(join(root, "missing-skill"), join(root, "skills", "gone"));
      await symlink(join(root, "loop-b"), join(root, "loop-a"));
      await symlink(join(root, "loop-a"), join(root, "loop-b"));
      await symlink(join(root, "missing-note"), join(root, "memory", "gone.md"));

      const { json } = await exportBot(
        { bot: makeBot({ id: "bot-mem" }), includeMemory: true },
        EMPTY_LIBRARY,
      );

      expect(ExportFiles.parse(JSON.parse(json)).files).toEqual({
        "MEMORY.md": "# Memory",
        "memory/people.md": "Ada",
        "memory/notes/today.md": "Shipped",
      });
    });

    it("exports no memory files when the bot has none", async () => {
      const { json } = await exportBot(
        { bot: makeBot({ id: "bot-blank" }), includeMemory: true },
        EMPTY_LIBRARY,
      );
      expect(ExportFiles.parse(JSON.parse(json)).files).toEqual({});
    });
  });

  describe("importBot", () => {
    it("starts an imported bot on the provider's default mode", async () => {
      const { json } = await exportBot(
        { bot: makeBot({ id: "bot-src", modeId: "bypassPermissions" }), includeMemory: false },
        EMPTY_LIBRARY,
      );
      const imported = await importBot({ botId: "bot-imported", json });
      expect(imported.bot.modeId).toBeNull();
    });
  });
});
