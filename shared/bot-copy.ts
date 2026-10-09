import { randomSeed } from "./avatar";
import type { Bot } from "./bot";

/** Same library items and permissions as the original; the imported copy only carries redacted server settings. */
export function duplicateOf(original: Bot, imported: Bot): Bot {
  return {
    ...imported,
    name: `${original.name} copy`,
    hostId: original.hostId,
    cwd: original.cwd,
    modeId: original.modeId,
    alwaysAllow: original.alwaysAllow,
    skillIds: original.skillIds,
    mcpServerIds: original.mcpServerIds,
    avatar: { ...original.avatar, seed: randomSeed() },
  };
}
