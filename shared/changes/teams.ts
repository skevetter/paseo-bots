import type { z } from "zod";
import { randomSeed } from "../avatar";
import { type BotGroup, type BotSettingsValues, newGroupId, type TeamLogo } from "../bot";
import { saveTeam, teamLogoOf } from "../groups";
import type { ApplyContext } from "./context";
import { imageUrl, oneLine } from "./fields";
import { findBot, findTeam } from "./refs";
import type { ChangeOf, LogoInput } from "./schema";

function withLogo(logo: TeamLogo, input: z.infer<typeof LogoInput> | undefined): TeamLogo {
  if (!input) return logo;
  return {
    seed: input.new_logo ? randomSeed() : logo.seed,
    palette: input.colour !== undefined ? input.colour : logo.palette,
    imageUrl:
      input.image_url !== undefined ? imageUrl(input.image_url) : input.new_logo ? null : logo.imageUrl,
  };
}

export function teamMembers(group: BotGroup | null): string[] {
  return group ? [...new Set([...(group.leadId ? [group.leadId] : []), ...group.memberIds])] : [];
}

export function createTeam(
  values: BotSettingsValues,
  change: ChangeOf<"create_team">,
  context: ApplyContext,
): BotSettingsValues {
  const lead = change.lead ? findBot(values, change.lead) : null;
  const members = [
    ...new Set([...(lead ? [lead.id] : []), ...(change.members ?? []).map((ref) => findBot(values, ref).id)]),
  ];
  const logo = withLogo({ seed: randomSeed(), palette: null, imageUrl: null }, change.logo);
  const draft = {
    name: oneLine(change.name),
    logo,
    leadId: lead?.id ?? null,
    memberIds: members,
    instructions: change.instructions?.trim() ?? "",
  };
  return {
    ...values,
    groups: saveTeam(values.groups ?? [], { id: null, newId: newGroupId(), draft, now: context.now }),
  };
}

function updatedLead(
  values: BotSettingsValues,
  group: BotGroup,
  lead: string | null | undefined,
): string | null {
  if (lead === undefined) return group.leadId;
  return lead === null ? null : findBot(values, lead).id;
}

export function updateTeam(
  values: BotSettingsValues,
  change: ChangeOf<"update_team">,
  context: ApplyContext,
): BotSettingsValues {
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
    logo: withLogo(teamLogoOf(group), change.logo),
    leadId: lead && members.includes(lead) ? lead : null,
    memberIds: members,
    instructions: change.instructions?.trim() ?? group.instructions,
  };
  return {
    ...values,
    groups: saveTeam(values.groups ?? [], { id: group.id, newId: group.id, draft, now: context.now }),
  };
}
