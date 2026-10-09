import type { SlashCommandsState } from "./commands";
import { type ComposerKeyEvent, isImeComposing, resolveEnterKey } from "./logic";

type KeyEffect = (() => void) | null;

interface KeyHandlerOptions {
  enabled: boolean;
  commands: SlashCommandsState;
  canInterrupt: boolean;
  stop(): void;
  enter: { submitOnEnter: boolean; running: boolean; canQueue: boolean };
  blocked: boolean;
  defaultAction(): void;
  alternateAction(): void;
}

function commandMenuKeyEffect(key: ComposerKeyEvent, { commands }: KeyHandlerOptions): KeyEffect {
  if (!commands.visible) return null;
  if (key.key === "Escape") return commands.dismiss;
  const count = commands.list.length;
  if (count === 0) return null;
  if (key.key === "ArrowDown") return () => commands.setActiveIndex((index) => (index + 1) % count);
  if (key.key === "ArrowUp") return () => commands.setActiveIndex((index) => (index - 1 + count) % count);
  if ((key.key !== "Enter" || key.shiftKey) && key.key !== "Tab") return null;
  const command = commands.list[Math.min(commands.activeIndex, count - 1)];
  return command ? () => commands.select(command) : null;
}

function composerKeyEffect(key: ComposerKeyEvent, options: KeyHandlerOptions): KeyEffect {
  if (key.key === "Escape" && options.canInterrupt) return options.stop;
  const action = resolveEnterKey(key, options.enter);
  // While a send or upload is in flight Enter falls through to a newline.
  if (!action || options.blocked) return null;
  return action === "alternate" ? options.alternateAction : options.defaultAction;
}

export function createKeyHandler(options: KeyHandlerOptions) {
  return (event: { nativeEvent: unknown; preventDefault?: () => void }) => {
    if (!options.enabled) return;
    const key = event.nativeEvent as ComposerKeyEvent;
    if (isImeComposing(key)) return;
    const effect = commandMenuKeyEffect(key, options) ?? composerKeyEffect(key, options);
    if (!effect) return;
    event.preventDefault?.();
    effect();
  };
}
