import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { type RefObject, useEffect, useRef, useState } from "react";
import { type TextInput as NativeTextInput, Platform, type View } from "react-native";
import {
  type ComposerAttachment,
  newAttachmentId,
  normalizeMimeType,
  preflightFile,
} from "../../../shared/attachments";
import { uploadRpc } from "../../../shared/rpc";
import type { BotHost } from "../../data";
import { type MenuEntry, measureAnchor, useMenu } from "../../ui/Menu";
import {
  decodeUtf8,
  domNode,
  type FileHandle,
  listenForFileDrop,
  listenForImagePaste,
  pickFileHandles,
} from "../../web";
import type { ComposerDraftState } from "./draftState";
import { setDraft } from "./drafts";
import { useMountedRef } from "./mounted";

type Colors = PluginTheme["colors"];

const web = Platform.OS === "web";

interface AcceptedFile {
  file: FileHandle;
  kind: ComposerAttachment["kind"];
  mimeType: string;
  pendingId: string;
}

export interface PendingFile {
  id: string;
  name: string;
}

type StoreFile = (fileName: string, dataBase64: string) => Promise<{ size: number; path: string }>;

function acceptFiles(
  files: FileHandle[],
  isLocal: boolean,
  reject: (message: string) => void,
): AcceptedFile[] {
  const accepted: AcceptedFile[] = [];
  for (const file of files) {
    const mimeType = normalizeMimeType(file.mimeType) || "application/octet-stream";
    // Size limits are checked before any bytes are read.
    const { kind, reason } = preflightFile(file.name, mimeType, file.size, isLocal);
    if (reason) {
      reject(`${file.name}: ${reason}`);
      continue;
    }
    accepted.push({ file, kind, mimeType, pendingId: newAttachmentId() });
  }
  return accepted;
}

async function readAttachment(
  { file, kind, mimeType }: AcceptedFile,
  storeFile: StoreFile,
): Promise<ComposerAttachment> {
  const base64 = await file.readBase64();
  if (kind === "image")
    return { kind, id: newAttachmentId(), name: file.name, mimeType, size: file.size, data: base64 };
  if (kind === "text")
    return { kind, id: newAttachmentId(), name: file.name, size: file.size, text: decodeUtf8(base64) };
  const stored = await storeFile(file.name, base64);
  return { kind, id: newAttachmentId(), name: file.name, mimeType, size: stored.size, path: stored.path };
}

interface FileAttachmentOptions {
  draftKey: string;
  draft: ComposerDraftState;
  botId: string;
  isLocal: boolean;
}

export function useFileAttachments({ draftKey, draft, botId, isLocal }: FileAttachmentOptions) {
  const toast = useToast();
  const upload = useRpc(uploadRpc);
  const mounted = useMountedRef();
  const [pending, setPending] = useState<PendingFile[]>([]);

  const attach = (attachment: ComposerAttachment) => {
    if (mounted.current) draft.updateAttachments((current) => [...current, attachment]);
    else
      setDraft(draftKey, {
        text: draft.latest.current.text,
        attachments: [...draft.latest.current.attachments, attachment],
      });
  };

  const addAccepted = async (entry: AcceptedFile, storeFile: StoreFile) => {
    try {
      attach(await readAttachment(entry, storeFile));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to upload file");
    } finally {
      if (mounted.current) setPending((current) => current.filter((item) => item.id !== entry.pendingId));
    }
  };

  const addFiles = async (files: FileHandle[]) => {
    const accepted = acceptFiles(files, isLocal, (message) => toast.error(message));
    if (accepted.length === 0) return;
    setPending((current) => [
      ...current,
      ...accepted.map((entry) => ({ id: entry.pendingId, name: entry.file.name })),
    ]);
    const storeFile: StoreFile = (fileName, dataBase64) => upload({ botId, fileName, dataBase64 });
    for (const entry of accepted) await addAccepted(entry, storeFile);
  };

  return { pending, addFiles };
}

interface AttachmentSourcesOptions {
  colors: Colors;
  host: BotHost;
  inputRef: RefObject<NativeTextInput | null>;
  outerRef: RefObject<View | null>;
  attachRef: RefObject<View | null>;
  loading: boolean;
  addFiles(files: FileHandle[]): Promise<void>;
  onPasteText(): void;
}

export function useAttachmentSources({
  colors,
  host,
  inputRef,
  outerRef,
  attachRef,
  loading,
  addFiles,
  onPasteText,
}: AttachmentSourcesOptions) {
  const toast = useToast();
  const menu = useMenu();
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;
  const loadingRef = useRef(loading);
  loadingRef.current = loading;

  const pick = async (accept?: string) => {
    try {
      await addFiles(await pickFileHandles({ accept }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to upload file");
    }
  };

  const openAttachMenu = async () => {
    const anchor = await measureAnchor(attachRef);
    if (!anchor) return;
    // Plugins can't read the clipboard or open pickers on phones, so pasting text stands in there.
    const entries: MenuEntry[] = web
      ? [
          { label: "Add image", icon: "Image", onSelect: () => void pick("image/*") },
          { label: "Upload file", icon: "Paperclip", onSelect: () => void pick() },
        ]
      : [{ label: "Paste text", icon: "ClipboardPaste", onSelect: onPasteText }];
    menu.open({ anchor, align: "start", width: 220, title: "Add attachment", entries });
  };

  useEffect(
    () => listenForImagePaste(domNode(inputRef.current), (files) => void addFilesRef.current(files)),
    [inputRef],
  );

  // Dropping files anywhere on the chat pane attaches them.
  useEffect(() => {
    const own = domNode(outerRef.current);
    return listenForFileDrop(own?.parentElement ?? own, {
      label: "Drop files here",
      background: colors.surface0,
      foreground: colors.foreground,
      isEnabled: () => !loadingRef.current && !!host.api,
      onFiles: (files) => void addFilesRef.current(files),
    });
  }, [colors.surface0, colors.foreground, host.api, outerRef]);

  return openAttachMenu;
}

export function usePasteSheet(draft: ComposerDraftState) {
  const [open, setOpen] = useState(false);
  const attach = (pasted: string, title: string) => {
    draft.updateAttachments((current) => [
      ...current,
      { kind: "text", id: newAttachmentId(), name: title, size: pasted.length, text: pasted },
    ]);
    setOpen(false);
  };
  return { open, show: () => setOpen(true), close: () => setOpen(false), attach };
}
