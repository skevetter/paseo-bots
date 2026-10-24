export interface LocalStartSettings {
  flush(): Promise<boolean>;
  hasDraft(botId: string): boolean;
}

export async function flushLocalStartSettings(
  settings: LocalStartSettings,
  botId: string,
  isCurrent: () => boolean,
): Promise<void> {
  const saved = await settings.flush();
  if (!isCurrent()) throw new Error("The bot host changed while saving. Review settings and retry.");
  if (!saved || settings.hasDraft(botId))
    throw new Error("Save pending bot settings before starting this task, then retry the restored draft.");
}
