# Fleet operations

Fleet changes affect future chats and routine launches only. They never edit, restart, cancel, or
reconfigure host agents. There is no new config writer or store.

## API and services

`shared/fleet.ts` defines `bots.fleet.list`, `bots.fleet.preview-change`,
`bots.fleet.apply-change`, and `bots.fleet.revert-change`. `index.server.ts` registers them.
`server/fleet.ts` exports `listFleet`, `previewFleetChange`, `applyFleetChange`,
`revertFleetChange`, and the optional control-boundary callback type `FleetAuthorize`.

Preview freezes 1 to 500 exact, unique bot IDs. Missing IDs fail the entire request; no server-side
filter is rerun. Each row includes the stored before/after bot and both effective resolutions with
field sources. Per-field issues include provider, model, thinking, policy, capability and approval
incompatibilities. All rows must qualify before apply. Permission fields are not accepted in patches.
Explicit unset uses the policy resolver's dependent inheritance closure; clearing provider also
inherits model and thinking. A null binding removes only the bot policy, not team/global policies.

Provider-default selection uses the marked default or the first selectable model, exactly as chat
launch does. A provider with no selectable model makes the operation incompatible, including when
the stored model is null. Thinking options are checked against that same effective model.

A preview digest binds the parsed request, entire config state, exact before/after rows and host
provider evidence. Resolution uses one provider snapshot for both sides, with no artificial observation
timestamp in the digest. Apply reacquires that evidence inside the authoritative writer queue and
checks the digest before changing anything. Effective before/after providers are compared explicitly
with `validateProviderTransition`, preserving the original approval class and explicit tool grants.
Unknown host evidence cannot qualify an apply. Any conflict requires a fresh operator preview; the
backend never substitutes targets or silently regenerates a request.

MCP tools `fleet_list`, `fleet_preview_change`, `fleet_apply_change`, and `fleet_revert_change` use the
same services. Effective provider switches additionally require External control's elevated-changes
setting; otherwise the tool refuses and directs the operator to apply in Paseo. This also covers
provider switches through policy binding and inheritance reset. Compatibility checks still apply even
when elevated changes are enabled. The authorization callback runs inside the config transaction.

## One transition, replay and retention

`BotStore.apply` checks operation ID and body identity before stale-revision checks, host acquisition,
or authorization. Same ID and exact body (including preview digest) replays the original receipt even
after later writes. A changed body conflicts. The response `revision` is the current state revision;
the receipt's `newRevision` remains the revision of the original successful operation.

The store supports asynchronous operation callbacks while holding its writer queue and supplies
`scope.revision` from the state actually being changed. Configuration, audit and receipt revision pair
reach disk in one atomic replace. A callback failure performs no write. Existing proposal publication
pins and capacity refusal remain intact: at most 200 receipts, oldest unpinned first; unresolved effects
are never evicted. Fleet operations have no external publication phase, so they do not need pins.
Once evicted, a fleet receipt is no longer available for replay or revert. Its old revision still
prevents a stale request from applying again.

### Revision self-reference

Envelope version remains 2. Config revision is SHA-256 of `JSON.stringify({ version: 2, values })`,
where values have been normalized through `BotStateSchema` and **only receipt `newRevision` fields
are omitted**. All other receipt fields, pins, policies, config and fleet audits contribute. This
avoids requiring a digest to contain its own digest. `persist` computes the revision and populates the
new receipt's `originalRevision`/`newRevision` before its single atomic write. Existing receipt pairs
are never rewritten on later config changes, pin release, retention or replay. Reads use precisely
the same normalization, including older version-2 states without fleet metadata. These revisions
are content-derived identities, not raw-file checksums. Formatting-only edits do not change them.
Clients holding a pre-upgrade raw-file revision must reload once before writing.

The version-1 migration backup checksum remains the checksum of the original raw backup, unchanged.

## Revert

Revert has its own operation ID, expected current revision and audited receipt. It requires the original
fleet-change receipt and checks the whole current content hash of every affected bot against the
applied after-state. Any later affected-bot edit, deletion or incompatible current host evidence refuses
the entire revert. Unrelated bots, UI state, policies and library changes are preserved. Only the prior
execution overrides, bot binding/inheritance and a fresh update timestamp are restored, never an entire
state snapshot. Audit rows retain only execution overrides and hashes, not instructions, tool configs,
app-account metadata or credentials. Revert receipts themselves are not revert targets.

## Availability and usage

List acquires one shared host agents snapshot, not a request per bot. Running and initializing,
non-archived agents count as active work. An absent, failed or paginated/incomplete snapshot yields
`activeWork: null` with an explanation for every bot, never a manufactured zero. Complete snapshots
can establish zero. Latest routine execution status and task outcome stay separate. Missing outcomes
remain unknown. Spend is always null with an explanation: usage aggregation belongs to B08, and this
backend does not sum cumulative host usage snapshots.

## Rollback

Stop the daemon and preserve `state.json` before downgrading. Existing version-2 configurations remain
readable, but an older plugin can drop fleet receipt metadata on its next save and cannot interpret
normalized fleet revision identities. There is no automatic downgrade that preserves replay/revert
history. Restore a pre-upgrade whole-state backup only if intentionally discarding subsequent changes;
never restore it over a running daemon. For rollback to envelope version 1, use the original
`state.json.v1.bak` procedure in `policies.md`; that also discards newer changes. Active external work
is not canceled by a rollback and must not be restarted merely because its state is uncertain.
