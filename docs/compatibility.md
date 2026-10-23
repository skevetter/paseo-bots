# Paseo compatibility baseline

What the Paseo host and SDK do today, and what this plugin does with it. Written against `@getpaseo/client` and `@getpaseo/plugin` 0.11.1 (`package.json`, `package-lock.json`).

Every statement is **Observed** (read in the installed SDK `.d.ts`/`.js` under `node_modules/@getpaseo`, or in this repository) or marked **[INFERRED]** (a conclusion the SDK does not state). The host daemon itself is not installed here, so anything about daemon behavior is inferred from SDK code and types. `tests/sdk-contract.test.ts` pins the observed SDK behavior; it drives the real SDK `DaemonClient` over an in-memory transport (`tests/fake-daemon.ts`), with no network.

When the SDK is bumped, a failing fixture means a contract below changed: read the diff, update this document and the fixture together, and check every caller named here.

## Versions and CI

| Fact | Value | Source |
| --- | --- | --- |
| Minimum supported Paseo | `>=0.11.0` | `paseo-plugin.json` `requirements.paseo` |
| Build SDK | `@getpaseo/client` and `@getpaseo/plugin` `0.11.1`, exact pins | `package.json` devDependencies |
| CI | Node 24; `ubuntu-latest` and `macos-latest`; `npm ci`, lint, typecheck, test | `.github/workflows/ci.yml` |
| Windows | Not tested, not claimed | no Windows entry in the CI matrix |

- The SDK ships `assertPluginCompatibility` (`@getpaseo/protocol/plugin-requirements`). Given this manifest it accepts 0.11.0 and 0.11.1, rejects 0.10.9 with "requires Paseo", and rejects an unknown host version. Pinned in the fixtures. That the host calls it before loading a plugin is **[INFERRED]** from its `runtime: "daemon" | "app"` input.
- The minimum host (0.11.0) is older than the build SDK (0.11.1). Anything added to the SDK in 0.11.1 is not guaranteed on a 0.11.0 host **[INFERRED]**; the SDK has no per-call version check, only the feature flags below.
- Paseo supplies the plugin's runtime libraries (see README Development): React 19.1, React Native 0.81, React Query 5.90. The host shim has no `useRevealedText`.
- `@getpaseo/protocol` is imported by the fixtures only. It reaches `node_modules` as a dependency of `@getpaseo/client`, not as a declared dependency of this package; shipped code (`shared/`, `server/`, `client/`) must not import it.

## How the plugin reaches the host

- Server code gets `PaseoApi` from `PluginHandlerContext["paseo"]` (`server/paseo.ts`). `PaseoApi` (`@getpaseo/client`) exposes `agents`, `workspaces`, `projects`, `providers`, `config`, `terminals`, `observeEvents`, `dispose`. It has **no** server-info or feature accessor: the feature map the daemon advertises in its `server_info` message lives on `DaemonClient.getLastServerInfoMessage()`, which a plugin cannot reach. So a plugin cannot ask "does this host support X" up front; it can only attempt the call and classify the error.
- Chats start in `startBotChat` (`shared/chat.ts`) against the narrow `ChatApi` interface, which `PaseoApi` is assignable to. Two callers:
  - `server/chats.ts` `startChat` (routines, `ask_bot`): always picks `agentId = newUuid()`. Refuses a bot with `hostId` set.
  - `client/BotsSurface.tsx` `useStartChat` (UI): passes `agentId` only when `host.isLocal`. Chats on a remote host are created without a caller-selected id.

## Create passthrough

Options type for `workspace.agents.create` is `PaseoWorkspaceAgentCreateOptions` = `PaseoAgentCreateOptions` minus `cwd`. Fixtures pin the five fields below on the type and on the wire.

| Field | SDK type (0.11.1) | On the wire (`agent.create.request`) | `ChatApi` / `startBotChat` today |
| --- | --- | --- | --- |
| `agentId` | `string`, must be a UUID | `agentId` | forwarded (`StartChatInput.agentId`) |
| `idempotencyKey` | `string` | `idempotencyKey` | **dropped**: not in `ChatApi` |
| `env` | `Record<string, string>` | `env` | **dropped** |
| `clientMessageId` | `string` | `clientMessageId` | forwarded |
| `outputSchema` | `Record<string, unknown>` | `outputSchema` | **dropped** |
| `prompt` | `string` | `initialPrompt` | forwarded |
| `title` | `string`, in `config.title` | same | forwarded, cut to 200 characters |
| `labels` | `Record<string, string>` | `labels` | forwarded; `BOT_LABEL` added |
| `images`, `attachments` | SDK payload types | same | forwarded when non-empty |
| `parent` | agent id or handle | `callerAgentId` | dropped |
| `onEvent` | `(CreationSnapshot) => void` | not sent; local observer | dropped |

Also dropped by `ChatApi`: `requestId`, `git`, `worktree`, `autoArchive`. `workspaces.create` on the SDK accepts an `agent` but its type omits `idempotencyKey` and `requestId`; `ChatApi.workspaces.create` passes only `title` and `source`.

Behavior of the SDK client (`creation/index.js`, `daemon-client.js`):

- `agentId` is validated client-side as a UUID. A non-UUID is rejected by the SDK's schema before anything is sent (fixture). `shared/uuid.ts` `newUuid` produces v4 UUIDs.
- Idempotency in the SDK is in-flight only. While a call is pending, the same key with the same body (compared with `requestId` ignored) shares one request; the same key with a different body rejects with `agent_request_key_conflict`. Once the call settles the key is forgotten, and the same key sent again is a second wire request (fixtures). Durable replay protection is therefore the daemon's job, advertised as `agentRequestReceipts` / `creationLifecycle` **[INFERRED]**; this plugin has not exercised it.
- A failed create throws a plain `Error(message)`. `DaemonClient.createAgent` discards the result's `errorCode` and the creation snapshot, including `outcomeUnknown` and `failedStage`. A caller that must tell "failed" from "outcome unknown" has to use `onEvent` snapshots or reconcile by listing agents; `PaseoApi.agents.create` alone cannot. (Read in `daemon-client.js` `createAgent`; `CreationSnapshot` schema in `@getpaseo/protocol/messages`.)
- On a modern host an in-flight create survives reconnect: the SDK resubscribes and either adopts the daemon's snapshot or resubmits (`creation/index.js` `reconnect`). The SDK rejects with `Daemon client closed` if the client closes first.

## Older hosts: managed identity must fail loudly

"Managed identity" means the plugin chooses the agent id (and, from B06, an idempotency key) before the host creates the chat, so it can record a run before launch.

Observed, for a host whose `server_info.features` lacks `creationLifecycle`:

- `agents.create` and `workspaces.create` with an `agentId` (and `workspaces.create` with a `workspaceId`) throw `Error("Update the host to use caller-selected creation IDs.")` and send nothing. The error has no `code`. Pinned in the fixtures.
- Without an `agentId` the call succeeds on the legacy `create_agent_request` path, and then **silently** loses the idempotency key. The key reaches the wire only when the host advertises `agentRequestReceipts` **and** the call has no prompt, images or attachments; with a prompt (this plugin always sends one) it is stripped. `env`, `clientMessageId`, `outputSchema` and `workspaceId` still go through. A fixture table covers all four feature/prompt combinations.
- The SDK's own comments date `creationLifecycle` and `agentRequestReceipts` to v0.8.0. A host that satisfies `>=0.11.0` should therefore have both **[INFERRED]**. The failure still matters when a client (UI path, remote host) is connected to a daemon older than the host the plugin installed on, and it is the only signal available because `PaseoApi` exposes no feature map.

Contract for plugin code, `shared/host-capability.ts`:

- `toHostCapabilityError(error)` returns a `HostCapabilityError` (`capability: "managed-identity"`) when the error is the SDK message above, otherwise `null`. It matches the exact message because the SDK gives no code; the fixtures run the real SDK so a reworded message fails the build.
- A feature that needs managed identity must catch the creation error, convert it with this helper, and surface it. It must not retry, drop `agentId`, or fall back to an unmanaged chat. Nothing calls the helper yet; B06 wires it in.
- A chat that is intentionally unmanaged (remote host UI path today) is a separate, explicit decision, not a fallback.

## Agent lifecycle and turn completion

Statuses: `PluginAgentSnapshot.status` and the daemon's `AgentSnapshotPayload.status` are both `initializing | idle | running | error | closed` (`AGENT_LIFECYCLE_STATUSES`; pinned). The snapshot also carries `activeTurn: { turnId: string; startedAt: string | null } | null` (optional), `lastError?: string`, `pendingPermissions`, and `attentionReason: "finished" | "error" | "permission" | null`.

Turn events, as the plugin receives them (`PluginLifecycleEvents`, `server.on` in `index.server.ts`):

- `agent.turn_started { agent, turnId: string | null }`
- `agent.turn_ended { agent, turnId: string | null, outcome, timeline }` where `outcome` is `{ kind: "completed" } | { kind: "failed", error: { message, code? } } | { kind: "canceled", reason }`.

What "completed" means: the provider turn ended without a failure or a cancel. It carries no information about whether the task the prompt asked for was done, correct, or had its side effects applied. The SDK defines no other success signal. The scheduler currently records `succeeded` for every `completed` outcome (`server/scheduler.ts`, `finished`); B02 separates execution status from task outcome.

Other completion vocabulary, which is not the same thing:

- `waitForFinish` / `run` resolve with `status: "idle" | "error" | "permission" | "timeout"` (`PaseoAgentRunResult`; pinned). `permission` and `timeout` are "stopped waiting", not "turn finished"; `run` is documented as resolving "when that turn finishes or needs attention". The plugin discards the result and re-reads the snapshot (`server/tools/bots.ts`).
- Raw stream events use `turn_completed`, `turn_failed`, `turn_canceled` (`AgentStreamEvent`), plus `attention_required`. `status: "error"` and `lastError` sit on the agent snapshot and name no turn; whether they clear on the next turn is **[INFERRED]** unknown.
- The plugin's `chatStatus` maps `closed` to idle and `initializing` to running; `scheduler.working` treats only `running` and `initializing` as busy. A `closed` agent is not distinguished from a finished one.

## Event ids and deduplication

Observed id carriage:

| Place | `turnId` |
| --- | --- |
| `agent.turn_started` / `agent.turn_ended` hooks | `string \| null`: may be absent |
| `AgentStreamEvent` turn, usage, timeline and permission events | optional (`turnId?: string`); `getAgentStreamEventTurnId` returns `undefined` when missing |
| `AgentSnapshotPayload.activeTurn` | `string` when an active turn is present |
| Timeline entries | optional `turnId`; ordering identity is `seqStart`/`seqEnd` within an `epoch` |

Why `(agentId, turnId)` is not a safe dedupe key:

1. `turnId` can be missing on exactly the events that end a turn (observed above), so a key built from it is sometimes undefined.
2. The SDK does not state that a turn id is unique across an agent's life, or that an id is not reused after a restart, resume or timeline replacement **[INFERRED]**: no such guarantee is in the types or code.
3. Delivery can repeat or skip. The timeline API documents that after a reconnect `subscription_restored` is emitted and history "may have been missed", a `replacement` event invalidates the previous `epoch`, and a refetch response carries `reset`, `staleCursor` and `gap` flags. That is evidence the stream is at-least-once with gaps; that a given hook event is delivered twice is **[INFERRED]**, not observed.
4. The plugin matches a finished turn to a run by `agentId` and `status === "running"` alone (`scheduler.finished`), never by turn id, so a second end event for one agent is only harmless while the run is already settled.

Consequence for B02/B06: Bots generates its own opaque run and execution ids and treats `turnId` as nullable evidence. Order and reconcile with `(epoch, seq)` from the timeline, not with turn ids.

## Usage

Types (`AgentUsage`, pinned): `inputTokens`, `cachedInputTokens`, `outputTokens`, `totalCostUsd`, `contextWindowMaxTokens`, `contextWindowUsedTokens`; **every field optional**. Where it appears: `AgentSnapshotPayload.lastUsage?`, `turn_completed.usage?`, and `usage_updated.usage` (required on that event).

- The SDK does not say whether `lastUsage`, `usage_updated` or `turn_completed.usage` are cumulative for the session or a per-turn delta. It also does not say whether a repeated `usage_updated` replaces or adds to the previous one. Treat the semantics as unknown until a provider is measured. Do not sum snapshots or events from different points of one turn; if a number must be recorded, record it with its source (snapshot vs event) and turn.
- `contextWindowUsedTokens` against `contextWindowMaxTokens` reads as a current-fill gauge, not an additive count **[INFERRED]** from the names.
- A missing field is unknown, not zero. The plugin does not yet follow that: `UsageSection` in `client/panel/OverviewSections.tsx` adds `lastUsage` fields with `?? 0` across chats and labels the total as the latest turn's usage, which is an unverified assumption. B08 owns the fix.
- `registerUsageSource` in `@getpaseo/plugin/server/usage` is provider quota windows (percent used, resets), a different thing from agent token usage. This plugin does not use it.

## What the fixtures pin

`tests/sdk-contract.test.ts`:

- modern host: all five passthrough fields and `workspaceId`, `labels`, title, prompt reach the wire; UUID-only `agentId`; in-flight dedupe and conflict; key forgotten after settle;
- legacy host: caller-selected id refused with the untyped error and nothing sent (both `agents.create` and `workspaces.create`); idempotency key stripped per the feature/prompt table; `toHostCapabilityError` classification, including not matching other "Update the host" errors;
- `startBotChat` through the real SDK: chosen agent id, labels, title cap, prompt, config reach the daemon;
- types: passthrough field types, `workspaces.create` agent omits `idempotencyKey`/`requestId`, status and outcome vocabularies, nullable turn ids, all-optional usage;
- manifest: Paseo's own `assertPluginCompatibility` agrees with `paseo-plugin.json`, and the installed client and plugin SDKs are one version inside the supported range.

Not pinned, because it needs a real daemon: how a host reacts to a repeated idempotency key after settle, what ordering and duplication hook events have, whether usage is cumulative, and anything on Windows.
