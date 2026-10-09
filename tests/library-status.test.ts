import { describe, expect, it } from "vitest";
import { mcpServerNote, withMember } from "../client/library/status";

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
