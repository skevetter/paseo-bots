# Runtime policies and config envelope v3

## Defaults and adoption

Policies are opt-in. A new installation has no policies or bindings. An existing bot keeps the exact
`provider`, `model`, `modeId` and `thinkingOptionId` it had before migration. These fields remain explicit
overrides, not copied policy defaults. Existing new-bot defaults (`approval`, `modeByProvider`, model and
thinking level) still initialize new bots through `applyDefaults`/`startingMode`.

Creating a policy alone changes no bot. Bind it globally, to a team, or to a bot, then explicitly clear
execution overrides to inherit. Existing chats are never edited. The resolver affects new chat creation
on both the client (`client/BotsSurface.tsx`) and server (`server/chats.ts`), through `startBotChat` in
`shared/chat.ts`. Its required `policy` input is the config's policy state; `routineId` selects execution
overrides on that bot's routine.

No fleet editor or bulk preview/apply is included here. Routing rules, budget and concurrency are resolved
configuration, not a new router, accounting system or run admission controller. Later routing and
coordinator packages consume them. The existing scheduler's admission rules remain unchanged.

## Schema

`shared/policies.ts` exports Zod schemas and their corresponding types:

- `PolicyBodySchema` / `PolicyBody`: name, purpose, optional task classes, role selectors, routing rules,
  budget and concurrency. Task classes use `TaskClassSchema` from `shared/task-contract.ts`, the same
  schema used by `TaskContract`.
- `PolicySchema` / `Policy`: the body plus stable `id`, positive integer `revision` and revision
  `createdAt`. Every successful save appends a revision, including when the body is unchanged. Old
  revisions never change.
- `PolicyBindingSchema` / `PolicyBinding`: `{ policyId, revision }`. A numeric revision pins that
  immutable definition; `null` follows the latest revision. A missing policy or revision is an error,
  never a skipped layer.
- `BotPolicySchema` / `BotPolicy`: `{ binding, inherit }`. `binding` is a binding or null. `inherit`
  lists `provider`, `model`, `thinkingOptionId`. Omitted metadata means every legacy field stays explicit.
- `RoleSelectorSchema` / `RoleSelector`: optional `provider`, `model`, `thinkingOptionId`, and
  `requirements: [{ capability }]`. Role names are executor, planner, advisor, verifier, reviewer.
- `RoutineOverridesSchema` / `RoutineOverrides`: only provider/model/thinking and per-run budget.
  Permissions are not execution overrides.

Storage fields in `shared/bot.ts`:

| Owner | Field |
| --- | --- |
| `BotState` | `policies?: Policy[]` (all revisions); `globalPolicy?: PolicyBinding | null` |
| `BotGroup` (team) | `policy?: PolicyBinding | null` |
| `Bot` | `policy?: BotPolicy` |
| `Routine` | `overrides?: RoutineOverrides`; `modeId?: string` (narrowing only) |

Missing settings inherit. Null is accepted only where explicitly defined: model and thinking use the
provider's default; delegated role null disables the role; budget/concurrency limit null removes that
limit. Provider must be a nonempty string when supplied. An empty inheritance chain cannot choose a
provider. An omitted task-class restriction allows all classes; a supplied list must be nonempty.

Budgets expose `maxRunSeconds`, `maxRunCostUsd`, `maxRunTokens`. Concurrency exposes
`maxConcurrentRuns`. Routing rules expose `id`, `taskClasses`, `role`, and `select` (a role selector).
Routing rules are schema-only and do not autonomously switch providers.

A model belongs to its provider and a thinking level to its model. `unsetOverrides(bot, fields)` is the
explicit clear-to-inherit operation: clearing provider also inherits model/thinking; clearing model also
inherits thinking. The schema requires that closed set, preventing a stale model from being pinned to a
newly inherited provider. `patchBotOverrides(bot, patch)` takes ownership again on explicit settings
edits, preserves the binding and unrelated inherited fields, and respects an explicit `patch.policy`.
The existing bot editor, saved edits and setup changes use it. A higher layer switching providers resets
lower-layer model/thinking selections to provider defaults unless the higher layer also supplies them.

Policy definitions and bindings are host-local. Existing portable bot/team exports do not embed policy
definitions or references; imported bots start with explicit settings and the existing safe import
approval behavior. Policy-aware fleet export/import is not added by this package.

## Resolution and provenance

Precedence: global -> team -> bot policy -> explicit bot settings -> routine execution overrides. The
existing one-team-per-bot lookup (`teamOf`) chooses the team layer. Budget leaves inherit independently.
Role selectors also inherit per leaf; explicit null disables a delegated role and clears its selection.

Pure exports:

- `resolveBotConfig(input: ResolveInput): Resolution`: explicit layers, optional provider facts,
  capability facts and task class; no filesystem, host API or clock reads.
- `resolveBot(values: PolicyState, bot: Bot, options?: ResolveOptions): Resolution`: gathers bindings
  and the requested routine from a state snapshot. A missing requested routine is an error, not a launch
  with the bot's potentially broader permissions.
- `launchSettings(resolution): LaunchSettings`: extracts provider/model/mode/thinking, or throws
  `PolicyResolutionError` with the structured issues.
- `currentPolicies`, `findRevision`, `nextRevision`, `policyReferrers`: revision and reference helpers.
- `validateProviderTransition(before, targetProvider, providers): Issue[]`: shared approval/grant
  validation for policy resolution and bulk preview/apply. `before` must contain the effective provider
  and mode before editing, plus the bot's `alwaysAllow` and `contactBots`. Resolving an already-edited bot
  cannot infer its previous provider. Use the same validator on preview and apply.

`ResolutionSchema` / `Resolution` always returns `ok` and structured `issues` (`code`, `field`,
`message`). Executor fields `provider`, `model`, `thinkingOptionId`, `requirements`, `modeId`, plus
`taskClasses`, `routing`, budget leaves and concurrency leaves use `{ value, source }`. `Source` is
`{ layer, policyId?, revision? }`, where layer is default/global/team/bot_policy/bot/routine. Delegated
roles use `ResolvedRoleSchema` / `ResolvedRole`: each of `enabled`, `provider`, `model`,
`thinkingOptionId`, `requirements` has its own `{ value, source }`. Invalid resolutions still expose the
requested values and sources so a preview can explain incompatibilities. They must not launch.

`CapabilityFacts` distinguishes supported, unsupported and unknown, with `Provenance` (provider
snapshot, probe, declared, observed; observation time and optional detail). Only supported qualifies.
An absent fact is unknown, never unsupported or a qualification. Model-specific facts take precedence
over provider-wide facts, including when the provider's default model is selected. Default-model lookup
uses the same `defaultModelId` helper as launch. `snapshotCapabilities(providers, observedAt)` derives
positive evidence for thinking levels per model and approval modes per provider; an empty/omitted list
provides no positive or negative evidence and stays unknown. Explicit negative probe/declaration facts
remain unsupported. Qualification and its provenance appear in `resolution.qualification`.

## Permissions are separate

Policies cannot contain approval/mode fields. `Bot.modeId` is an explicit permission override;
`null` means that bot's provider default. It cannot be cleared to inherit from an execution policy.
This deliberately preserves the migrated approval decision independently of live model policy changes.
`BotDefaults.approval` and `modeByProvider` keep their existing new-bot initialization semantics.

A provider transition must preserve a listed mode's approval tier, and a non-null mode must exist on the
target provider. Missing mode evidence refuses the transition; mode names alone are not proof. Different
known tiers also refuse it, even if both usually ask. A target that would drop explicit tool grants
(`alwaysAllow` or unrestricted bot contact) is rejected. Modes are not silently translated across
providers, and the provider default is not silently substituted for an unavailable explicit mode.

A routine may retain its bot's mode, or select a demonstrably narrower listed mode: dangerous ->
moderate/safe/planning, or moderate -> safe/planning. A different mode of the same rank is not proof of
narrowing. Unknown tiers cannot establish narrowing. Safe and planning are not treated as interchangeable
provider-switch semantics. These checks do not grant new tools or modify existing bot access grants.

## RPC and MCP

RPC definitions are in `shared/rpc.ts`, handlers in `index.server.ts`, persistence operations in
`server/policies.ts`. Mutations use `BotStore.edit`, the same serialized/atomic config writer with CAS.
Whole-state writes and regular updates cannot forge, overwrite or drop policy revisions. Policy edits
also preserve B03 receipts and `pendingOperations` pins; replay-safe operations continue through
`BotStore.apply`, `reconcileOperation` and `completeOperation`, not the policy editor.

| RPC / exported definition | Input | Output |
| --- | --- | --- |
| `bots.policies.list` / `policiesListRpc` | `{}` | `{ revision, policies }`, newest per id |
| `bots.policies.get` / `policiesGetRpc` | `{ id, revision? }` | `{ policy: Policy | null, revisions: number[] }` |
| `bots.policies.save` / `policiesSaveRpc` | `{ revision: stateRevision, id?, policy: PolicyBody }` | `{ status: saved, revision, policy }` or `{ status: conflict, error }` |
| `bots.policies.delete` / `policiesDeleteRpc` | `{ revision: stateRevision, id }` | deleted + new revision, conflict + error, or referenced + referrers |
| `bots.policy.resolve` / `policyResolveRpc` | `{ botId, routineId?, taskClass? }` | `{ revision, resolution }` |

`server/policies.ts` exports `listPolicies`, `getPolicy`, `savePolicy`, `deletePolicy`, `resolveForBot`.
`resolveForBot` accepts a host and `{ bot, routineId?, taskClass? }`, returning `{ snapshot, resolution }`.
Deletion refuses every revision while any global binding, team or bot references the id, including pinned
references, and returns the full referrer list. Read-only MCP tools `policies_list`, `policies_get` and
`policy_resolve` use these operations; their definitions are `POLICY_TOOLS` in
`server/control/tools/policies.ts`. MCP policy mutations are intentionally not exposed.

## Migration, failure and rollback

Host `botSettings` is independently versioned at 3 and is unchanged. Routine run history has its own
independent store and format.

Reading envelope version 1 or 2:

1. Parse values using the current bot schema, keeping receipts, unresolved-operation pins, existing overrides
   and explicit managed opt-ins.
2. Publish the original bytes as `state.json.v<N>.bak` (N is 1 or 2; mode 0600) with a no-replace publish. If
   the backup already exists it must match the source bytes exactly; otherwise migration refuses before
   touching the source.
3. Read the backup back and verify its SHA-256, then no-replace publish the digest as
   `state.json.v<N>.bak.sha256`, using the standard `sha256  filename` checksum-file format. An existing digest
   must match.
4. Atomically replace `state.json` with envelope version 3.

A crash before step 4 leaves the original config intact. Reopening repeats the migration safely.
Reopening a v3 config does not rewrite it or its backups. `configBackupPath(statePath, version)` names the
backup.

Why v3: v2 readers rewrite the file while keeping version 2, silently dropping fields they do not know. Observed
on the B04 and 9cff0f5 v2 readers: a managed `executionMode` was stripped, and an unknown `runtimePolicy` was
dropped. Version 3 makes those readers refuse the file instead.

Ordinary malformed files retain `readParsed`'s existing `.corrupt-<timestamp>` set-aside behavior.
A future envelope version is different: `UnsupportedFileVersionError` from `server/files.ts` keeps it in
place and refuses every read/write, including after restart, rather than setting it aside and later
silently initializing an empty config. Version 4 and later are refused unchanged. Upgrade the plugin to read
that configuration.

To roll back: stop the plugin/daemon so no writer is active, retain the current v3 file separately, verify
`state.json.v<N>.bak.sha256` with `shasum -a 256 -c`, restore `state.json.v<N>.bak` as `state.json`, then
start the older plugin. Restoring only plugin code is not a rollback: an old v2 reader refuses a v3 file.
**Restoring a backup loses every receipt, policy, binding and other config change written after that
backup.** Back up the current file before doing so; a lost receipt can also lose replay protection.
