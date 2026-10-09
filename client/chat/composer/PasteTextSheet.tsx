import type { PluginTheme } from "@getpaseo/plugin";
import { Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsRow } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { nativeTokens, placeholderColor } from "../../native";
import { ui } from "../../typography";

type Colors = PluginTheme["colors"];

/** Phones have no file picker or clipboard access for plugins, so "Paste text" attaches pasted text there. */
export function PasteTextSheet({
  colors,
  onClose,
  onAttach,
}: {
  colors: Colors;
  onClose(): void;
  onAttach(text: string, title: string): void;
}) {
  const [text, setText] = useState("");
  const tokens = nativeTokens(colors);
  return (
    <Modal title="Paste text" open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        <SettingsCard>
          <SettingsRow
            label="Text"
            hint="Pasted notes, an email, a log… sent alongside your message. Images and files can be attached from Paseo on desktop or the web."
          >
            <TextInput
              accessibilityLabel="Text to attach"
              value={text}
              onChangeText={setText}
              multiline
              placeholder="Paste here"
              placeholderTextColor={placeholderColor(colors)}
              style={{
                width: "100%",
                minHeight: 140,
                color: colors.foreground,
                backgroundColor: colors.surface1,
                borderColor: tokens.borderAccent,
                borderWidth: 1,
                borderRadius: 8,
                padding: 10,
                fontSize: ui(14),
                textAlignVertical: "top",
              }}
            />
          </SettingsRow>
          <SettingsAction
            label="Attach it to the message"
            actionLabel="Attach"
            disabled={!text.trim()}
            onPress={() => onAttach(text, `Pasted text (${text.trim().split(/\s+/).length} words)`)}
          />
        </SettingsCard>
      </Modal.Content>
    </Modal>
  );
}
