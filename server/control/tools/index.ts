import type { ControlTool } from "../tool";
import { MEMORY_TOOLS } from "./memory";

/** In the order clients see them. */
export const CONTROL_TOOLS: readonly ControlTool[] = [...MEMORY_TOOLS];
