import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { BotStateSchema, ImportedBotSchema, TeamFileTeamSchema } from "./bot";
import { OPERATION_ID } from "./changes/ids";

export const importsApplyRpc = defineRpc({
  name: "bots.imports.apply",
  input: z.object({
    operationId: z.string().regex(OPERATION_ID),
    revision: z.string(),
    bots: z.array(ImportedBotSchema).min(1).max(50),
    teams: z.array(TeamFileTeamSchema).max(50),
  }),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("saved"), revision: z.string(), values: BotStateSchema }),
    z.object({ status: z.literal("conflict"), error: z.string() }),
  ]),
});
