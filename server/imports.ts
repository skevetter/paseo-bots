import type { RpcInput } from "@getpaseo/plugin";
import { changeIds } from "../shared/changes/ids";
import { OperationConflictError } from "../shared/changes/operation";
import type { importsApplyRpc } from "../shared/imports";
import { addImportedBots } from "../shared/library";
import { newOperation } from "./operations";
import type { BotStore, StateWrite } from "./state";

class ImportConflict extends Error {}

export async function applyImportedBots(
  store: Pick<BotStore, "apply">,
  input: RpcInput<typeof importsApplyRpc>,
): Promise<StateWrite> {
  const operation = newOperation({ id: input.operationId, kind: "import", body: input });
  try {
    const result = await store.apply(operation, (values, scope) => {
      if (scope.revision !== input.revision)
        throw new ImportConflict(
          "Bots changed since this import was prepared. Reload before importing again.",
        );
      const ids = new Set(values.bots.map((bot) => bot.id));
      for (const { bot } of input.bots) {
        if (ids.has(bot.id))
          throw new ImportConflict(`Bot ${bot.id} already exists in this import or on this host.`);
        ids.add(bot.id);
      }
      return {
        values: addImportedBots(values, input.bots, input.teams, {
          now: scope.now,
          ids: changeIds(scope.operationId, 0),
        }),
      };
    });
    return { status: "saved", ...result.snapshot };
  } catch (error) {
    if (error instanceof ImportConflict || error instanceof OperationConflictError)
      return { status: "conflict", error: error.message };
    throw error;
  }
}
