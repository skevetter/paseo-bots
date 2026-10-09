import type { ControlTool } from "../tool";
import { MEMORY_TOOLS } from "./memory";
import { ROUTINE_TOOLS } from "./routines";

/** In the order clients see them. */
export const CONTROL_TOOLS: readonly ControlTool[] = [...ROUTINE_TOOLS, ...MEMORY_TOOLS];
