# Schedule runtime contract

New routines save an explicit `schedulePolicy` alongside their existing `schedule`:

```json
{
  "version": 1,
  "timeZone": "America/New_York",
  "gap": "skip",
  "repeat": "first"
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

An interval remains elapsed time anchored to its previous run or creation, not a wall-clock recurrence. An absolute one-time schedule remains an absolute instant. Webhooks have no clock occurrence. Their stored policy does not change those semantics.

The runtime uses Gregorian calendar fields and the host's timezone data. It does not infer daylight-saving offsets from the current offset. `shared/zoned-schedules.ts` resolves candidate wall times against offsets around each date, including non-hour transitions. Cron matching remains minute-granular; a previously missed occurrence still follows the scheduler's existing catch-up policy.

## Preview API

`bots.routines.preview-schedule` accepts:

```text
{ schedule, schedulePolicy?, since: ISO, after: ISO, count: 1..50 }
```

It returns the actual UTC instant (`at`) and zoned wall-clock/offset display (`localTime`) for each upcoming occurrence, plus the effective policy, `legacyLocalTime` and `elapsed`. The legacy flag applies only to calendar schedules without a policy. Preview is read-only and does not require an attached model host or create an agent. Invalid cron expressions and zones fail explicitly rather than returning an apparently valid empty preview.

The same `nextRun`, `latestDue` and `upcomingRuns` implementation drives preview and scheduler decisions. `upcomingRuns` takes `{count, policy?}` as its fourth argument. Descriptions include the zone and transition choices when a calendar policy exists.

## Rollback

This additive field does not rewrite legacy schedules. Preserve the config file before downgrading: older versions do not understand `schedulePolicy` and can interpret these routines in host-local time or drop the field on their next save. Disable or deliberately convert new zoned calendar routines before running an older scheduler. A backup from before routine creation does not contain later routines or edits. Run-store backups and execution recovery have their own rollback requirements; restoring a config file does not stop an already running agent.

## Verification

Targeted scheduling fixtures cover New York gaps and repeats, the Lord Howe half-hour transition, Kathmandu's quarter-hour offset, Apia's skipped calendar date, repeated-hour minute ordering, cron day-field conjunction, elapsed intervals, legacy preservation and explicit adoption. Real registered preview handlers are exercised without a host API. A separate Bun smoke observed spring skip, spring shift and both fall instants using the production preview function. Actual editor/rendering evidence is documented with the UI delivery.
