import type { PluginHandlerContext } from "@getpaseo/plugin/server";

// Paseo builds a plugin without its dev dependencies, so the type comes from the SDK rather than
// @getpaseo/client.

export type PaseoApi = PluginHandlerContext["paseo"];
