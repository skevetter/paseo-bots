import type { Selection, StartRequest } from "./sidebar/types";

interface AutoStartOptions {
  start(request: StartRequest): Promise<void>;
  /** Takes a handled request off the selection so it isn't sent again. */
  clear(id: string): void;
  onError(error: unknown): void;
}

/**
 * Starts a new chat for each start request on the selection once its host is reachable. A request that
 * comes in while another is still starting is dropped, so pressing Start twice opens one chat.
 */
export function autoStarter({ start, clear, onError }: AutoStartOptions) {
  const handled = new Set<string>();
  let running = false;
  return (selection: Selection, ready: boolean): void => {
    const request = selection.chatId === null ? selection.start : undefined;
    if (!request || !ready || handled.has(request.id)) return;
    handled.add(request.id);
    clear(request.id);
    if (running) return;
    running = true;
    start(request).then(
      () => {
        running = false;
      },
      (error: unknown) => {
        running = false;
        onError(error);
      },
    );
  };
}

export function withoutStart(selection: Selection | null, id: string): Selection | null {
  if (selection?.start?.id !== id) return selection;
  const { start: _start, ...rest } = selection;
  return rest;
}
