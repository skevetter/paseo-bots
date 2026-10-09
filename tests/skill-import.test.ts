import { afterEach, describe, expect, it, vi } from "vitest";
import { importSkills, readSkill } from "../server/library";
import { useTempPaseoHome } from "./helpers";

type Branches = Record<string, Record<string, string>>;

function treeOf(files: Record<string, string>) {
  const dirs = new Set(
    Object.keys(files).flatMap((path) =>
      path
        .split("/")
        .slice(0, -1)
        .map((_, depth, parts) => parts.slice(0, depth + 1).join("/")),
    ),
  );
  return {
    truncated: false,
    tree: [
      ...[...dirs].map((path) => ({ path, type: "tree" })),
      ...Object.entries(files).map(([path, text]) => ({ path, type: "blob", size: text.length })),
    ].sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
}

const missing = () => new Response("Not Found", { status: 404 });

/** Answers like GitHub's API and raw host for one repository; anything else is a 404. */
function serveRepo(name: string, branches: Branches, defaultBranch = "main") {
  const api = `https://api.github.com/repos/${name}`;
  const raw = `https://raw.githubusercontent.com/${name}/`;
  const tree = (ref: string) => {
    const files = branches[decodeURIComponent(ref)];
    return files ? Response.json(treeOf(files)) : missing();
  };
  const file = (ref: string, path: string[]) => {
    const text = branches[ref]?.[path.join("/")];
    return text === undefined ? missing() : new Response(text);
  };
  const answer = (url: string): Response => {
    if (url === api) return Response.json({ default_branch: defaultBranch });
    const ref = new RegExp(`^${api}/git/trees/([^?]+)\\?recursive=1$`).exec(url)?.[1];
    if (ref) return tree(ref);
    const [head = "", ...path] = url.startsWith(raw) ? url.slice(raw.length).split("/") : [];
    return file(head, path);
  };
  vi.stubGlobal("fetch", async (input: string | URL) => answer(String(input)));
}

const skillMd = (name: string, description = "d") => `---\nname: ${name}\ndescription: ${description}\n---\n`;

describe("importSkills", () => {
  useTempPaseoHome("paseo-bots-skill-import-");
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps SKILL.md when a skill has more files than are imported", async () => {
    const references = Object.fromEntries(
      Array.from({ length: 45 }, (_, n) => [`big/${String(n).padStart(2, "0")}-step.md`, `step ${n}`]),
    );
    serveRepo("acme/kit", { main: { ...references, "big/SKILL.md": skillMd("big", "Many steps") } });

    const { skills } = await importSkills({ source: "acme/kit/big" });

    expect(skills).toEqual([{ id: "big", description: "Many steps", source: "github.com/acme/kit/big" }]);
    const saved = await readSkill({ id: "big" });
    expect(saved.missing).toBe(false);
    expect(saved.files).toHaveLength(40);
  });
});
