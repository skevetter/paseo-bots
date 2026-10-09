import type { ControlTool } from "../tool";
import { APP_TOOLS } from "./apps";
import { CHAT_TOOLS } from "./chats";
import { MEMORY_TOOLS } from "./memory";
import { ROUTINE_TOOLS } from "./routines";

/** In the order clients see them. */
export const CONTROL_TOOLS: readonly ControlTool[] = [
  ...CHAT_TOOLS,
  ...ROUTINE_TOOLS,
  ...MEMORY_TOOLS,
  ...APP_TOOLS,
];
