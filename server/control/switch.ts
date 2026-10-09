import type { ControlSettings } from "../../shared/bot";
import type { ControlServer } from "./server";

interface SettingsSource {
  read(): Promise<{ status: "ready"; values: ControlSettings } | { status: "invalid" }>;
  subscribe(listener: () => void): () => void | Promise<void>;
}

/** Listens only while the setting is on; returns the cleanup. */
export function followControlSetting(
  settings: SettingsSource,
  control: Pick<ControlServer, "start" | "stop">,
) {
  const sync = () =>
    void settings
      .read()
      .then(async (state) => {
        if (state.status === "ready" && state.values.externalControl) await control.start();
        else await control.stop();
      })
      .catch((error: unknown) => console.error("paseo-bots: couldn't switch external control", error));
  sync();
  const unsubscribe = settings.subscribe(sync);
  return async () => {
    await unsubscribe();
    await control.stop();
  };
}
