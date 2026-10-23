# Schedule editor

Open a bot's settings panel, then **Routines** and **New routine**, or an existing routine's **Edit routine** action.

## Timezone and DST choices

New routines start with an explicit version-1 schedule policy from the current device's IANA timezone. Before saving, review or change all three visible fields:

- **IANA time zone**, for example `America/New_York` or `Asia/Kathmandu`.
- **DST gap (missing local time)**: skip the missing occurrence, or shift it forward by the actual clock change.
- **DST repeat (local time occurs twice)**: first instant only, second instant only, or both instants.

Defaults are skip gaps and use the first repeated instant. Invalid timezone or policy prevents saving and previewing. This uses the shared policy schema, not a separate timezone implementation.

An existing routine without `schedulePolicy` stays legacy host-local when edited, regardless of its prompt text. **Adopt explicit policy** initializes visible choices; only saving persists adoption. Canceling leaves the routine unchanged. Editing preserves routine identity, creation time, paused/enabled state, execution overrides, approval mode, and results-chat selection.

Wall-clock cron/daily schedules use the selected zone and DST policy. Intervals remain elapsed durations. A once schedule remains an absolute instant; its existing At field accepts device-local date/time. Webhooks remain event-driven. Policy fields remain visible for these schedules but do not change their trigger semantics.

## Preview without saving or running

**Preview after (ISO UTC)** accepts a selected boundary such as `2026-11-01T05:00:00Z`. **Preview next 5 occurrences** calls `bots.routines.preview-schedule` with the exact unsaved schedule, optional policy, creation-time anchor (`since`), selected boundary (`after`), and count 5. A malformed boundary disables preview, not saving: it is not part of the saved routine.

The server returns actual ISO instants and zoned local displays including UTC offsets. Legacy host-local interpretation and elapsed-interval behavior are labeled separately. Interval previews display the creation-time anchor; they are hypothetical from that anchor, not a promise about an existing run's last-run timestamp or admission capacity. Preview does not start a bot, save a routine, or create a chat. Empty results and RPC errors are shown explicitly.

Changing cadence, raw cron/once text, timezone, gap/repeat choice, adoption, or preview boundary immediately clears the old result/error/pending state. Request tokens ignore late successes and failures, including after editing back to earlier values. Invalid raw once input never previews the last valid date silently.

### DST inspection examples

Use `America/New_York`, enter a custom cron, and preview after the boundary:

| Case | Cron | Preview after | Expected first occurrences |
| --- | --- | --- | --- |
| Fall repeat, both | `30 1 * * *` | `2026-11-01T05:00:00Z` | `05:30Z` and `06:30Z`, both 01:30 locally with different offsets |
| Spring gap, shift forward | `30 2 * * *` | `2026-03-08T06:00:00Z` | `2026-03-08T07:30:00Z`, 03:30 locally |
| Spring gap, skip | `30 2 * * *` | `2026-03-08T06:00:00Z` | `2026-03-09T06:30:00Z`, next day's 02:30 |

Routine rows, bot summaries, upcoming run calculations, and proposal cards pass optional policy to the shared scheduling helpers. The Runs sheet displays instants in the current device's local time and includes each routine's schedule policy in its hint.

## Integration and rollback

Client-only additions are `SchedulePolicySection.tsx`, `useScheduleEditor.ts`, and `schedule-editor.ts` under `client/panel/routines/`. `useScheduleEditor` owns invalidation and real RPC request state. `applyRoutineDraft` validates policy while preserving non-editor fields. `reducePreview` guards visible state using request tokens. No shared schema, server handler, or timezone algorithm is defined by the editor.

The integration owner must register the existing preview RPC handler and supply the optional policy field in the routine proposal schema. Old routines remain absent-policy until explicit adoption. Reverting UI changes alone does not remove policies already saved; do not use an older scheduler that ignores explicit policies without reviewing their interpretation.

Behavior coverage is in `tests/schedule-editor.test.ts`: new versus legacy, explicit adoption, field preservation, invalid zone/policy rejection, immutable preview drafts, DST boundary choices, elapsed intervals, stale replies, and policy-aware upcoming lists. Actual host rendering and screenshots are owned by the B07 integration lane; standalone helper verification does not establish visual/mobile correctness.
