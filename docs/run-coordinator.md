# Durable run coordinator

`server/run-coordinator.ts` is the admission boundary for managed executions. The scheduler generates occurrences and result cards; it does not create agents, infer success, expire reservations, or restart uncertain work. `RunStore` remains the only reader/writer of `routines.json`.

## Admission and snapshots

`new RunCoordinator(host, relay, options?)` acquires `<data-directory>/coordinator.lock` before metadata operations. `options.store` selects the authoritative store; clock, jitter, capacity and host adapter seams are injectable. Production uses `prepareChat`, `launchPreparedChat` and `refreshPreparedChat` from `server/chats.ts`.

- `admit(Admission)` resolves the bot/routine configuration once. Existing occurrence lookup happens before preparation, so a duplicate does not consult edited or deleted policies.
- `admitPrepared(prepared, PreparedAdmission)` accepts an already frozen `PreparedBotChat`, including ordinary-chat purposes. It does not re-resolve policy, model defaults, prompts or memory.
- `Admission` contains `bot`, optional `routine`, `trigger`, `due: Date`, explicit `requestId`, `prompt`, `title`, optional labels/purpose/resource IDs/overlap.
- `PreparedAdmission` contains optional `routineId`, `trigger`, `due`, `requestId`, optional resource IDs/overlap/capacity limits.

Server `prepareChat` accepts `state?: BotState`: callers with an admission snapshot pass the whole captured configuration, including policy definitions and library. Without it, direct preparation reads current state once. A narrower policy-only object cannot preserve the library from that same revision.

A scheduled occurrence key is `<routineId>@<ISO due instant>`. Manual and webhook keys are `request:<sha256(JSON.stringify([recordId, trigger, requestId]))>`. The namespace separates triggers and prevents opaque-ID delimiter collisions. Request identity does not change across retries. Manual routine RPC callers may pass `requestId`; webhook callers may pass `Idempotency-Key` (1-200 characters). Omission creates a new request identity. A duplicate returns its existing run; a retained occurrence whose terminal run has been pruned refuses replay rather than launching again.

Before any host creation:

1. Publish a restricted immutable JSON artifact with the exact prepared provider/model/config, resolved policy, permission envelope, prompt hashes, memory receipt, playbook hashes, input refs and environment version.
2. Persist the occurrence, run/cycle/attempt/execution identity, preassigned UUID and creation idempotency key.
3. Persist a capacity reservation.
4. Persist `starting` before invoking the host.

Artifacts live at `run-artifacts/<sha256>.json` (directory 0700, file 0600), use no-replace publication, verify the content digest on every read, and are fsynced before their metadata references are published. Metadata writes atomically replace the file and fsync the file and containing directory. Artifact references and safe identity/status summaries are public; the full prepared config, environment and relay credentials are not RPC output. Local snapshots record actual plugin, Node, OS and architecture versions when no environment version was supplied. A remote environment remains unknown unless explicitly supplied.

Safe retries create new attempt/execution/agent identities while retaining the frozen launch configuration and occurrence. Plugin-owned relay addresses and credentials may be rebound for the same frozen grant envelope. Recovery never broadens grants using current bot settings.

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

`unknown` is never a timeout-based capacity release. A reservation with uncertain effects remains held until supported host evidence settles it. Unfinished records, unknown executions and live reservations are never evicted; retention keeps the latest 30 other terminal records per routine. Occurrence tombstones survive that pruning.

## Retry and circuits

Only `ProvenInfrastructureError` from `server/run-admission-policy.ts`, naming the admitted provider and proving no external effect, qualifies for automatic retry. Ordinary exceptions, capability ambiguity, transport loss and `CreationSnapshot.outcomeUnknown` do not qualify. The supported adapter does not invent a no-effect guarantee when the host supplies none.

Maximum three total attempts. Attempt 2 is due after 2 seconds plus injected jitter; attempt 3 after 8 seconds plus jitter. Jitter is 0-1000 ms. A supplied Retry-After duration is a lower bound. Deadlines are durable; wake timers do not override persisted state. A provider circuit opens after three proven infrastructure failures for 30 seconds, then admits one durable half-open probe. Uncertain probes are not reset by a timeout. Other providers have independent circuit state.

## Readiness and reconciliation

No secret chat wakes the scheduler. `BotsHost` captures the supported API only through lifecycle or RPC context. Coordinator readiness is `waiting_for_host_api`, `reconciling`, `ready` or `stopped`; `bots.hello` adds this field without removing its legacy `scheduler` boolean.

Cold recovery looks up the preassigned agent UUID, verifies run/execution labels, restores only frozen relay authorization, and refetches the supported canonical timeline. The latest user prompt's `clientMessageId` must identify the admitted prompt. Timeline epoch/sequence cursor is retained; gaps, stale cursors, unseen newer entries, mismatched labels or uncomparable timestamps cannot establish completion. Supported host attention evidence can settle a matching completed/failed turn; otherwise idle is unknown, not success. Missing/repeated provider turn IDs remain evidence only. Repeated terminal delivery cannot settle another UUID execution.

A durable `reserved` execution has not crossed the host-call boundary and may launch. A `starting` execution without matching host evidence remains unknown, even if the call may never have reached the host. A matching running agent is adopted rather than recreated. Host completion never sets `verified_success`; task outcome stays `unknown` without a pinned verifier.

## Read, cancel and reconcile API

Exports in `shared/rpc.ts`:

- `runsListRpc`: `bots.runs.list`, optional cursor/limit (1-100), bot/routine/execution-status filters; returns `{ runs, cursor, readiness }`.
- `runsGetRpc`: `bots.runs.get`, `{ runId }` -> `{ run }` (nullable).
- `runsCancelRpc`: `bots.runs.cancel`, `{ runId }` -> `{ run, error }`.
- `runsReconcileRpc`: `bots.runs.reconcile`, optional `{ runId }` -> `{ runs, readiness }`.

Coordinator methods are `list`, `get`, `cancel`, `reconcile`, `recover`, `pump`, `finished` and `stop`. New RPCs return authoritative `RoutineRun` facts. Existing routine RPCs/MCP retain their outbound legacy status projection. `RoutineRun.managed` is optional for historical records and contains safe admission/reservation/attempt/evidence summaries, never the prepared artifact contents.

Canceling queued/reserved work is atomic and records canceled/no-change. For active work, cancel records the request but retains the reservation. Paseo SDK 0.11.1's plugin-facing agent handle has no supported cancel method; the default response explicitly reports this limitation. Stop the agent in Paseo and reconcile. An explicitly supplied supported cancellation adapter may request host cancellation, but only subsequent host evidence settles execution. Cancellation does not prove absence of external effects.

Local managed starts register before creation. Remote manual chats retain the selected host's legacy launch path until a trusted remote coordinator exists; they must visibly report unsupported managed accounting/enforcement and must never use the storing host's Memory bridge or launch a remote prepared config on the local server.

## Migration, locking and rollback

The current run envelope is `{ version: 2, routines, coordinator: { occurrences, circuits } }`. Reads of old unversioned/v1 history do not rewrite it. First save of unversioned history preserves exact bytes in `routines.json.pre-run-store`; first v1-to-v2 save preserves exact bytes in `routines.json.v1.bak`. Existing backups are never refreshed. Unsupported future versions and structurally unreadable v2 coordinator data refuse access without moving the file aside.

The process lock uses exclusive creation, PID, hostname and a random ownership token. Another coordinator, including one in the same process, refuses. A stale/malformed lock is never automatically stolen. After a crash, verify the recorded process is no longer running on its recorded host, stop all coordinators, then manually remove only `coordinator.lock`. Never remove a lock merely because a timer elapsed. Release checks original inode and content and does not remove a changed owner.

To downgrade: stop Paseo, preserve the current run file and restricted artifacts, then restore the appropriate exact backup before starting the older plugin. Version 1 readers cannot interpret version 2; RPC compatibility is not disk downgrade compatibility. Restoring a backup discards newer metadata and does not undo external effects. Reconcile unknown operations before allowing new execution on a restored history. Fresh installations have no migration backup.

## Verification

The coordinator regression suite injects interruption before/after artifact publication and queued/reserved/starting/running metadata commits, reopens real stores, and checks duplicate identity, frozen replay, capacity dimensions, overlap modes, retries/circuits, cold adoption and unknown effects.

Standalone cold-process smoke used the real server preparation/launch adapter with a local inert host stand-in, no paid model agents. The first process was SIGKILLed inside agent creation after persisted `starting` and host acceptance. A second process refused the stale lock. After confirming the owner PID absent and manually removing that lock, a fresh process adopted the same UUID without a second launch despite edited bot/model configuration; another cold process reconciled terminal evidence as completed/task-outcome-unknown. No live installed-plugin or Windows validation is claimed.
