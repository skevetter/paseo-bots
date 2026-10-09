import type { ControlTool } from "../tool";
import { APP_TOOLS } from "./apps";
import { BOTS_TOOLS } from "./bots";
import { CHAT_TOOLS } from "./chats";
import { LIBRARY_TOOLS } from "./library";
import { MEMORY_TOOLS } from "./memory";
import { ROUTINE_TOOLS } from "./routines";

/** In the order clients see them. */
export const CONTROL_TOOLS: readonly ControlTool[] = [
  ...BOTS_TOOLS,
  ...LIBRARY_TOOLS,
  ...CHAT_TOOLS,
  ...ROUTINE_TOOLS,
  ...MEMORY_TOOLS,
  ...APP_TOOLS,
];
