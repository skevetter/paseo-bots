# Schedule runtime contract

New routines save an explicit `schedulePolicy` alongside their existing `schedule`:

```json
{
  "version": 1,
  "timeZone": "America/New_York",
  "gap": "skip",
  "repeat": "first",
  "catchUp": { "windowSeconds": 43200, "maxOccurrences": 1, "strategy": "coalesce" },
  "jitterToleranceSeconds": 0
}
```

`timeZone` must be an IANA identifier supported by the host's `Intl.DateTimeFormat`. Unknown zones, missing gap/repeat choices and unsupported policy versions are rejected. Policy versioning is independent of the config-file envelope version.

## Existing schedules

A routine without `schedulePolicy` retains the previous host-local interpretation. Merely reading, renaming, pausing or changing its prompt does not add a policy. Adopting an explicit policy is an intentional edit. Existing cron semantics remain unchanged: day-of-month and day-of-week must both match.

New routines created by the form, configuration changes or routine proposals save the current device/host's resolved IANA zone, skip missing wall-clock times and choose the first repeated instant unless the caller provides explicit choices. MCP creation/proposal accepts `schedule_policy`; MCP update can adopt or change it. A proposal records its chosen policy before confirmation so the preview and accepted routine share one interpretation. Legacy pending routine proposals acquire an explicit policy when accepted.

## Clock transitions

Calendar schedules (`daily` and `cron`) evaluate the requested wall-clock date and minute in the saved zone:

- `gap: skip`: a nonexistent local minute does not run.
- `gap: shift_forward`: move the nonexistent minute forward by the transition's duration. New York 02:30 becomes 03:30 during its one-hour spring gap. Half-hour gaps and skipped calendar dates use their actual duration.
- `repeat: first`: run at the earlier instant when the local minute repeats.
- `repeat: second`: run at the later instant.
- `repeat: both`: retain both distinct instants, with distinct due timestamps and occurrence identities.

An interval remains elapsed time anchored to its previous intended occurrence or creation, not a wall-clock recurrence or late observed launch. An absolute one-time schedule remains an absolute instant. Webhooks have no clock occurrence. Their stored policy does not change those semantics.

The runtime uses Gregorian calendar fields and the host's timezone data. It does not infer daylight-saving offsets from the current offset. `shared/zoned-schedules.ts` resolves candidate wall times against offsets around each date, including non-hour transitions. Cron matching remains minute-granular; a previously missed occurrence still follows the scheduler's existing catch-up policy.

## Preview API

`bots.routines.preview-schedule` accepts:

```text
{ schedule, schedulePolicy?, since: ISO, after: ISO, count: 1..50 }
```

It returns the actual UTC instant (`at`) and zoned wall-clock/offset display (`localTime`) for each upcoming occurrence, plus the effective policy, `legacyLocalTime` and `elapsed`. The legacy flag applies only to calendar schedules without a policy. Preview is read-only and does not require an attached model host or create an agent. Invalid cron expressions and zones fail explicitly rather than returning an apparently valid empty preview.

The same `nextRun`, `latestDue` and `upcomingRuns` implementation drives preview and scheduler decisions. `upcomingRuns` takes `{count, policy?}` as its fourth argument. Descriptions include the zone and transition choices when a calendar policy exists.

## Rollback

Config envelope v4 prevents older readers from silently stripping `schedulePolicy` or reinterpreting it as host-local time. Preserve the current configuration and execution evidence before downgrading, then deliberately restore a verified pre-upgrade configuration backup as described in `policies.md`. A backup does not contain later routines, receipts or edits. Restoring config does not stop an already running agent.

## Occurrence recovery

Policies set `catchUp {windowSeconds 60..604800, maxOccurrences 1..100, strategy latest|queue|coalesce}` and `jitterToleranceSeconds 0..3600`. New policies record the explicit 43200-second window, `maxOccurrences: 1`, `strategy: coalesce`, and jitter 0. `recoveryOf` supplies those version-1 semantics for older explicit policies without the fields. A routine without `schedulePolicy` stays legacy and does not adopt these defaults.

`planOccurrences(routine, lastRunAt, now)` in `shared/schedule-recovery.ts` returns `{ runs, summaries, plannedThrough }`:

- `runs`: selected admission candidates, at most `maxOccurrences`, all inside the window. Ordinary overlap, permissions, deadline and capacity rules still apply; recovery selection does not grant extra concurrency. Legacy launches retain their existing overlap behavior.
- `latest`: select only the newest in-window occurrence, with one bounded `recovery_limit` receipt for suppressed in-window occurrences.
- `queue`: select the newest `maxOccurrences` in-window occurrences; the older in-window remainder is one `recovery_limit` summary. Choose the managed runtime's `queue` overlap policy when these candidates must wait rather than skip overlapping work.
- `coalesce`: select the newest occurrence; the suppressed remainder is one `coalesced` summary with `into` set to its intended instant.
- Occurrences older than the window produce one `outside_window` summary.
- `count` is exact for intervals and for calendar schedules up to 400 enumerated occurrences; otherwise `null`. Skipped work is never reported as `skipped=no_change`.
- Suppressed occurrences produce one run with a typed `run.recovery` receipt per bounded summary, not one history row for every missed occurrence: `{reason, count, firstDue, plannedThrough, into}` per `ScheduleRecoveryReceiptSchema` in `shared/runs.ts`. `count` and `firstDue`/`into` are `null` when unknown or absent; `plannedThrough` is the planned cursor. These summary runs keep `run.error` `null`; recovery wording is not stored as error text. Older records without typed recovery retain that absence; receipts are never reconstructed from earlier error text.
- `plannedThrough` is the latest intended occurrence at or before `now`. Managed recovery stages all selected frozen artifacts, then commits selected intents and bounded suppression receipts in one authoritative snapshot before any selected SDK creation. The intended cursor advances monotonically through those committed receipts. Legacy recovery commits a chronological prefix, never advancing past a not-yet-admitted selected occurrence. A crash therefore cannot skip an uncommitted part of the plan.
- An occurrence whose configured deadline cannot be represented as a safe epoch-millisecond instant is committed as a failed, unknown-outcome, not-created rejection. It is not clamped or launched. Other suppression receipts and the intended cursor still commit, so the same invalid occurrence cannot wedge every later tick.
- An initially missing host API does not consume an ordinary managed occurrence. Its readiness refusal remains outside deadline/preparation rejection capture, so the same request can be admitted after the supported API attaches.
- Intervals keep their elapsed phase from the previous run or creation. Calendar occurrences use the zone rules in "Clock transitions" and cron day-of-month AND day-of-week.
- The editor offers elapsed intervals as their own "Every N minutes (elapsed)" choice with a Minutes field (whole minutes, 5 to 1440). Opening, saving, or editing an interval keeps `kind: "interval"` and `minutes`; it is never converted to a rounded cron expression. Invalid minutes block Save and Preview rather than being rounded.
- `scheduleNotBefore(routine, due)` returns the earliest epoch ms to execute an occurrence. With tolerance 0 it equals `due`. Otherwise it is a deterministic FNV-1a offset in `[due, due + tolerance]`, keyed on routine id and due instant, so restarts do not reshuffle it.
- Legacy routines (no policy) use the existing `decide` path: a single run inside its 12-hour catch-up, otherwise one `outside_window` summary with `count: null`.

## Verification

Targeted scheduling fixtures cover New York gaps and repeats, the Lord Howe half-hour transition, Kathmandu's quarter-hour offset, Apia's skipped calendar date, repeated-hour minute ordering, cron day-field conjunction, elapsed intervals, legacy preservation and explicit adoption. Real registered preview handlers are exercised without a host API. A separate Bun smoke observed spring skip, spring shift and both fall instants using the production preview function. Actual editor/rendering evidence is documented with the UI delivery.
