import { z } from "zod";
import { accountLabel, canonicalSlug, filterAppTools, ruleAccount } from "../../../shared/apps";
import type { AppRule, Bot } from "../../../shared/bot";
import { findBot } from "../../../shared/changes/refs";
import type { AppInputValue, Change } from "../../../shared/changes/schema";
import { matchesQuery } from "../../../shared/library";
import { accounts, appTools, catalog, connect, disconnect, renameAccount, status } from "../../composio";
import {
  applyOrPropose,
  BotRef,
  botByRef,
  Confirm,
  type ControlTool,
  defineControlTool,
  result,
} from "../tool";

const NOT_SET_UP = "Connected apps aren't set up. Add a Composio key in Skills & Tools in Paseo.";

const AppSlug = z.string().min(1).max(60).describe("The app's slug, like gmail or slack.");
const AccountId = z.string().min(1).max(200).describe("The account's id, from apps_accounts.");
const Query = z.string().max(200).optional().describe("Only those whose name or slug contains this.");

/** Empty lists come back the same with no key, so say which it is. */
async function emptyText(text: string): Promise<string> {
  return (await status()).configured ? text : NOT_SET_UP;
}

const appsStatus = defineControlTool({
  name: "apps_status",
  description: "Whether connected apps (Composio) are set up on this host.",
  input: z.object({}),
  annotations: { readOnlyHint: true },
  async run() {
    const { configured } = await status();
    return result(configured ? "Connected apps are set up." : NOT_SET_UP, { configured });
  },
});

const appsCatalog = defineControlTool({
  name: "apps_catalog",
  description: "Search the apps Composio can connect, most used first.",
  input: z.object({
    query: Query,
    limit: z.number().int().min(1).max(500).default(50).describe("How many to return."),
  }),
  annotations: { readOnlyHint: true },
  async run({ query = "", limit }) {
    const { apps } = await catalog();
    const matches = apps.filter((app) => matchesQuery(query, app.name, app.slug, app.description));
    const shown = matches.slice(0, limit);
    const text = shown.length
      ? `${matches.length} apps. ${shown.map((app) => `${app.name} (${app.slug})`).join(", ")}`
      : await emptyText(query.trim() ? `No apps match "${query.trim()}".` : "No apps.");
    return result(text, { apps: shown, total: matches.length });
  },
});

const appsAccounts = defineControlTool({
  name: "apps_accounts",
  description: "List the app accounts signed in on this host, newest first.",
  input: z.object({
    fresh: z.boolean().optional().describe("Skip the 30-second cache, as while waiting for a sign-in."),
  }),
  annotations: { readOnlyHint: true },
  async run({ fresh }) {
    const list = (await accounts({ fresh })).accounts;
    const text = list.length
      ? list
          .map(
            (account) =>
              `- ${account.slug}: ${accountLabel(account, account.slug)} (${account.id}, ${account.status})`,
          )
          .join("\n")
      : await emptyText("No apps connected yet.");
    return result(text, { accounts: list });
  },
});

const appsConnect = defineControlTool({
  name: "apps_connect",
  description:
    "Start signing in to an app. Returns a link for the user to open; it expires in ten minutes. Check apps_accounts with fresh: true afterwards.",
  input: z.object({
    slug: AppSlug,
    alias: z
      .string()
      .max(100)
      .optional()
      .describe('A name for the account, like "work". Needed when the app already has one.'),
  }),
  async run({ slug, alias }) {
    const { url } = await connect({ slug, alias });
    return result(`Ask the user to open this link and sign in to ${canonicalSlug(slug)}: ${url}`, {
      app: canonicalSlug(slug),
      url,
    });
  },
});

const appsRename = defineControlTool({
  name: "apps_rename",
  description: "Name an app account. Bots pick between an app's accounts by these names.",
  input: z.object({
    account: AccountId,
    alias: z.string().max(100).describe('The new name, unique per app; "" clears it.'),
  }),
  async run({ account, alias }) {
    await renameAccount({ accountId: account, alias });
    const name = alias.trim();
    return result(name ? `Named ${account} "${name}".` : `Cleared ${account}'s name.`, {
      ok: true,
      account,
      alias: name || null,
    });
  },
});

const appsTools = defineControlTool({
  name: "apps_tools",
  description: "List an app's tools, and which Composio marks as read-only.",
  input: z.object({ app: AppSlug, query: Query }),
  annotations: { readOnlyHint: true },
  async run({ app, query = "" }) {
    const slug = canonicalSlug(app);
    const tools = filterAppTools((await appTools({ slug })).tools, query);
    const text = tools.length
      ? tools.map((tool) => `${tool.name} (${tool.slug}${tool.readOnly ? ", read-only" : ""})`).join("\n")
      : await emptyText(`No ${slug} tools${query.trim() ? ` match "${query.trim()}"` : ""}.`);
    return result(text, { app: slug, tools });
  },
});

const appsDisconnect = defineControlTool({
  name: "apps_disconnect",
  description:
    "Disconnect an app account. Composio revokes the sign-in, and bots can't use it until it's connected again.",
  input: z.object({ account: AccountId, confirm: Confirm }),
  annotations: { destructiveHint: true },
  async run({ account }) {
    await disconnect({ accountId: account });
    return result(`Disconnected ${account}.`, { ok: true, account });
  },
});

const ToolsLimit = z
  .union([z.enum(["all", "read"]), z.array(z.string().min(1).max(200)).min(1).max(200)])
  .describe(
    '"all", "read" for the tools Composio marks read-only (including ones it adds later), or tool slugs from apps_tools. Left out keeps the current limit.',
  );

const BotAppInput = z
  .object({
    bot: BotRef,
    app: AppSlug,
    on: z.boolean().describe("Whether the bot may use the app. Off drops its limits too."),
    tools: ToolsLimit.optional(),
    account: z
      .string()
      .min(1)
      .max(200)
      .nullable()
      .optional()
      .describe(
        "The one account the bot must use, by name or id; null lets it pick. Left out keeps the current one.",
      ),
  })
  .refine((input) => input.on || (input.tools === undefined && input.account === undefined), {
    message: "tools and account only apply when turning an app on.",
  });

async function appInput(
  bot: Bot,
  slug: string,
  input: Pick<z.infer<typeof BotAppInput>, "tools" | "account">,
): Promise<AppInputValue> {
  const rule = bot.appRules[slug];
  const tools = input.tools ?? rule?.tools ?? "all";
  if (input.account !== undefined) return { app: slug, tools, account: input.account };
  const account = rule?.account ? ruleAccount(rule, (await accounts()).accounts) : null;
  return { app: slug, tools, account };
}

function ruleText(rule: AppRule | undefined): string {
  if (!rule) return "all tools, any account";
  const tools =
    rule.tools === "all"
      ? "all tools"
      : rule.tools === "read"
        ? "read-only tools"
        : `only ${rule.tools.join(", ")}`;
  return `${tools}, ${rule.account ? `account ${rule.account}` : "any account"}`;
}

function botAppsResult(bot: Bot, slug: string) {
  const text = bot.apps.includes(slug)
    ? `${bot.name} may use ${slug}: ${ruleText(bot.appRules[slug])}.`
    : `${bot.name} doesn't use ${slug}.`;
  return result(text, { bot: bot.id, apps: bot.apps, appRules: bot.appRules });
}

const botsAppsSet = defineControlTool({
  name: "bots_apps_set",
  description:
    "Switch a connected app on or off for a bot, and limit which of its tools and which account the bot may use.",
  input: BotAppInput,
  async run(input, context) {
    const bot = await botByRef(context, input.bot);
    const slug = canonicalSlug(input.app);
    if (!input.on && !bot.apps.includes(slug)) return botAppsResult(bot, slug);
    const change: Change = input.on
      ? { type: "update_bot", bot: bot.id, add_apps: [await appInput(bot, slug, input)] }
      : { type: "update_bot", bot: bot.id, remove_apps: [slug] };
    const summary = input.on ? `Let ${bot.name} use ${slug}` : `Stop ${bot.name} using ${slug}`;
    const outcome = await applyOrPropose(context, summary, [change]);
    if (outcome.status === "pending") return outcome.result;
    return botAppsResult(findBot(outcome.values, bot.id), slug);
  },
});

export const APP_TOOLS: readonly ControlTool[] = [
  appsStatus,
  appsCatalog,
  appsAccounts,
  appsConnect,
  appsRename,
  appsTools,
  appsDisconnect,
  botsAppsSet,
];
