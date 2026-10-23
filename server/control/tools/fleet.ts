import {
  FleetChangeRequestSchema,
  type FleetPreviewRow,
  fleetApplyRpc,
  fleetListRpc,
  fleetRevertRpc,
} from "../../../shared/fleet";
import { applyFleetChange, listFleet, previewFleetChange, revertFleetChange } from "../../fleet";
import {
  APPROVAL_PLACE,
  type ControlContext,
  type ControlTool,
  defineControlTool,
  needsApproval,
  result,
} from "../tool";

async function authorize(context: ControlContext, rows: readonly FleetPreviewRow[]): Promise<void> {
  const changed = rows.some(
    (row) => row.beforeResolution.provider.value !== row.afterResolution.provider.value,
  );
  if (await needsApproval(context, changed ? ["Bulk provider changes require operator approval."] : []))
    throw new Error(`Apply this change in Paseo, or enable elevated changes under ${APPROVAL_PLACE}.`);
}

export const FLEET_TOOLS: readonly ControlTool[] = [
  defineControlTool({
    name: "fleet_list",
    annotations: { readOnlyHint: true },
    description:
      "List exact bot IDs, effective settings and sources, outcomes and active work. Missing work or usage remains unavailable, never zero.",
    input: fleetListRpc.input,
    async run(_input, context) {
      const data = await listFleet(context.host, (await context.scheduler.status()).routines);
      return result(`${data.rows.length} bots. Spend is unavailable.`, data);
    },
  }),
  defineControlTool({
    name: "fleet_preview_change",
    annotations: { readOnlyHint: true },
    description:
      "Preview one atomic future-settings change for exact bot IDs (maximum 500). Keep this request and digest for apply; active chats are unaffected.",
    input: FleetChangeRequestSchema,
    async run(input, context) {
      const data = await previewFleetChange(context.host, input);
      return result(
        data.status === "conflict" ? data.error : "Preview ready. Inspect incompatibilities before applying.",
        data,
      );
    },
  }),
  defineControlTool({
    name: "fleet_apply_change",
    description:
      "Apply exactly a previewed fleet change, all-or-nothing. Effective provider changes need the elevated-changes setting or approval in Paseo. Does not mutate live sessions.",
    input: fleetApplyRpc.input,
    async run(input, context) {
      const data = await applyFleetChange(context.host, input, (rows) => authorize(context, rows));
      return result(data.status === "conflict" ? data.error : `Fleet change ${data.status}.`, data);
    },
  }),
  defineControlTool({
    name: "fleet_revert_change",
    description:
      "Revert an audited fleet change as a new operation. Refuses later edits to affected bots; keeps unrelated changes. Effective provider changes require approval in Paseo or elevated changes.",
    input: fleetRevertRpc.input,
    async run(input, context) {
      const data = await revertFleetChange(context.host, input, (rows) => authorize(context, rows));
      return result(data.status === "conflict" ? data.error : `Fleet revert ${data.status}.`, data);
    },
  }),
];
