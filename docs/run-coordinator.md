# Durable run coordinator

`server/run-coordinator.ts` is the admission boundary for managed executions. Bots opt in with `executionMode: "managed"` (`execution_mode` in change/control APIs); omission or `"legacy"` preserves the legacy launch path without managed capacity, deadlines or reservations. Both modes retain existing B04 policy inheritance, explicit bindings and routine overrides, resolving one selected model through the same preparation builder. Managed remote bots are rejected; imports and duplicates explicitly remain legacy. The scheduler generates managed occurrences and result cards; `server/legacy-routines.ts` launches legacy routines through the same authoritative writer. `RunStore` is the only reader/writer of `routines.json`.

## Admission and snapshots

`new RunCoordinator(host, relay, options?)` acquires `<data-directory>/coordinator.lock` before metadata operations. `options.store` selects the authoritative store; clock, jitter, capacity and host adapter seams are injectable. Production uses `prepareChat`, `launchPreparedChat` and `refreshPreparedChat` from `server/chats.ts`.

- `admit(Admission)` resolves the bot/routine configuration once. Existing occurrence lookup happens before preparation, so a duplicate does not consult edited or deleted policies.
- `admitPrepared(prepared, PreparedAdmission)` accepts an already frozen `PreparedBotChat`, including ordinary-chat purposes. It does not re-resolve policy, model defaults, prompts or memory.
- `Admission` contains `bot`, required full captured `state: BotState`, optional `routine`, `trigger`, `due: Date`, explicit `requestId`, `prompt`, `title`, optional labels/purpose/resource IDs/overlap. The bot and routine must belong to that state.
- `PreparedAdmission` contains optional `state`, optional `routineId`, `trigger`, `due`, `requestId`, optional resource IDs/overlap/capacity limits. Managed producers pass the same state used for preparation, not a second read.
- Both forms support a server-computed `requestHash`, `deferLaunch?: boolean`, and `deadlineAt?: number` (safe integer Unix milliseconds).

Server `prepareChat` accepts `state?: BotState`: callers with an admission snapshot pass the whole captured configuration, including policy definitions and library. Without it, direct preparation reads current state once. A narrower policy-only object cannot preserve the library from that same revision.

A scheduled occurrence key is `<routineId>@<ISO due instant>`. Manual and webhook keys are `request:<sha256(JSON.stringify([recordId, trigger, requestId]))>`. The namespace separates triggers and prevents opaque-ID delimiter collisions. Request identity does not change across retries. Manual routine RPC callers may pass `requestId`; webhook callers may pass `Idempotency-Key` (1-200 characters). Omission creates a new request identity. `requestHashOf` canonicalizes object keys before SHA-256 hashing. Manual routine digests cover original `{botId,routineId,requestId}`; webhook digests cover the complete original bounded body and content type, not the truncated injected prompt or receive time. A repeated key with the same digest returns the original retained run before mutable resolution, even after configuration deletion; a changed or missing historical digest returns `RequestConflictError` (`request_conflict`, webhook HTTP 409). Saved webhook-secret authentication and rate limits still apply before replay.

Before any host creation:

1. Publish a restricted immutable JSON artifact with the exact prepared provider/model/config, resolved policy, permission envelope, prompt hashes, memory receipt, playbook hashes, input refs and environment version.
2. Persist the occurrence, run/cycle/attempt/execution identity, preassigned UUID and creation idempotency key.
3. Persist a capacity reservation.
4. Persist `starting` before invoking the host.

Artifacts live at `run-artifacts/<sha256>.json` (directory 0700, file 0600), use no-replace publication, verify the content digest on every read, and are fsynced before their metadata references are published. Metadata writes atomically replace the file and fsync the file and containing directory. Artifact references and safe identity/status summaries are public; the full prepared config, environment and relay credentials are not RPC output. Local snapshots record actual plugin, Node, OS and architecture versions when no environment version was supplied. A remote environment remains unknown unless explicitly supplied.

Safe retries create new attempt/execution/agent identities while retaining the frozen launch configuration and occurrence. Plugin-owned relay addresses and credentials may be rebound for the same frozen grant envelope. Recovery never broadens grants using current bot settings.

### Deferred start and creation receipts

`deferLaunch: true` persists a frozen plan with `launchIntent: false`; neither attachment nor restart launches it. `startPrepared(runId)` durably sets intent before pumping, is idempotent, and never revives canceled or uncertain work. A queued/reserved cancellation permanently clears intent.

`waitForCreation(runId, {timeoutMs?})` is event-driven and bounded. It returns `{status:"created",agentId,run}` only after an adapter acknowledgment, matching host evidence or actual session-active evidence proves that agent exists. `{status:"pending",run}` includes queued, starting and unknown creation; `{status:"not_created",run}` requires a no-effect terminal fact. A preassigned UUID is not creation proof. Shutdown resolves outstanding waits honestly as pending and clears their timers.

## Capacity and overlap

Default concurrent reservations:

| Dimension | Limit |
| --- | ---: |
| Global | 4 |
| Provider | 2 |
| Bot | 1 |
| Each resource | 1 |

Configure deployment limits with `CoordinatorOptions.capacity`. Optional `Routine.runtime` contains `overlap`, `resourceIds` and partial `capacity`; routine capacity can only narrow deployment limits. A resolved policy's `concurrency.maxConcurrentRuns` further narrows per-bot admission. Resource IDs are exact opaque strings, deduplicated within a reservation; no resource is inferred from a prompt.

- `skip`: record busy/no-change when work is unfinished or queued.
- `queue`: retain each occurrence's frozen snapshot and admit after the preceding reservation settles.
- `coalesce`: retain at most one queued snapshot behind active work. Later occurrences are recorded busy/no-change with `managed.coalescedInto`; the already admitted snapshot is never edited.

Unconfigured webhook routines retain the previous three-unfinished-occurrence allowance. Explicit overlap policy uses the ordinary one-active-execution rule. Capacity may queue an accepted webhook; HTTP 202 still means accepted, not completed. The fourth unfinished default webhook is HTTP 429. Existing authentication, body limits, rate limits and response status vocabulary are preserved.

`unknown` is never a timeout-based capacity release. A reservation with uncertain effects remains held until supported host evidence settles it. The authoritative store retains every detailed run; only `displayRecords` bounds the ordinary routine-history view to 30 unprotected terminal rows plus all unfinished, unknown, reserved and evidence-pinned rows. `RunStore.list/get/rebuildIndex` expose older retained history through a revision-cached, rebuildable opaque-keyset index. No evidence garbage collector is implemented; disk usage grows with retained history.

## Retry and circuits

Only `ProvenInfrastructureError` from `server/run-admission-policy.ts`, naming the admitted provider and proving no external effect, qualifies for automatic retry. Ordinary exceptions, capability ambiguity, transport loss and `CreationSnapshot.outcomeUnknown` do not qualify. The supported adapter does not invent a no-effect guarantee when the host supplies none.

Maximum three total attempts. Attempt 2 is due after 2 seconds plus injected jitter; attempt 3 after 8 seconds plus jitter. Jitter is 0-1000 ms. A supplied Retry-After duration is a lower bound. Deadlines are durable; wake timers do not override persisted state. A provider circuit opens after three proven infrastructure failures for 30 seconds, then admits one durable half-open probe. Uncertain probes are not reset by a timeout. Other providers have independent circuit state.

### Deadlines, fairness and bounded host calls

Managed `Routine.runtime.deadlineSeconds` (`deadline_seconds` in change/control producers) creates an absolute due-relative deadline. A policy's `budget.maxRunSeconds` starts at the first reservation and survives retries and restart; it is not reset per attempt. Effective expiry is the earlier of these limits. Queue/prelaunch expiry records canceled/no-change and never starts the host. An expired active/uncertain execution requests supported cancellation but retains its execution fact and reservation until evidence proves termination. A cancellation ACK is not such proof.

Persisted `admissionOrder` provides FIFO across routine groups; blocked work does not prevent unrelated capacity from progressing. Missing historical orders migrate deterministically before new admissions. Creation and supported host reads have bounded waits (`launchTimeoutMs`, default 30 seconds); a hung create becomes unknown without a fresh attempt or released reservation. Late success/failure updates are fenced to the captured execution identity, and reconciliation is additionally fenced to the captured session generation. Shutdown abandons local waits, not external work.

A typed SDK `HostCapabilityError` proving that caller-selected identity is unsupported before a create frame records failed/no-change and releases capacity without retry. This deterministic refusal differs from transport ambiguity; arbitrary errors are never treated as no-effect capability evidence.

## Readiness and reconciliation

No secret chat wakes the scheduler. `BotsHost` captures the supported API only through lifecycle or RPC context. Coordinator readiness is `waiting_for_host_api`, `reconciling`, `ready` or `stopped`; `bots.hello` adds this field without removing its legacy `scheduler` boolean.

Cold recovery looks up the preassigned agent UUID, verifies run/execution labels, restores only frozen relay authorization, and refetches the supported canonical timeline. The latest user prompt's `clientMessageId` must identify the admitted prompt. Timeline epoch/sequence cursor is retained; gaps, stale cursors, unseen newer entries, mismatched labels or uncomparable timestamps cannot establish completion. Supported host attention evidence can settle a matching completed/failed turn; otherwise idle is unknown, not success. Missing/repeated provider turn IDs remain evidence only. Repeated terminal delivery cannot settle another UUID execution.

A durable `reserved` execution has not crossed the host-call boundary and may launch. A `starting` execution without matching host evidence remains unknown, even if the call may never have reached the host. A matching running agent is adopted rather than recreated. Host completion never sets `verified_success`; task outcome stays `unknown` without a pinned verifier.

Supported host snapshot/timeline reconciliation also runs periodically (`reconcileIntervalMs`, default 30 seconds). Observations do not overlap. Stop clears periodic/deadline timers and prevents further launches.

## Provider sessions and retained evidence

`sessionOpened({agentId,workspaceId,provider,cwd,reason,purpose})` validates a started managed execution against its immutable admitted UUID/provider/directory before provider startup. Actual session openings persist numeric generations and correlation request IDs per agent: initial generation 1, pending retries reuse their generation/request ID, and a later interactive resume/refresh/import after actual activation advances it. `sessionActive(agentId)` records observed activation; a plugin restart alone never advances a generation. History purpose returns null without reading or writing run/session metadata. Legacy and migrated unknown provenance use generation 0. Hooks without a stable invocation identifier cannot distinguish arbitrarily delayed duplicate notifications after a later generation; no exactly-once SDK delivery guarantee is claimed.

Lifecycle replies and observed canonical timelines are published as private immutable artifacts before result/evidence references enter metadata. Lifecycle artifacts retain the full received reply, not merely the 400-character display excerpt. Timeline evidence records completeness honestly: gaps, errors, stale/newer/older data prevent a complete-reply claim. Bounded observations may remain partial; they never invent missing output. Evidence pins protect display visibility, while authoritative history and artifacts remain retained regardless.

`snapshot(runId)` returns `{status:"available",metadata:PreparedChatMetadata}` from the immutable artifact or `{status:"unavailable",reason}`. It never reads current policy as a fallback. Server detail services must allowlist metadata and hash arbitrary input locators before public projection; full prepared configuration, raw replies, credentials and private paths are not public detail DTOs.

## Read, cancel and reconcile API

Exports in `shared/rpc.ts`:

- `runsListRpc`: `bots.runs.list`, optional cursor/limit (1-100), bot/routine/execution-status filters; returns `{ runs, cursor, readiness }`.
- `runsGetRpc`: `bots.runs.get`, `{ runId }` -> `{ run }` (nullable).
- `runsCancelRpc`: `bots.runs.cancel`, `{ runId }` -> `{ run, error }`.
- `runsReconcileRpc`: `bots.runs.reconcile`, optional `{ runId }` -> `{ runs, readiness }`.

Coordinator methods include `admit`, `admitPrepared`, `findRequest`, `startPrepared`, `waitForCreation`, `snapshot`, `sessionOpened`, `sessionActive`, `list`, `get`, `cancel`, `reconcile`, `recover`, `pump`, `finished` and `stop`. Legacy routines use only `recordLegacy`/`finishLegacy` through the same writer, without managed reservations. New RPCs return authoritative `RoutineRun` facts. Existing routine RPCs/MCP retain their outbound legacy status projection. `RoutineRun.managed` is optional for legacy records and contains safe admission/reservation/attempt/evidence summaries, never prepared artifact contents.

Canceling queued/reserved work is atomic and records canceled/no-change. For active work, cancel records the request but retains the reservation. Paseo SDK 0.11.1's plugin-facing agent handle has no supported cancel method; the default response explicitly reports this limitation. Stop the agent in Paseo and reconcile. An explicitly supplied supported cancellation adapter may request host cancellation, but only subsequent host evidence settles execution. Cancellation does not prove absence of external effects.

Local managed starts register before creation. Remote manual chats retain the selected host's legacy launch path until a trusted remote coordinator exists; they must visibly report unsupported managed accounting/enforcement and must never use the storing host's Memory bridge or launch a remote prepared config on the local server.

## Migration, locking and rollback

The current run envelope is `{version:3,routines,coordinator:{occurrences,requests,circuits,admissionOrder,sessions}}`. Reads of old unversioned/v0/v1/v2 history do not rewrite it. First upgrade save preserves exact bytes in `routines.json.pre-run-store`, `routines.json.v1.bak` or `routines.json.v2.bak`, as applicable. Existing backups are never refreshed. Unsupported future versions and malformed managed v2/v3 data refuse access without moving the file aside. Historical string/process session markers migrate to numeric 0; valid numeric generations survive unchanged. New v3 writes are strict. Store instances share a canonical-path serialized writer and CAS revision semantics, including directory aliases.

The process lock uses exclusive creation, PID, hostname and a random ownership token. Another coordinator, including one in the same process, refuses. A stale/malformed lock is never automatically stolen. After a crash, verify the recorded process is no longer running on its recorded host, stop all coordinators, then manually remove only `coordinator.lock`. Never remove a lock merely because a timer elapsed. Release checks original inode and content and does not remove a changed owner.

To downgrade: stop Paseo, preserve the current run file and restricted artifacts, then restore the appropriate exact backup before starting the older plugin. Version 1/2 readers cannot interpret version 3; RPC compatibility is not disk downgrade compatibility. Restoring a backup discards newer intents, session generations and evidence metadata and does not undo external effects. Reconcile unknown operations before allowing new execution on restored history. Fresh installations have no migration backup.

## Verification

The coordinator regression suite injects interruption before/after artifact publication and queued/reserved/starting/running metadata commits, reopens real stores, and checks duplicate identity, frozen replay, capacity dimensions, overlap modes, retries/circuits, cold adoption and unknown effects.

Standalone cold-process smoke used the real server preparation/launch adapter with a local inert host stand-in, no paid model agents. An unstarted plan survived a cold reopen; explicit start used its frozen model despite edited configuration. The process was SIGKILLed after persisted `starting` and host acceptance. A second process refused the stale lock; after confirmed process exit and manual lock removal, a fresh process adopted the same UUID without another create, persisted session generations 1 then 2, preserved exact history-read bytes, and retained a full lifecycle reply beyond the display excerpt. Separate actual-process smoke exercised hung creation, unrelated progress, late ACK refusal and unsupported active cancellation. Real loopback HTTP exercised identical replay, changed-body HTTP 409 beyond prompt truncation, distinct keys and replay after bot deletion. No live installed-plugin or Windows validation is claimed.
