import type { PluginTheme } from "@getpaseo/plugin";
import { Modal } from "@getpaseo/plugin/client/react-native";
import { memo, type ReactNode, useCallback, useEffect, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import type { ComposerAttachment } from "../../../shared/attachments";
import { formatMessageTimestamp } from "../../../shared/markdown/timestamps";
import { AttachmentPill } from "../../AttachmentPill";
import { nativeTokens } from "../../native";
import { content, contentLine } from "../../typography";
import { CopyButton, isWeb, METADATA_SIZE } from "./ui";

type Colors = PluginTheme["colors"];
type ImageAttachment = Extract<ComposerAttachment, { kind: "image" }>;

function UserAttachments({
  colors,
  attachments,
  hasText,
  onOpenImage,
}: {
  colors: Colors;
  attachments: ComposerAttachment[];
  hasText: boolean;
  onOpenImage(image: ImageAttachment): void;
}) {
  const images = attachments.filter(
    (attachment): attachment is ImageAttachment => attachment.kind === "image",
  );
  const files = attachments.filter((attachment) => attachment.kind !== "image");
  return (
    <>
      {images.length > 0 ? (
        <View
          style={{
            flexDirection: "row",
            gap: 8,
            flexWrap: "wrap",
            marginBottom: hasText || files.length > 0 ? 8 : 0,
          }}
        >
          {images.map((image) => (
            <Pressable
              key={image.id}
              accessibilityRole="button"
              accessibilityLabel="Open image"
              onPress={() => onOpenImage(image)}
            >
              <AttachmentPill colors={colors} attachment={image} />
            </Pressable>
          ))}
        </View>
      ) : null}
      {files.length > 0 ? (
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", marginBottom: hasText ? 8 : 0 }}>
          {files.map((file) => (
            <AttachmentPill key={file.id} colors={colors} attachment={file} />
          ))}
        </View>
      ) : null}
    </>
  );
}

function UserMessageTrailing({
  colors,
  text,
  timestamp,
  visible,
}: {
  colors: Colors;
  text: string;
  timestamp: number;
  visible: boolean;
}) {
  const getText = useCallback(() => text, [text]);
  return (
    <View
      pointerEvents={visible ? "auto" : "none"}
      style={{
        alignSelf: "flex-end",
        flexDirection: "row",
        alignItems: "center",
        height: 24,
        gap: 8,
        marginTop: 8,
        opacity: visible ? 1 : 0,
      }}
    >
      <Text style={{ color: colors.foregroundMuted, fontSize: METADATA_SIZE }}>
        {formatMessageTimestamp(new Date(timestamp))}
      </Text>
      <CopyButton
        colors={colors}
        getContent={getText}
        label="Copy message"
        style={{ alignSelf: "center", marginRight: -4 }}
      />
    </View>
  );
}

export const UserMessage = memo(function UserMessage({
  colors,
  compact,
  text,
  timestamp,
  attachments,
}: {
  colors: Colors;
  compact: boolean;
  text: string;
  timestamp: number;
  attachments: ComposerAttachment[];
}) {
  const [hovered, setHovered] = useState(false);
  const [lightbox, setLightbox] = useState<ImageAttachment | null>(null);
  const hasText = text.trim().length > 0;
  const showTrailing = hasText && (compact || !isWeb || hovered);
  return (
    <View
      style={{
        flexDirection: "row",
        justifyContent: "flex-end",
        ...(isWeb ? ({ userSelect: "text" } as object) : {}),
      }}
    >
      {/* On web a Pressable tracks hover for the timestamp row; phones always show it. */}
      <HoverArea onHover={setHovered} style={{ alignItems: "flex-end", maxWidth: "100%", cursor: "auto" }}>
        <View
          style={{
            backgroundColor: nativeTokens(colors).surface3,
            borderRadius: 16,
            borderTopRightRadius: 2,
            paddingHorizontal: 16,
            paddingVertical: 16,
            minWidth: 0,
            flexShrink: 1,
          }}
        >
          <UserAttachments
            colors={colors}
            attachments={attachments}
            hasText={hasText}
            onOpenImage={setLightbox}
          />
          {hasText ? (
            <Text
              selectable
              style={{
                color: colors.foreground,
                fontSize: content(),
                lineHeight: contentLine(),
                ...(isWeb ? ({ overflowWrap: "anywhere" } as object) : {}),
              }}
            >
              {text}
            </Text>
          ) : null}
        </View>
        {hasText ? (
          <UserMessageTrailing colors={colors} text={text} timestamp={timestamp} visible={showTrailing} />
        ) : null}
      </HoverArea>
      {lightbox ? <Lightbox colors={colors} image={lightbox} onClose={() => setLightbox(null)} /> : null}
    </View>
  );
});

function HoverArea({
  onHover,
  style,
  children,
}: {
  onHover(hovered: boolean): void;
  style: object;
  children: ReactNode;
}) {
  if (!isWeb) return <View style={style}>{children}</View>;
  return (
    <Pressable onHoverIn={() => onHover(true)} onHoverOut={() => onHover(false)} style={style}>
      {children}
    </Pressable>
  );
}

function Lightbox({ colors, image, onClose }: { colors: Colors; image: ImageAttachment; onClose(): void }) {
  const uri = `data:${image.mimeType};base64,${image.data}`;
  const [ratio, setRatio] = useState<number | null>(null);
  useEffect(() => {
    Image.getSize(
      uri,
      (width, height) => height > 0 && setRatio(width / height),
      () => setRatio(null),
    );
  }, [uri]);
  return (
    <Modal title={image.name} open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content contentContainerStyle={{ padding: 0, gap: 0 }}>
        <View style={{ backgroundColor: colors.surface0, alignItems: "center", justifyContent: "center" }}>
          <Image
            accessibilityLabel={image.name}
            source={{ uri }}
            resizeMode="contain"
            style={
              ratio ? { width: "100%", aspectRatio: ratio, maxHeight: 720 } : { width: "100%", height: 360 }
            }
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}
