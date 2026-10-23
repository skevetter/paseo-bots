import type { z } from "zod";
import type { BotGroup, BotState, TeamLogo } from "../bot";
import { saveTeam, teamLogoOf, teamMembers } from "../groups";
import type { ChangeContext } from "./context";
import { imageUrl, oneLine } from "./fields";
import type { ChangeIds } from "./ids";
import { findBot, findTeam } from "./refs";
import type { ChangeOf, LogoInput } from "./schema";

function withLogo(logo: TeamLogo, input: z.infer<typeof LogoInput> | undefined, ids: ChangeIds): TeamLogo {
  if (!input) return logo;
  return {
    seed: input.new_logo ? ids.seed() : logo.seed,
    palette: input.colour !== undefined ? input.colour : logo.palette,
    imageUrl:
      input.image_url !== undefined ? imageUrl(input.image_url) : input.new_logo ? null : logo.imageUrl,
  };
}

export function createTeam(
  values: BotState,
  change: ChangeOf<"create_team">,
  context: ChangeContext,
): BotState {
  const lead = change.lead ? findBot(values, change.lead) : null;
  const members = [
    ...new Set([...(lead ? [lead.id] : []), ...(change.members ?? []).map((ref) => findBot(values, ref).id)]),
  ];
  const logo = withLogo(
    { seed: context.ids.seed(), palette: null, imageUrl: null },
    change.logo,
    context.ids,
  );
  const draft = {
    name: oneLine(change.name),
    logo,
    leadId: lead?.id ?? null,
    memberIds: members,
    instructions: change.instructions?.trim() ?? "",
  };
  return {
    ...values,
    groups: saveTeam(values.groups ?? [], {
      id: null,
      newId: context.ids.id("team"),
      draft,
      now: context.now,
    }),
  };
}

function updatedLead(values: BotState, group: BotGroup, lead: string | null | undefined): string | null {
  if (lead === undefined) return group.leadId;
  return lead === null ? null : findBot(values, lead).id;
}

export function updateTeam(
  values: BotState,
  change: ChangeOf<"update_team">,
  context: ChangeContext,
): BotState {
  const group = findTeam(values, change.team);
  const removed = new Set((change.remove_members ?? []).map((ref) => findBot(values, ref).id));
  const lead = updatedLead(values, group, change.lead);
  const kept = change.lead ? lead : null;
  const members = [
    ...new Set([
      ...teamMembers(group),
      ...(change.add_members ?? []).map((ref) => findBot(values, ref).id),
      ...(lead ? [lead] : []),
    ]),
  ].filter((id) => !removed.has(id) || id === kept);
  const draft = {
    name: change.name !== undefined ? oneLine(change.name) : group.name,
    logo: withLogo(teamLogoOf(group), change.logo, context.ids),
    leadId: lead && members.includes(lead) ? lead : null,
    memberIds: members,
    instructions: change.instructions?.trim() ?? group.instructions,
  };
  return {
    ...values,
    groups: saveTeam(values.groups ?? [], { id: group.id, newId: group.id, draft, now: context.now }),
  };
}
