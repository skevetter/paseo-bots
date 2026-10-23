# Fleet UI

Open Bots, then press Fleet (the checklist icon) in the existing bot-list footer. Sidebar search, team tabs, pins and ordering remain independent of fleet filters and selection.

## Inspect and select

Fleet reads `bots.fleet.list`. Rows show the effective provider/model and their policy source, direct bot policy binding, execution status, task outcome, active work, spend and attention messages. `completed` is an execution fact, never a successful-task claim. Missing work/spend is unavailable, not zero.

Filters intersect team, effective provider, effective model, policy and execution status. Policy matches the direct binding or any resolved field source, including global/team policies. Inheritance exceptions means explicit execution overrides or resolution issues. Selection uses exact opaque bot IDs and survives filter changes; the selected count includes hidden rows. Select visible adds the current visible IDs; Clear selection clears all IDs. Each operation is limited to 500 targets.

Tab focuses row checkboxes. Space or Enter toggles one. Shift activation adds the inclusive current-visible range from the selection anchor, preserving hidden selected IDs. Native accessibility activation uses the checkbox press action. Details opens a slide-over with the complete resolution and reset-to-inherited actions.

## Preview, apply and revert

The bulk sheet copies its target IDs when opened. Choose a bot policy binding, optionally pin its displayed immutable revision, or leave binding unchanged/unbind it. Unbinding the bot does not remove team/global policies. Binding alone does not remove explicit bot overrides. Choose Reset to inherited on provider/model/thinking to adopt those policy values. Resetting provider also resets model and thinking; resetting model also resets thinking. Provider default is explicit null for model/thinking, not inheritance. Explicit IDs accept host-supplied providers/models without a client allowlist.

Preview sends a new operation ID, current state revision, exact selected IDs, patch and explicit unset fields. It shows effective before/after settings, exact bot/resolution JSON on expansion, warnings and field-specific incompatibilities. Any form edit or Refresh fleet invalidates the preview. Late preview responses from before an edit are ignored. Apply sends the exact preview request and digest, never a rerun filter or regenerated selection. An incompatible row disables the entire apply. A stale conflict stays visible with the old preview for inspection; refresh and explicitly preview again before applying. A transport failure preserves the request for an explicit same-operation retry.

A successful/replayed apply shows its server receipt and original/new revisions. Revert this operation submits a new audited operation against the current fleet revision and applied receipt ID. It refuses later edits to affected bots and preserves unrelated configuration. A transport retry retains the revert operation ID/body. A successful revert is shown once; it is not automatically reversed again.

Active chats are not edited, canceled or restarted. Changes affect future chats/runs only. Approval modes and tool grants are separate from these execution patches. All resets, including the details drawer, use preview/apply RPCs rather than raw state writes. Unsaved bot drafts block fleet editing until saved, preventing an old autosave from overwriting the operation.

## Immutable policies

Policies opens the policy editor. Choose an existing policy to save a new revision or create a new policy. Earlier revisions remain unchanged. The advanced JSON editor accepts taskClasses, roles, routing, budget and concurrency using the shared strict schema. Name and purpose have separate fields. Omit a field to inherit; model/thinking null means provider default, delegated-role null disables delegation, and budget/concurrency null means unlimited. Permissions are not accepted in a policy body.

The editor captures the configuration revision when the draft opens. Conflicts preserve the draft and block saves/deletes until explicit reload. Delete asks for confirmation. A referenced policy is not deleted: every global/team/bot referrer is displayed, including opaque IDs. Remove bindings through their supported operation before retrying deletion.

## Portable imports

New bot imports, settings team imports and duplication admit parsed bots plus their portable policy definitions through `bots.imports.apply`. Bot configuration, immutable policy snapshots and local bindings commit together. Conflict errors reload settings and require explicit review; the client does not silently regenerate IDs or retry a fresh import. Existing parse-time permission/default handling and paused routines are retained. No source global/team binding is imported.

## Validation boundary

Behavioral tests cover a deterministic 100-bot fleet, effective-setting/source filters, opaque-ID selection, keyboard/range boundaries, stale and late previews, incompatible provider guards and referenced policy deletion. A direct Bun smoke exercises the real selection/filter and bulk state helpers with 100 rows. These checks do not establish rendering or host action success. Real desktop/compact screenshots and RPC action validation require the isolated scratch daemon with plugins explicitly authorized and the backend handlers integrated; do not enable plugins on a live daemon for validation.
