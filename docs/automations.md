# Automations

Open **Automations** (the calendar-clock icon) in the bot-list footer. **Routine catalog** manages all configured routines; **Run history** inspects retained executions. Fleet, bot search, pins, reorder and the routine editor remain separate. Catalog and history filters, cursor position and selection stay mounted while a run detail is open. Compact Back returns to the originating catalog/history view, then to bots.

Only the selected catalog/history view polls, every five seconds. The catalog makes one bounded shared request, not one history request per bot. Opening details suspends those list polls and refreshes only that run's detail. Errors stay accessible even when cached data is displayed. The client uses the selected host's existing plugin RPC/query context; it never creates a hidden chat to attach the host.

## Unsaved edits and concurrent changes

Opening Automations awaits the bot-draft flush and refuses navigation while any draft remains. An acknowledged catalog pause cannot be undone by an older full-bot autosave retry: each draft captures its original bot baseline and rebases only changed root fields against the fresh CAS revision. Untouched routine booleans, other saved fields and operation receipts remain authoritative.

Concurrent edits to the same root field, or dependent execution/model/permission fields, refuse the entire draft write instead of blindly merging security settings or complex arrays. `updatedAt` alone is not a user edit. Deleted or replaced bots are not recreated. An own earlier autosave acknowledgement advances the baseline of later keystrokes, including an explicit return to the original value.

Failed or conflicting drafts stay available. Retry saving after a transient failure, or explicitly discard unsaved edits and review the saved bot before editing again. Discarding a draft does not revert a saved pause or receipt. Discard is disabled during an in-flight draft save; its callback also checks the live write state.

## Routine catalog

The catalog includes paused routines and archived bots, with exact bot/routine IDs and team labels. Each row shows:

- Enabled/paused state and managed/legacy execution mode.
- Next prospective UTC instant, zoned local display and IANA zone. A paused routine's next time is what its schedule would produce if resumed, not a promised launch. Legacy wall-clock schedules retain the host-local interpretation; intervals are elapsed durations and once schedules are absolute instants.
- Last execution status **and** task outcome, plus retained-ledger active, permission-wait and unknown counts. Ledger counts are not a complete live host census.
- A current owner only when a unique active agent was observed through a **complete** supported host snapshot. One visible agent on a partial page cannot establish unique ownership. Positive permission-wait observations remain valid even when the census is incomplete.
- Configured effective provider/model, corrected selectable provider-default model selection, per-field policy sources and resolved time/token/cost budgets. These describe current configuration, not the immutable configuration of an older run. Legacy mode does not advertise managed accounting or enforcement. Dollar/token limits are not claimed to be hard in-flight limits without an enforcement producer.
- Spend and escalation count as unavailable (`null`), never fabricated zeroes. B08 usage, B09 routing and B10 bridge producers are not implemented by this page.

Choose a bot, enabled state or attention filter, or enter an exact team/provider/model ID, then press **Apply global filters**. All filters run on the server before pagination; there is no partial-page search masquerading as a global filter. The catalog returns at most 100 rows per UI request, with opaque Next/Previous cursors. A changed configuration/filter or a removed attention cursor requires **Reload first catalog page**. Names and row positions are never selection identities.

Attention filters match only actual positive evidence:

- **Permission requests**: a retained `waiting_for_user` execution or an observed pending host permission. Without a complete supported host snapshot, absence of a permission request is unavailable rather than healthy.
- **Unknown outcomes**: retained unknown execution or terminal unverified outcome evidence. An active task's normally unknown task outcome alone is not a terminal failure claim.
- **Stale models**: configured selection is absent from the current selectable provider/model evidence. Unavailable provider evidence remains unavailable.
- **Memory failure** and **budget exhaustion**: unavailable until a structured producer exists. Error-message substring matching, missing usage, and a configured limit are not evidence of these failures; the filters do not manufacture matches.

## Exact selection and pause/resume

Checkboxes retain exact opaque target IDs across catalog pages and filter changes. **Select current page** adds only the currently returned IDs; it never means all routines matching a changing filter. Selection is capped at 500 targets. Single-row Pause/Resume and bulk actions use the same preview/apply service.

A preview freezes `{ operationId, revision, targetIds, enabled }` before the request starts. Review every selected bot/routine ID, old/new enabled value, warning and incompatibility. Apply sends that exact request and preview digest. Later selection/filter changes cannot change an in-flight review. Pausing affects future admissions only: it does not cancel active runs or erase unknown external effects. Resuming permits future scheduled work; it is not a retry of a previous run.

Resume qualifies current provider/model/thinking/approval and routine policy evidence using the same corrected selection checker as Fleet. Unknown or incompatible evidence, missing/duplicate targets, stale config revision or a changed preview digest refuses the whole operation. Remote-host routine execution remains unsupported on the storing host. Pause can work while disconnected because it does not enable execution.

`BotStore.apply` saves all selected enabled booleans and one operation receipt in the same serialized atomic config write. Receipts retain only target/bot/routine IDs, old/new booleans and an affected-routine hash, plus operation/body/revision metadata. They do not copy prompts, bot configuration, tool headers, accounts or credentials. The audit is bounded by 500 rows per operation and the shared 200-receipt retention policy; unresolved pinned operations cannot be evicted to make room.

Identical operation ID and body replay the existing receipt, even after later unrelated edits. The same ID with changed content conflicts. A transport failure during apply/revert has an unknown outcome: retry the **same exact** request to recover its receipt, not a freshly generated operation. Pending/uncertain operation identities live in the host-scoped React Query session cache and survive catalog remounts, not a full application reload. After reload, inspect current rows and retained run/operation evidence before deliberately issuing another workload.

Conflicts require a successful explicit **Refresh catalog** and a new explicit preview; background polling never silently re-previews or applies. Revert is a new audited CAS transition, restoring only reviewed enabled booleans. It preserves unrelated bot/routine edits, but refuses changed affected-routine hashes, missing targets or a now-incompatible re-enable. It never restores a whole configuration snapshot or stops active work.

## Run now

**Run now** creates a new manual occurrence, including for a paused routine. The caller supplies a required request ID; transport retries reuse it. A successful request exposes **New run** for an explicitly distinct workload, rather than reusing a completed workload's identity.

The scheduler checks durable request identity/body equality before looking up mutable bot/routine settings. Repeated identical requests return the original run/snapshot; changed-body identity reuse conflicts. The page calls this same scheduler service for legacy and explicitly opted-in managed bots. It never directly creates an agent, changes execution mode, or reruns unknown external effects as an automatic recovery action.

## Run history

History uses `bots.runs.list` with 25 records per page. Bot, routine and execution-status filters apply to the full retained history on the server. Changing filters resets pagination; changing bots clears the routine filter. Next uses the returned opaque cursor unchanged; Previous retains the cursor history. No total count or client-only filtering over incomplete pages is advertised.

Execution and task outcome are independent facts. A completed turn with `taskOutcome: unknown` is not verified success. Cancellation is not proof of rollback. Elapsed time is between recorded timestamps, not provider CPU time; without an observed end it is labeled as time since recorded start. Invalid or inverted timestamps show unavailable.

Coordinator readiness is explicit:

- `waiting_for_host_api`: attach to the host normally. No hidden model chat wakes the scheduler.
- `reconciling`: persisted runs are being compared with supported host evidence.
- `ready`: the coordinator is ready; this is not task verification.
- `stopped`: retained history remains visible.

## Immutable safe run details

Details call `bots.runs.details` for the retained selected run. The server reads the coordinator's immutable admitted snapshot, not current mutable bot settings. Missing/legacy/expired snapshots stay explicitly unavailable; current policy is never substituted.

The allowlist shows selected provider/model and requested execution settings/sources/budgets; permission modes and counts (not permission rules or MCP configs); prompt hashes and environment version; actual memory receipt hash/budget statistics; pinned playbook IDs/versions/content hashes; run/cycle/attempt/execution/session/occurrence identities; attempts and creation/timeline/recovery/cancellation evidence; and pinned verifier identity/digest when present. Routing reason remains unavailable without a routing producer.

Private input locators are represented only by SHA-256-derived reference identities. A locator hash is **not a file content hash**. Snapshot, result and evidence artifact IDs/content hashes are shown without fetching private contents into the UI. A recorded reference does not claim its file availability was checked. Reply/timeline completeness comes from retained evidence, not the public excerpt. External-action receipts remain unavailable until an actual producer supplies them.

Raw prepared configuration, prompt text, model output, environment values, tool headers, app rules, relay/controller tokens and arbitrary input URLs/paths are not serialized by the detail projection. The UI has no unsafe Retry action: recovery explains the current stage and replay boundary instead of restarting unknown purchases, messages or writes.

## Cancellation and reconciliation

**Request cancellation** uses `bots.runs.cancel` for managed active work or unknown work that retains a reservation. Before launch, queued/reserved cancellation can commit `canceled` and `no_change`. Active cancellation records the request but never optimistically changes execution status.

Plugin SDK 0.11.1 has no supported active interrupt API. The returned unsupported error remains visible; `cancelRequested` is not confirmation, and reservation/unknown effects stay retained until host evidence resolves them. The client never archives the agent or calls private `DaemonClient.cancelAgent` as a workaround. Explicit reconciliation observes host snapshots/timeline evidence and does not retry the task.

Cancel, reconcile, pause/resume, revert and manual run requests have pending/error states and invalidate catalog/history/detail queries after completion. Detail cancellation merges the authoritative response while preserving immutable snapshot metadata, and prevents older in-flight detail reads from overwriting it.

## Server composition and compatibility

`registerAutomations(server, host, scheduler)` from `server/automations.ts` registers the new services, including `registerRunDetails`. The integration owner calls it once in `index.server.ts`.

New contracts live in `shared/automations.ts`: `automationsListRpc`, `automationsPreviewRpc`, `automationsApplyRpc`, `automationsRevertRpc`, and `automationsRunNowRpc`. Safe details use `runsDetailsRpc` in `shared/run-details.ts`. Existing `bots.routines.status`, `bots.runs.list/get/cancel/reconcile`, schedule editor and schedule preview contracts remain unchanged.

`useBotDrafts` exposes live `hasPendingDrafts()`, `draftSaving`, `draftConflicts`, and `discardDrafts(botId?)` recovery state. Surface guards use `DraftRecovery` for retry/discard/review controls; review must check live remaining drafts after discard before navigating, rather than relying on an earlier render's saving flag. The integration owner owns those `BotsSurface` render guards and desktop/compact validation.

There is no automatic execution-mode adoption, schedule-policy migration, accounting/routing implementation or client-side file writer. The optional routine audit extends version-2 configuration receipts; older code may strip that audit on rewrite. Preserve configuration backups and retained coordinator evidence before downgrade. Removing this UI never cancels executions or releases reservations, and restoring config does not undo external effects.

## Verification scope

Consumer tests cover exact 100-row atomic pause/resume, replay/concurrency, stale/digest/missing/duplicate target refusal, resume qualification, scoped revert, bounded receipt pressure, global attention filters and opaque cursor conflicts, complete-census owner evidence, schedule projections, frozen client requests, stable run-now identities, immutable details, reference redaction and honest cancellation. Draft regressions exercise actual file-backed CAS conflicts, preservation of acknowledged pause receipts, conflicting selector/security/array edits, deletion/replacement and own-ACK/later-keystroke transitions. A temporary loopback HTTP/service smoke verifies delayed stale CAS rejection, V1-to-V2 acknowledgement, pause/receipt preservation, retained conflicting drafts and partial/complete census ownership without live model execution. Desktop/compact rendering and installed-host integration remain the integration owner's separately authorized validation; headless tests do not prove those surfaces.
