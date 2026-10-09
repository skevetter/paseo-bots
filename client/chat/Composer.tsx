import type { PluginTheme } from "@getpaseo/plugin";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import type { ReactNode, RefObject } from "react";
import { type TextInput as NativeTextInput, Platform, Text, type TextStyle, View } from "react-native";
import type { ComposerAttachment } from "../../shared/attachments";
import { AttachmentPill, PendingAttachmentPill } from "../AttachmentPill";
import { homeIndicatorInset } from "../keyboard";
import { CONTENT_MAX_WIDTH, nativeTokens, placeholderColor } from "../native";
import { content, ui } from "../typography";
import type { PendingFile } from "./composer/attachments";
import { CommandMenu } from "./composer/CommandMenu";
import { type ChatComposerProps, type ComposerProps, useComposerController } from "./composer/controller";
import { composerDraftKey, contextUsage } from "./composer/logic";
import { PasteTextSheet } from "./composer/PasteTextSheet";
import { QueueList } from "./composer/QueueList";
import { ComposerToolbar, ContextMeterSlot, PrimaryButton } from "./composer/Toolbar";

type Colors = PluginTheme["colors"];

const web = Platform.OS === "web";
const RED_500 = "#ef4444";

/** One composer per chat, so each chat keeps its own draft, height and queue. */
export function Composer(props: ComposerProps) {
  const draftKey = composerDraftKey(props.host.key, props.bot.id, props.agentId);
  return <ChatComposer key={draftKey} draftKey={draftKey} {...props} />;
}

function composerPlaceholder(botName: string, agentId: string | null, compact: boolean): string {
  if (!agentId) return `Message ${botName}`;
  return compact ? "Message, /commands" : `Message ${botName}, or use /commands and /skills`;
}

function AttachmentTray({
  colors,
  attachments,
  pending,
  alwaysShowRemove,
  disabled,
  onRemove,
}: {
  colors: Colors;
  attachments: ComposerAttachment[];
  pending: PendingFile[];
  alwaysShowRemove: boolean;
  disabled: boolean;
  onRemove(id: string): void;
}) {
  if (attachments.length === 0 && pending.length === 0) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {attachments.map((attachment) => (
        <AttachmentPill
          key={attachment.id}
          colors={colors}
          attachment={attachment}
          alwaysShowRemove={alwaysShowRemove}
          disabled={disabled}
          onRemove={() => onRemove(attachment.id)}
        />
      ))}
      {pending.map((entry) => (
        <PendingAttachmentPill key={entry.id} colors={colors} name={entry.name} />
      ))}
    </View>
  );
}

interface ComposerTextInputProps {
  colors: Colors;
  inputRef: RefObject<NativeTextInput | null>;
  botName: string;
  placeholder: string;
  text: string;
  onChangeText(next: string): void;
  editable: boolean;
  onKeyPress(event: { nativeEvent: unknown; preventDefault?: () => void }): void;
  height: { style: TextStyle; scrollEnabled: boolean };
}

function ComposerTextInput({
  colors,
  inputRef,
  botName,
  placeholder,
  text,
  onChangeText,
  editable,
  onKeyPress,
  height,
}: ComposerTextInputProps) {
  const webInputStyle = web
    ? ({ lineHeight: content() * 1.4, outlineStyle: "none", outlineWidth: 0 } as object)
    : null;
  return (
    <TextInput
      ref={inputRef}
      accessibilityLabel={`Message ${botName}`}
      value={text}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={placeholderColor(colors)}
      multiline
      scrollEnabled={height.scrollEnabled}
      editable={editable}
      onKeyPress={onKeyPress}
      style={[
        {
          flexShrink: 1,
          width: "100%",
          color: colors.foreground,
          fontSize: content(),
          fontWeight: "normal",
          padding: 0,
          textAlignVertical: "top",
        },
        webInputStyle,
        height.style,
      ]}
    />
  );
}

function ComposerCard({
  colors,
  compact,
  children,
}: {
  colors: Colors;
  compact: boolean;
  children: ReactNode;
}) {
  return (
    <View
      style={{
        flexShrink: 1,
        gap: 12,
        backgroundColor: colors.surface1,
        borderWidth: 1,
        borderColor: nativeTokens(colors).borderAccent,
        borderRadius: 16,
        paddingVertical: compact ? 8 : 16,
        paddingHorizontal: compact ? 12 : 16,
      }}
    >
      {children}
    </View>
  );
}

function SendErrorText({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Text accessibilityRole="alert" style={{ color: RED_500, fontSize: ui(14) }}>
      {message}
    </Text>
  );
}

function ChatComposer(props: ChatComposerProps) {
  const { colors, bot, host, agentId, running, layout, keyboardOpen, agent } = props;
  const composer = useComposerController(props);
  const { draft, commands, sending, paste } = composer;
  const buttonIconSize = web ? 16 : 20;

  return (
    <View
      ref={composer.outerRef}
      collapsable={false}
      style={{
        width: "100%",
        minHeight: 75,
        alignItems: "center",
        paddingHorizontal: 16,
        paddingBottom: 16 + (keyboardOpen ? 0 : homeIndicatorInset()),
        flexShrink: 1,
      }}
    >
      <View style={{ width: "100%", maxWidth: CONTENT_MAX_WIDTH, gap: 12, flexShrink: 1 }}>
        <QueueList
          colors={colors}
          queue={composer.queue}
          onEdit={sending.editQueued}
          onSendNow={(item) => void sending.sendQueuedNow(item)}
        />
        <SendErrorText message={sending.sendError} />
        <View style={{ position: "relative", width: "100%", flexShrink: 1 }}>
          {commands.visible ? (
            <CommandMenu
              colors={colors}
              commands={commands.list}
              activeIndex={commands.activeIndex}
              loading={commands.loading}
              error={commands.error}
              onHover={commands.setActiveIndex}
              onSelect={commands.select}
            />
          ) : null}
          <ComposerCard colors={colors} compact={layout.compact}>
            <AttachmentTray
              colors={colors}
              attachments={draft.attachments}
              pending={composer.pending}
              alwaysShowRemove={!web || layout.compact}
              disabled={sending.processing}
              onRemove={(id) =>
                draft.updateAttachments((current) => current.filter((entry) => entry.id !== id))
              }
            />
            <ComposerTextInput
              colors={colors}
              inputRef={composer.input.inputRef}
              botName={bot.name}
              placeholder={composerPlaceholder(bot.name, agentId, layout.compact)}
              text={draft.text}
              onChangeText={draft.updateText}
              editable={!!host.api}
              onKeyPress={composer.onKeyPress}
              height={composer.input.inputHeight}
            />
            <ComposerToolbar
              colors={colors}
              attachRef={composer.attachRef}
              iconSize={buttonIconSize}
              attachDisabled={!host.api}
              onAttach={() => void composer.openAttachMenu()}
            >
              {agentId ? (
                <ContextMeterSlot
                  colors={colors}
                  usage={contextUsage(agent?.lastUsage)}
                  pending={agent?.status === "initializing" || running}
                  glyphSize={layout.compact ? 16 : buttonIconSize}
                />
              ) : null}
              <PrimaryButton
                colors={colors}
                primary={composer.primary}
                iconSize={buttonIconSize}
                sendLabel={composer.sendLabel}
                sendDisabled={composer.sendDisabled}
                loading={composer.loading}
                canInterrupt={composer.canInterrupt}
                stopping={composer.stopping}
                onSend={composer.onSend}
                onStop={composer.interrupt}
              />
            </ComposerToolbar>
          </ComposerCard>
        </View>
      </View>
      {paste.open ? <PasteTextSheet colors={colors} onClose={paste.close} onAttach={paste.attach} /> : null}
    </View>
  );
}
