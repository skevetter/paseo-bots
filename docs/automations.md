# Automations

Open **Automations** (the calendar-clock icon) in the bot-list footer. Fleet, bot search, pins, reorder and the existing routine editor remain separate. On compact layouts, Back steps from run details to the run list, then back to bots. Opening a bot chat or Fleet exits Automations.

## Run list and filters

The page calls `bots.runs.list` with 25 records per page. Bot, routine and execution-status filters are server-side and apply to the full retained history, not only the displayed page. Choose a bot to see its configured routines. Archived bots remain available in the bot filter. Names are display labels; requests use opaque IDs.

Next uses the returned opaque cursor unchanged. Previous uses the cursor history for this filter selection. Changing a filter resets pagination; changing bots also clears the routine filter. The page does not claim a total count or sort/filter an incomplete local collection. Refresh reloads the current page. If retention removed its cursor, the server error is visible and **Reload first page** starts over with the same filters. Query errors remain visible even when cached data is displayed.

The current page refreshes every five seconds. Details use `bots.runs.get`, refresh independently, and remain addressable by run ID even when that run is not in the displayed list page. A removed run is shown as not found, not as an empty successful execution.

## Execution is not task outcome

Each row shows execution status and task outcome separately, plus purpose, trigger, occurrence, attempt ID, scheduled instant and elapsed recorded time. Elapsed time is between recorded timestamps, not a claim of provider CPU time. Without an observed end it is labeled as time since recorded start. Invalid or inverted timestamps show unavailable.

`completed` with `taskOutcome: unknown` is not verified success. `canceled` does not prove rollback of external effects. Unknown execution or creation evidence remains unknown; this page does not retry work or infer that it stopped.

Coordinator readiness is shown explicitly:

- `waiting_for_host_api`: attach to the host normally. No hidden model chat is launched to wake the scheduler.
- `reconciling`: persisted runs are being compared with host evidence.
- `ready`: the coordinator can admit work; this says nothing about task verification.
- `stopped`: retained history remains visible.

## Details and safe snapshot metadata

Details show run/cycle/attempt/execution/session/occurrence/parent identities, provider-turn evidence, purpose, timestamps and pinned verification evidence when present. Managed records also show bot/routine/request IDs, client message ID, provider/model, artifact ID and SHA-256, prompt hashes, environment version, resource IDs, overlap policy and limit, reservation, not-before instant, coalescing target, timeline epoch/sequence, creation key/revision/phase/unknown outcome, and attempts with their identities, idempotency keys, states and errors.

The UI uses an explicit metadata allowlist. It does not fetch execution artifact contents, private prompts, environment values, relay credentials or raw model output. There is no private SDK call, new agent creation, or hidden chat navigation. Historic records without managed metadata are labeled as unavailable rather than assigned invented identities.

## Cancellation and reconciliation

**Request cancellation** calls `bots.runs.cancel` for managed active work or unknown work that retains a reservation. A queued or reserved run can be canceled atomically before launch. The response is authoritative; the client never optimistically changes execution status.

Paseo plugin SDK 0.11.1 has no supported active interrupt API. For active work, the coordinator records `cancelRequested`, retains its reservation, and returns an explicit unsupported error. Details show that error and the updated record: cancellation requested, not confirmed. Unknown external effects remain unknown. The client never archives the agent or calls private `DaemonClient.cancelAgent` to work around this limitation.

**Reconcile run** calls `bots.runs.reconcile` with the selected ID; **Reconcile runs** omits it. Reconciliation observes supported host evidence, not model claims, and never retries the task. Cancel and reconcile have pending states, accessible errors, and invalidate both run-list and detail queries afterward. A refresh error is not swallowed by cached data.

## Compatibility and rollback

This page consumes the new managed-run API; it does not replace `bots.routines.status`, edit schedule policy, migrate routine settings, or write run files. There is no client-side data migration or feature flag. Removing the page does not cancel executions, release reservations, or revert server run records. On-disk compatibility and coordinator recovery belong to the run-store implementation; do not downgrade its data independently while work has unknown effects.

## Verification scope

`tests/automations-ui.test.ts` covers opaque cursor navigation, filter reset boundaries, compact back-navigation state, cancellation/unknown evidence, safe metadata projection, and recorded-time boundaries. Native rendering and real host RPC integration require an authorized scratch Paseo runtime; headless helper tests alone do not prove the rendered UI.
