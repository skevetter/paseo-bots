import type { FleetRow } from "../../shared/fleet";
import { INHERITABLE } from "../../shared/policies";

export interface FleetFilters {
  team: string;
  provider: string;
  model: string;
  policy: string;
  status: string;
  exceptions: boolean;
}

export const EMPTY_FILTERS: FleetFilters = {
  team: "",
  provider: "",
  model: "",
  policy: "",
  status: "",
  exceptions: false,
};

function matchesValue(filter: string, value: string | null): boolean {
  return !filter || filter === value;
}

function matchesPolicy(row: FleetRow, policy: string): boolean {
  if (!policy || row.bot.policy?.binding?.policyId === policy) return true;
  const { resolution } = row;
  const fields = [
    resolution.provider,
    resolution.model,
    resolution.thinkingOptionId,
    resolution.requirements,
    resolution.modeId,
    resolution.routing,
    resolution.taskClasses,
    ...Object.values(resolution.budget),
    ...Object.values(resolution.concurrency),
    ...Object.values(resolution.roles).flatMap((role) => Object.values(role)),
  ];
  return fields.some((field) => field.source.policyId === policy);
}

function hasException(row: FleetRow): boolean {
  const inherited = row.bot.policy?.inherit ?? [];
  return INHERITABLE.some((field) => !inherited.includes(field)) || row.resolution.issues.length > 0;
}

export function filterFleet(rows: readonly FleetRow[], filters: FleetFilters): FleetRow[] {
  return rows.filter((row) => {
    if (
      !matchesValue(filters.team, row.teamId) ||
      !matchesValue(filters.provider, row.resolution.provider.value) ||
      !matchesValue(filters.model, row.resolution.model.value) ||
      !matchesValue(filters.status, row.executionStatus)
    )
      return false;
    return matchesPolicy(row, filters.policy) && (!filters.exceptions || hasException(row));
  });
}

export function toggleSelection(input: {
  selected: readonly string[];
  visibleIds: readonly string[];
  botId: string;
  anchor: string | null;
  range: boolean;
}): { selected: string[]; anchor: string | null } {
  const { selected, visibleIds, botId, anchor, range } = input;
  const next = new Set(selected);
  const start = anchor === null ? -1 : visibleIds.indexOf(anchor);
  const end = visibleIds.indexOf(botId);
  if (range && start >= 0 && end >= 0) {
    for (let index = Math.min(start, end); index <= Math.max(start, end); index++) {
      next.add(visibleIds[index]);
    }
    return { selected: [...next], anchor };
  }
  if (next.has(botId)) next.delete(botId);
  else next.add(botId);
  return { selected: [...next], anchor: botId };
}

export function selectionKey(key: string): boolean {
  return key === " " || key === "Spacebar" || key === "Enter";
}
