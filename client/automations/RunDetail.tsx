import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { type RoutineRun, runsCancelRpc, runsReconcileRpc } from "../../shared/rpc";
import { type RunDetails, runsDetailsRpc } from "../../shared/run-details";
import { errorText } from "../native";
import { Button } from "../panel/controls";
import {
  cancellationMessage,
  canRequestCancel,
  elapsedFact,
  type Fact,
  immutableSnapshotFacts,
  runDetailEvidenceFacts,
  snapshotFacts,
  withAuthoritativeRun,
} from "./run-presentation";

export const RUNS_KEY = ["paseo-bots", "runs"] as const;
type Colors = PluginTheme["colors"];

export function RunDetail({
  colors,
  runId,
  onBack,
  backLabel = "Back to runs",
}: {
  colors: Colors;
  runId: string;
  onBack(): void;
  backLabel?: string;
}) {
  const get = useRpc(runsDetailsRpc);
  const cancel = useRpc(runsCancelRpc);
  const reconcile = useRpc(runsReconcileRpc);
  const queryClient = useQueryClient();
  const queryKey = [...RUNS_KEY, "details", runId];
  const query = useQuery({ queryKey, queryFn: () => get({ runId }), refetchInterval: 5_000 });
  const [pending, setPending] = useState<"cancel" | "reconcile" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = query.data?.run;
  const act = async (kind: "cancel" | "reconcile") => {
    if (pending) return;
    setPending(kind);
    setError(null);
    try {
      if (kind === "cancel") {
        await queryClient.cancelQueries({ queryKey });
        const result = await cancel({ runId });
        await queryClient.cancelQueries({ queryKey });
        queryClient.setQueryData<RunDetails>(queryKey, (details) =>
          withAuthoritativeRun(details, result.run),
        );
        setError(result.error);
      } else {
        await reconcile({ runId });
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      await queryClient.invalidateQueries({ queryKey: RUNS_KEY });
      void queryClient.invalidateQueries({ queryKey: ["paseo-bots", "automations"] });
      setPending(null);
    }
  };
  return (
    <View style={{ flex: 1, backgroundColor: colors.surface0, padding: 16, gap: 12 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 22, flexGrow: 1 }}>
          Run details
        </Text>
        <Button
          colors={colors}
          label="Refresh run"
          loading={query.isFetching}
          disabled={!!pending}
          onPress={() => void query.refetch()}
        />
        <Button colors={colors} label={backLabel} onPress={onBack} />
      </View>
      {query.isPending ? (
        <ActivityIndicator accessibilityLabel="Loading run" color={colors.foregroundMuted} />
      ) : null}
      {query.error ? (
        <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>
          Run refresh failed: {errorText(query.error)}. Displayed data may be stale. Refresh run to retry.
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>
          {error}
        </Text>
      ) : null}
      {!query.isPending && !query.error && !run ? (
        <Text style={{ color: colors.foregroundMuted }}>
          Run not found. It may have been removed from retained history.
        </Text>
      ) : null}
      {run && query.data ? (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ gap: 12, paddingBottom: 24 }}
          keyboardShouldPersistTaps="handled"
        >
          <RunEvidence colors={colors} run={run} details={query.data} />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Button
              colors={colors}
              label="Reconcile run"
              loading={pending === "reconcile"}
              disabled={!!pending}
              onPress={() => void act("reconcile")}
            />
            {canRequestCancel(run) ? (
              <Button
                colors={colors}
                label="Request cancellation"
                loading={pending === "cancel"}
                disabled={!!pending || !!query.error}
                onPress={() => void act("cancel")}
              />
            ) : null}
          </View>
          <Text style={{ color: colors.foregroundMuted }}>
            Queued work can be canceled before launch. Active interruption is unsupported by this SDK;
            requesting it does not mean work stopped. Reconciliation observes supported host evidence and
            never retries the task.
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

function RunEvidence({ colors, run, details }: { colors: Colors; run: RoutineRun; details: RunDetails }) {
  const cancellation = cancellationMessage(run);
  return (
    <View style={{ gap: 12 }}>
      <FactList
        colors={colors}
        title="Execution and task outcome"
        facts={[
          ["Execution status", run.executionStatus],
          ["Task outcome", run.taskOutcome],
          ["Purpose", run.purpose],
          ["Trigger", run.trigger],
          ["Skipped", run.skipped ?? "No"],
          ["Scheduled for", run.scheduledFor],
          ["Recorded start", run.startedAt],
          ["Recorded end", run.endedAt ?? "Not observed"],
          ["Elapsed", elapsedFact(run, Date.now())],
        ]}
      />
      {cancellation ? (
        <Text accessibilityRole="alert" style={{ color: colors.foregroundMuted }}>
          {cancellation}
        </Text>
      ) : null}
      {run.error ? (
        <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>
          {run.error}
        </Text>
      ) : null}
      <FactList
        colors={colors}
        title="Identities"
        facts={[
          ["Run ID", run.id],
          ["Cycle ID", run.cycleId],
          ["Attempt ID", run.attemptId],
          ["Execution ID", run.executionId],
          ["Session epoch", String(run.sessionEpoch)],
          ["Occurrence", run.occurrenceKey],
          ["Parent run", run.parentRunId ?? "None"],
          ["Agent ID", run.agentId ?? "Not observed"],
          ["Provider turn ID (evidence only)", run.providerTurnId ?? "Not observed"],
        ]}
      />
      <FactList colors={colors} title="Safe snapshot and coordinator metadata" facts={snapshotFacts(run)} />
      <FactList
        colors={colors}
        title="Immutable admitted configuration"
        facts={immutableSnapshotFacts(details.snapshot)}
      />
      <FactList colors={colors} title="Artifacts and recovery" facts={runDetailEvidenceFacts(details)} />
      {run.verification ? (
        <FactList
          colors={colors}
          title="Verification"
          facts={[
            ["Verifier", run.verification.verifier.id],
            ["Pinned digest", run.verification.verifier.digest],
            ["Verified at", run.verification.at],
          ]}
        />
      ) : (
        <Text style={{ color: colors.foregroundMuted }}>
          No verification evidence recorded. A completed turn is not verified task success.
        </Text>
      )}
      <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 16 }}>
        Attempts
      </Text>
      {run.managed?.attempts.map((attempt) => (
        <FactList
          key={attempt.attemptId}
          colors={colors}
          title={`Attempt ${attempt.number}`}
          facts={[
            ["Attempt ID", attempt.attemptId],
            ["Execution ID", attempt.executionId],
            ["Agent ID", attempt.agentId ?? "Not assigned"],
            ["Idempotency key", attempt.idempotencyKey],
            ["State", attempt.state],
            ["Error", attempt.error ?? "None"],
          ]}
        />
      ))}
      {!run.managed?.attempts.length ? (
        <Text style={{ color: colors.foregroundMuted }}>
          No managed attempt history available. Current attempt identity is shown above.
        </Text>
      ) : null}
      <Text style={{ color: colors.foregroundMuted }}>
        Only metadata is shown. Private execution artifacts, prompt content, environment values and raw output
        are not loaded here.
      </Text>
    </View>
  );
}

function FactList({ colors, title, facts }: { colors: Colors; title: string; facts: Fact[] }) {
  return (
    <View style={{ padding: 12, gap: 6, borderWidth: 1, borderColor: colors.border, borderRadius: 8 }}>
      <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 16 }}>
        {title}
      </Text>
      {facts.map(([label, value]) => (
        <Text key={label} selectable style={{ color: colors.foreground }}>
          <Text style={{ color: colors.foregroundMuted }}>{label}: </Text>
          {value}
        </Text>
      ))}
    </View>
  );
}
