<p align="center">
  <img src="https://raw.githubusercontent.com/skevetter/paseo-bots/main/docs/bots.svg" width="512" alt="Six pixel-art bots">
</p>

# paseo-bots

paseo-bots is a [Paseo](https://paseo.sh) plugin for personal bots. You chat with a bot in its workspace, or a routine runs it on a schedule or from a webhook.

This repository is a fork of [oliexe/paseo-bots](https://github.com/oliexe/paseo-bots).

## Features

- **Bots**: instructions, a model, an approval mode, an avatar and a `MEMORY.md`. A bot can propose setup changes on a card you apply.
- **Routines**: a prompt that runs on a schedule, once, or when its webhook gets a `POST`.
- **Teams**: a Chief of Staff hands parts of your requests to its teammates.
- **Skills & Tools**: one library of skills and MCP servers, turned on per bot.
- **Connected apps**: 1,000+ apps through your own [Composio](https://composio.dev) account. A local relay holds the API key and keeps each bot to its apps, tools and accounts.
- **Runtime policies**: versioned execution settings with global/team/bot inheritance and per-field sources. Policies are opt-in through the RPC API; read them with MCP `policies_list`, `policies_get` and `policy_resolve`. See [policy contracts and rollback](docs/policies.md).

## Install

```bash
paseo plugin install git:skevetter/paseo-bots --ref v1.3.0
```

The plugin needs Paseo 0.11.0 or later. The install has no npm step. [Releases](https://github.com/skevetter/paseo-bots/releases) lists each version.

## Usage

1. Open **Bots** in Paseo's sidebar and press **New bot**.
2. Start blank, from a role, from a preset, or from a bot or team file under **Import**.
3. Chat with the bot. The panel button at the top right of a chat opens its settings.
4. Press **Skills & Tools** below the bot list to add skills, MCP servers and apps. Give them to a bot under its **Skills** and **Access** settings.
5. Press **Fleet** (the checklist icon) in the bot-list footer to inspect effective runtime settings, manage immutable policies, and preview atomic changes to selected bots. Existing chats are unaffected. See [Fleet UI](docs/fleet-ui.md) and [operation guarantees](docs/fleet-operations.md).

An imported bot or team file brings its instructions, model, skills, routines and playbooks. The bot starts in the approval mode the new-bot defaults give its provider, with no always-allowed tools, MCP servers or apps. Its routines start paused. The file's skills and MCP servers wait in the library, switched off, until you review them.

Version 3 bot files carry a resolved runtime-policy snapshot rather than source-host policy IDs. Definitions and imported bots are admitted together; approvals still come from the destination. See [portable policies](docs/portable-policies.md) for format compatibility and rollback.

Committed proposal changes cannot be dismissed: retry acceptance or let startup recovery finish them. Accepted proposals remain protected from retention until their receipt pin is durably released; interrupted completion is reconciled without applying the changes again. Recovery also finishes receipt-backed proposals dismissed by an older version. Keep both `state.json` and `proposals.json` when backing up or rolling back interrupted operations.

## Memory limits and history

Chats load up to 200 lines and 24,000 UTF-8 bytes from `MEMORY.md`, stopping at a whole-line boundary. The Memory panel shows how much was included and omitted. Edit the file or move detail to a topic file when it exceeds the limit.

Overlapping chats make file-change attribution ambiguous. A chat remains a possible author until its turn ends; elapsed time alone does not prove it stopped. With a single active chat, a concurrent external edit cannot be distinguished from that chat's edit.

App saves and undo replace files atomically. Undo refuses if the current content no longer matches the saved after-hash, or if an older journal entry has no hash. External writers do not share the app's lock, so they can still race the final conflict check and replace.

## Approval for new bots

**Settings > Bots > Defaults for new bots** sets the approval mode a new bot starts in, on any provider:

- **Provider default**: the provider's own default mode.
- **Ask first**: the provider's strictest mode that asks before acting, such as Claude's Always Ask.
- **Run without asking**: the provider's mode that acts without asking, such as Claude's Bypass, omp's Full Access or Hermes's Don't Ask.

A mode picked for one provider in the list below **Approval** wins over it. When a provider has no matching mode, the bot starts in the provider's default mode and the app says so. A bot that runs without asking acts as you with no prompts.

## The Browser preset and its risk

The library has a built-in **Browser** MCP server. It runs [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) against a Chromium browser you use, such as Chrome, Brave or Edge.

A bot with this server acts as you on every site where that browser is signed in. It can read your mail, send messages and buy things. A web page can carry text that steers the bot to do something you did not ask for.

The preset is off for every bot. Importing a bot or team file does not turn it on. To use it:

1. Start the browser with `--remote-debugging-port=9222`. While that port is open, any program on your computer can control the browser.
2. Set **Browser address** if you use another port.
3. Press **Test and turn on**, and give the server to one bot under **Access**.

A separate browser profile without your main accounts limits the damage.

## MCP control

MCP clients such as Claude Code, Cursor, Hermes or omp can manage bots through a local endpoint, with or without the app open.

1. Turn on **Settings > Bots > External control (MCP)**.
2. Copy **Client config** into your client:

```json
{ "mcpServers": { "paseo-bots": { "command": "<Paseo home>/plugin-data/paseo-bots/bin/paseo-bots-mcp" } } }
```

The command runs with bun or node and reads the endpoint and token from plugin data. **Rotate token** locks out old clients.

- Chats get no token. A bot that runs commands without asking can read any of your files, this token included.
- No tool reads or sets API keys or webhook secrets.
- The Browser server, modes that don't ask, new-bot defaults that start bots in one, always-allowed commands and new MCP servers wait for you to accept them there, unless **Allow elevated changes without approval** is on.
- Delete and archive tools need `confirm: true`.
- Chat and Run now tools need the app to connect once after the daemon starts.

## What this fork changes

Compared with oliexe/paseo-bots 0.2.0, this fork:

- targets the Paseo 0.11 plugin SDK, with its own screen and sidebar items;
- shows proposal and sign-in cards for ACP providers such as Hermes and omp;
- adds the Browser preset;
- writes state files through a temporary file and sets an unreadable file aside;
- preserves a version-1 config backup and checksum before migrating policies to envelope version 2; future config versions refuse reads and writes rather than starting empty;
- checks each relay token before it reads a request, and bounds request sizes;
- keeps routine history through corrupt files, missed runs and failing routines;
- records whether a routine run finished apart from whether its task worked, and shows a finished run as not verified until something checks it;
- shows loading and error states for apps, server tests and runs;
- labels icon buttons for screen readers;
- lints with Biome and releases from this repository with semantic-release.

## Routine run compatibility and rollback

`bots.routines.status` keeps `{ scheduler, routines }`, including each record's `lastRunAt` and `runs`.
`bots.routines.run-now` keeps `{ run }`. Every run in either response retains all old fields and their
types, including the old `status` enum, and adds `executionStatus`, `taskOutcome` and run identity.
MCP `routines_run_now`, `routines_status` (`lastRun`) and `routines_history` use the same run projection.
MCP text and the UI describe the authoritative facts, not the compatibility label.

`status` exists only on outbound responses. New callers must use `executionStatus` and `taskOutcome`:

| Authoritative execution | Outbound legacy `status` |
| --- | --- |
| queued, reserved, starting, running, waiting_for_user, verifying | `running` |
| completed, with any task outcome | `succeeded` |
| failed, canceled, unknown | `failed` |
| skipped because busy or missed (takes precedence) | `skipped-busy` or `skipped-missed` |

The legacy `succeeded` label means only that the provider turn completed, never that the task worked.
It can accompany `taskOutcome: unknown` or `verified_failure`. Likewise `failed` can mean canceled or
unknown execution, not a verified task failure. Never use `status` for verification, routing or review.
The webhook HTTP reply is unchanged (`running`, `skipped-busy` or `failed`); it reports admission, not
the eventual outcome. Internal and persisted run records have no `status` field.

Managed execution is explicit opt-in (`executionMode: "managed"`, or `execution_mode` through control
changes); absent mode remains legacy. Both preserve existing policy bindings and routine overrides.
Managed launches use durable occurrence/request identity, frozen restricted artifacts, deferred start
intent, deadlines and capacity reservations before creation. Unknown host effects retain their
reservation and are never automatically restarted. Provider-session generations are numeric and
persisted per actual agent, not plugin processes; history reads do not create sessions. See
[coordinator contracts, limits and recovery](docs/run-coordinator.md).

Historic `succeeded` records read as `executionStatus: completed`, `taskOutcome: unknown`, with no
verification. A read does not rewrite the file. First save of unversioned history preserves it once as
`routines.json.pre-run-store`; first upgrades from version 1/2 preserve `routines.json.v1.bak` /
`routines.json.v2.bak`. New writes use `{version:3,routines,coordinator}` and retain complete detailed
history; the ordinary 30-terminal view is only a display projection. Unsupported future versions and
malformed managed metadata stay in place and refuse access. Only corrupt old-format files are set
aside automatically.

To roll back to 1.3.0, stop Paseo and restore `routines.json.pre-run-store` over `routines.json` before
starting the older plugin. This discards runs recorded after migration; the backup is not refreshed.
A fresh installation has no pre-migration backup. Without a restored old-format file, 1.3.0 cannot
interpret the new envelope. Outbound RPC compatibility is not on-disk downgrade compatibility, and
results-chat cards written with the new fields are not guaranteed to render in the older plugin.
To return to the prior version-1 RunStore release, stop Paseo and restore `routines.json.v1.bak`.
To return to the prior version-2 coordinator, preserve current metadata/artifacts and restore
`routines.json.v2.bak`; older readers cannot safely strip new intents, evidence or session generations.
Restoring history does not undo external effects; preserve current artifacts and reconcile uncertain
operations before admitting new work. A stale coordinator lock requires explicit manual recovery after
checking that its recorded owner process is no longer running.

## Development

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run bench
```

Paseo supplies React 19.1, React Native 0.81 and React Query 5.90 at runtime. Use no newer React Query API.

What Paseo versions and SDK behavior the plugin relies on, and the fixtures that pin them, is in [docs/compatibility.md](docs/compatibility.md). Update it together with `tests/sdk-contract.test.ts` when `@getpaseo/client` or `@getpaseo/plugin` changes.
