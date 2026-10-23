import { useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";
import { errorText } from "../../native";
import type { PaseoAgent, PaseoApi } from "../../paseo";
import { type DeliveryTarget, deliverMessage } from "./delivery";
import type { ComposerDraftState, DraftMessage } from "./draftState";
import { queueMessage, requeueFront, setDraft, takeQueuedMessage } from "./drafts";
import { isDraftEmpty, type QueuedMessage, restoreFailedSend, shouldDrainQueue } from "./logic";
import { useMountedRef } from "./mounted";
import { type SubmittedMessage, submitDraft } from "./submission";

type Permission = PaseoAgent["pendingPermissions"][number];

const FAILED_TO_SEND = "Failed to send message";

type DrainState = "idle" | "sending" | "awaiting" | "paused";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : FAILED_TO_SEND;
}

interface QueueDrainOptions {
  draftKey: string;
  running: boolean;
  queue: QueuedMessage[];
  processing: boolean;
  agentId: string | null;
  api: PaseoApi | null;
  deliver(message: SubmittedMessage): Promise<void>;
  onError(message: string): void;
}

function useQueueDrain({
  draftKey,
  running,
  queue,
  processing,
  agentId,
  api,
  deliver,
  onError,
}: QueueDrainOptions) {
  const [drain, setDrain] = useState<DrainState>("idle");
  const mounted = useMountedRef();
  const draining = useRef(false);
  const latest = useRef({ deliver, onError });
  latest.current = { deliver, onError };

  useEffect(() => {
    if (running && (drain === "awaiting" || drain === "paused")) setDrain("idle");
  }, [running, drain]);
  useEffect(() => {
    if (drain !== "awaiting") return;
    const timer = setTimeout(() => setDrain((current) => (current === "awaiting" ? "idle" : current)), 4000);
    return () => clearTimeout(timer);
  }, [drain]);
  useEffect(() => {
    const inFlight = draining.current || drain !== "idle" || processing;
    const hasAgent = agentId !== null && !!api;
    const head = queue[0];
    if (!head || !shouldDrainQueue({ running, queued: queue.length, inFlight, hasAgent })) return;
    const next = takeQueuedMessage(draftKey, head.id);
    if (!next) return;
    draining.current = true;
    setDrain("sending");
    latest.current
      .deliver({ ...next, messageId: next.id })
      .then(() => mounted.current && setDrain("awaiting"))
      .catch((error: unknown) => {
        requeueFront(draftKey, next);
        if (!mounted.current) return;
        latest.current.onError(errorMessage(error));
        setDrain("paused");
      })
      .finally(() => {
        draining.current = false;
      });
  }, [running, queue, drain, processing, agentId, api, draftKey, mounted]);

  return { drain, setDrain };
}

interface SendingOptions {
  draftKey: string;
  draft: ComposerDraftState;
  target: DeliveryTarget;
  running: boolean;
  queue: QueuedMessage[];
  focusInput(): void;
}

export function useSending({ draftKey, draft, target, running, queue, focusInput }: SendingOptions) {
  const toast = useToast();
  const mounted = useMountedRef();
  const [processing, setProcessing] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const deliveryBlocked = processing || target.kind === "loading" || !target.host.api;
  const deliver = (message: SubmittedMessage) => deliverMessage(message, target);
  const { drain, setDrain } = useQueueDrain({
    draftKey,
    running,
    queue,
    processing,
    agentId: target.kind === "legacy" || target.kind === "remote" ? target.agentId : null,
    api: target.host.api,
    deliver,
    onError: setSendError,
  });

  const clearDraft = () => draft.replace({ text: "", attachments: [] });

  const restoreFailedMessage = (message: DraftMessage, error: unknown) => {
    const restored = restoreFailedSend(message, draft.latest.current);
    if (mounted.current) {
      draft.replace(restored);
      setSendError(errorMessage(error));
    } else {
      setDraft(draftKey, restored);
      toast.error(errorMessage(error));
    }
  };

  // Give the agent a moment to report the new turn before any queued message drains.
  const awaitNewTurn = () => {
    if ((target.kind === "legacy" || target.kind === "remote") && mounted.current)
      setDrain((current) => (current === "idle" ? "awaiting" : current));
  };

  // Clear at once so typing can continue; everything goes back on failure.
  const send = async () => {
    const current = draft.latest.current;
    if (isDraftEmpty({ text: current.text.trim(), attachments: current.attachments }) || deliveryBlocked)
      return;
    const message = submitDraft(current);
    clearDraft();
    setSendError(null);
    setProcessing(true);
    if (drain === "paused") setDrain("idle");
    try {
      await deliver(message);
      awaitNewTurn();
    } catch (error) {
      restoreFailedMessage(message, error);
    } finally {
      if (mounted.current) setProcessing(false);
    }
  };

  const enqueue = () => {
    const current = draft.latest.current;
    if (isDraftEmpty({ text: current.text.trim(), attachments: current.attachments }) || deliveryBlocked)
      return;
    const message = submitDraft(current);
    queueMessage(draftKey, { id: message.messageId, ...message });
    clearDraft();
  };

  const sendQueuedNow = async (item: QueuedMessage) => {
    if (deliveryBlocked || !takeQueuedMessage(draftKey, item.id)) return;
    setProcessing(true);
    setSendError(null);
    await deliver({ ...item, messageId: item.id })
      .catch((error: unknown) => {
        requeueFront(draftKey, item);
        if (mounted.current) setSendError(errorMessage(error));
      })
      .finally(() => {
        if (mounted.current) setProcessing(false);
      });
  };

  const editQueued = (item: QueuedMessage) => {
    if (!takeQueuedMessage(draftKey, item.id)) return;
    draft.replace({ text: item.text, attachments: item.attachments, messageId: item.id });
    focusInput();
  };

  return { processing, sendError, send, enqueue, sendQueuedNow, editQueued };
}

interface StopAgentOptions {
  permissions: Permission[];
  canInterrupt: boolean;
  agentId: string | null;
  api: PaseoApi | null;
  focusInput(): void;
}

// Plugins have no cancel API: denying a pending permission with `interrupt` is the one way to end a turn.
export function useStopAgent({ permissions, canInterrupt, agentId, api, focusInput }: StopAgentOptions) {
  const toast = useToast();
  const mounted = useMountedRef();
  const [stopping, setStopping] = useState(false);
  const stop = async () => {
    const permission = permissions[0];
    if (!canInterrupt || !permission || !agentId || !api || stopping) return;
    setStopping(true);
    try {
      await api.agents.ref(agentId).respondToPermission({
        requestId: permission.id,
        response: { behavior: "deny", interrupt: true, message: "Interrupted by the user." },
      });
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      if (mounted.current) setStopping(false);
    }
    focusInput();
  };
  return { stopping, stop };
}
