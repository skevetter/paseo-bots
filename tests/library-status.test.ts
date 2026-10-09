import { describe, expect, it } from "vitest";
import { appsLoad, mcpServerNote, readOnlyToolsHint, withMember } from "../client/library/status";

describe("MCP server list note", () => {
  it("shows a running test over everything else", () => {
    expect(mcpServerNote({ enabled: false, checkError: "boom" }, true)).toEqual({
      text: "Testing...",
      tone: "busy",
    });
  });

  it("flags a failed check, whether or not the server is on", () => {
    const failed = { text: "Couldn't connect", tone: "danger" };
    expect(mcpServerNote({ enabled: true, checkError: "spawn ENOENT" }, false)).toEqual(failed);
    expect(mcpServerNote({ enabled: false, checkError: "spawn ENOENT" }, false)).toEqual(failed);
  });

  it("marks a healthy server only when it's off", () => {
    expect(mcpServerNote({ enabled: false, checkError: null }, false)).toEqual({ text: "Off" });
    expect(mcpServerNote({ enabled: true, checkError: null }, false)).toBeUndefined();
  });
});

describe("withMember", () => {
  it("adds and removes without touching the original", () => {
    const empty: ReadonlySet<string> = new Set();
    const one = withMember(empty, "a", true);
    expect([...one]).toEqual(["a"]);
    expect(empty.size).toBe(0);
    expect([...withMember(one, "a", false)]).toEqual([]);
  });

  it("returns the same set when nothing changes", () => {
    const one: ReadonlySet<string> = new Set(["a"]);
    expect(withMember(one, "a", true)).toBe(one);
    expect(withMember(one, "b", false)).toBe(one);
  });
});

describe("Composio apps load", () => {
  const idle = { isLoading: false, error: null };
  const loading = { isLoading: true, error: null };
  const configured = { ...idle, data: { configured: true } };
  const boom = new Error("boom");

  it("waits on the status before calling it not set up", () => {
    expect(appsLoad(loading, idle, idle)).toEqual({ kind: "loading" });
    expect(appsLoad({ ...idle, data: { configured: false } }, idle, idle)).toEqual({ kind: "not-set-up" });
  });

  it("reports a failed status check instead of offering setup", () => {
    expect(appsLoad({ isLoading: false, error: boom }, idle, idle)).toEqual({
      kind: "failed",
      label: "Couldn't check Composio",
      error: boom,
    });
  });

  it("waits on the accounts and the catalog", () => {
    expect(appsLoad(configured, loading, idle)).toEqual({ kind: "loading" });
    expect(appsLoad(configured, idle, loading)).toEqual({ kind: "loading" });
  });

  it("reports failed accounts before a failed catalog", () => {
    expect(
      appsLoad(configured, { isLoading: false, error: boom }, { isLoading: false, error: boom }),
    ).toEqual({
      kind: "failed",
      label: "Couldn't load your connected apps",
      error: boom,
    });
    expect(appsLoad(configured, idle, { isLoading: false, error: boom })).toMatchObject({
      kind: "failed",
      label: "Couldn't load the app catalog",
    });
    expect(appsLoad(configured, idle, idle)).toEqual({ kind: "ready" });
  });
});

describe("read-only tools hint", () => {
  it("counts once the tools load, and says so while they don't", () => {
    expect(readOnlyToolsHint({ isLoading: false, error: null, data: {} }, 3, 9)).toBe("3 of 9 tools");
    expect(readOnlyToolsHint({ isLoading: true, error: null }, 0, 0)).toBe("Loading tools...");
    expect(readOnlyToolsHint({ isLoading: false, error: new Error("x") }, 0, 0)).toBe(
      "Couldn't load the tools",
    );
  });
});
