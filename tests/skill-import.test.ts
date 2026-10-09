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

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Answers like GitHub's API and raw host for one repository, seeing only the path; anything else is a 404. */
function serveRepo(name: string, branches: Branches, defaultBranch = "main") {
  const api = `https://api.github.com/repos/${name}`;
  const raw = `https://raw.githubusercontent.com/${name}/`;
  const tree = (ref: string) => {
    const files = branches[decode(ref) ?? ""];
    return files ? Response.json(treeOf(files)) : missing();
  };
  const file = (ref: string, path: string[]) => {
    const text = branches[decode(ref) ?? ""]?.[path.map(decode).join("/")];
    return text === undefined ? missing() : new Response(text);
  };
  const answer = (url: URL): Response => {
    const at = `${url.origin}${url.pathname}`;
    if (at === api) return Response.json({ default_branch: defaultBranch });
    const ref = at.startsWith(`${api}/git/trees/`) && url.search === "?recursive=1" && at.split("/").pop();
    if (ref) return tree(ref);
    const [head = "", ...path] = at.startsWith(raw) ? at.slice(raw.length).split("/") : [];
    return file(head, path);
  };
  vi.stubGlobal("fetch", async (input: string | URL) => answer(new URL(input)));
}

/** A repository too big for GitHub's recursive listing of its root; folder SHAs are their paths. */
function serveLargeRepo(name: string, files: Record<string, string>) {
  const api = `https://api.github.com/repos/${name}`;
  const raw = `https://raw.githubusercontent.com/${name}/main/`;
  const under = (dir: string) =>
    Object.fromEntries(
      Object.entries(files)
        .filter(([path]) => path.startsWith(`${dir}/`))
        .map(([path, text]) => [path.slice(dir.length + 1), text]),
    );
  const listing = (dir: string, recursive: boolean) => {
    if (recursive) return dir ? treeOf(under(dir)) : { truncated: true, tree: [] };
    const tree = treeOf(dir ? under(dir) : files).tree.filter((entry) => !entry.path.includes("/"));
    return {
      truncated: false,
      tree: tree.map((entry) => ({ ...entry, sha: dir ? `${dir}/${entry.path}` : entry.path })),
    };
  };
  const file = (path: string) => {
    const text = files[decodeURIComponent(path)];
    return text === undefined ? missing() : new Response(text);
  };
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(input);
    const at = `${url.origin}${url.pathname}`;
    if (at === api) return Response.json({ default_branch: "main" });
    if (at.startsWith(raw)) return file(at.slice(raw.length));
    if (!at.startsWith(`${api}/git/trees/`)) return missing();
    const sha = decodeURIComponent(at.slice(`${api}/git/trees/`.length));
    return Response.json(listing(sha === "main" ? "" : sha, url.search === "?recursive=1"));
  });
}

const skillMd = (name: string, description = "d") => `---\nname: ${name}\ndescription: ${description}\n---\n`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("importSkills from GitHub", () => {
  useTempPaseoHome("paseo-bots-skill-import-");

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

  it("fetches files whose names have URL characters in them", async () => {
    serveRepo("acme/kit", {
      main: {
        "notes/SKILL.md": skillMd("notes"),
        "notes/issue #12?.md": "fixed",
        "notes/50% off.md": "sale",
      },
    });

    await importSkills({ source: "acme/kit/notes" });

    expect((await readSkill({ id: "notes" })).files).toEqual(["SKILL.md", "50% off.md", "issue #12?.md"]);
  });

  it("imports a whole repository on its default branch, nested skills on their own", async () => {
    serveRepo(
      "acme/toolbox",
      {
        trunk: {
          "SKILL.md": "---\ndescription: The kit\n---\nUse it.",
          "README.md": "readme",
          "extras/SKILL.md": skillMd("toolbox-extras", "More"),
          "extras/tips.md": "tips",
        },
      },
      "trunk",
    );

    const { skills } = await importSkills({ source: "acme/toolbox" });

    expect(skills).toEqual([
      { id: "toolbox", description: "The kit", source: "github.com/acme/toolbox" },
      { id: "toolbox-extras", description: "More", source: "github.com/acme/toolbox/extras" },
    ]);
    expect((await readSkill({ id: "toolbox" })).files).toEqual(["SKILL.md", "README.md"]);
    expect((await readSkill({ id: "toolbox-extras" })).files).toEqual(["SKILL.md", "tips.md"]);
  });

  it("imports only the skills under a repository path", async () => {
    serveRepo("acme/kit", {
      main: {
        "skills/scope/SKILL.md": skillMd("scope"),
        "skills/scope/deep/SKILL.md": skillMd("scope-deep"),
        "skills/scopefar/SKILL.md": skillMd("scopefar"),
        "skills/other/SKILL.md": skillMd("other"),
      },
    });

    const { skills } = await importSkills({ source: "acme/kit/skills/scope/" });

    expect(skills.map((skill) => [skill.id, skill.source])).toEqual([
      ["scope", "github.com/acme/kit/skills/scope"],
      ["scope-deep", "github.com/acme/kit/skills/scope/deep"],
    ]);
    expect((await readSkill({ id: "scope" })).files).toEqual(["SKILL.md"]);
  });

  it("reads the branch and folder from GitHub folder and file links", async () => {
    serveRepo("acme/kit", {
      main: { "skills/branchy/SKILL.md": skillMd("branchy", "On main") },
      dev: { "skills/branchy/SKILL.md": skillMd("branchy", "On dev") },
    });

    const fromFolder = await importSkills({ source: "https://github.com/acme/kit/tree/dev/skills/branchy" });
    const fromFile = await importSkills({
      source: "https://github.com/acme/kit/blob/dev/skills/branchy/SKILL.md",
    });
    const fromRepo = await importSkills({ source: "https://github.com/acme/kit.git" });

    expect(fromFolder.skills).toEqual([
      { id: "branchy", description: "On dev", source: "github.com/acme/kit/skills/branchy" },
    ]);
    expect(fromFile.skills).toEqual(fromFolder.skills);
    expect(fromRepo.skills.map((skill) => skill.description)).toEqual(["On main"]);
  });

  it("lists just the folder asked for when GitHub cuts the repository's listing short", async () => {
    serveLargeRepo("acme/huge", {
      "skills/pick/SKILL.md": skillMd("pick", "Picked"),
      "skills/pick/notes.md": "notes",
      "skills/other/SKILL.md": skillMd("other"),
      "src/main.ts": "code",
    });

    const { skills } = await importSkills({ source: "acme/huge/skills/pick" });

    expect(skills).toEqual([
      { id: "pick", description: "Picked", source: "github.com/acme/huge/skills/pick" },
    ]);
    expect((await readSkill({ id: "pick" })).files).toEqual(["SKILL.md", "notes.md"]);
    await expect(importSkills({ source: "acme/huge/skills/gone" })).rejects.toThrow(
      "No SKILL.md found in acme/huge/skills/gone.",
    );
    await expect(importSkills({ source: "acme/huge" })).rejects.toThrow(
      "acme/huge is too big for GitHub to list at once.",
    );
  });
});

describe("importSkills replacing and refusing", () => {
  useTempPaseoHome("paseo-bots-skill-redo-");

  it("replaces an earlier copy of the same skill, dropping files that are gone", async () => {
    serveRepo("acme/kit", { main: { "redo/SKILL.md": skillMd("redo", "First"), "redo/old.md": "old" } });
    await importSkills({ source: "acme/kit/redo" });
    serveRepo("acme/kit", { main: { "redo/SKILL.md": skillMd("redo", "Second") } });

    await importSkills({ source: "acme/kit/redo" });

    const saved = await readSkill({ id: "redo" });
    expect(saved.files).toEqual(["SKILL.md"]);
    expect(saved.text).toContain("Second");
  });

  it("skips files too large to import and keeps a skill's name inside the library", async () => {
    serveRepo("acme/kit", {
      main: {
        "huge/SKILL.md": skillMd("../../huge"),
        "huge/data.bin": "x".repeat(512 * 1024 + 1),
        "huge/small.md": "small",
      },
    });

    const { skills } = await importSkills({ source: "acme/kit/huge" });

    expect(skills.map((skill) => skill.id)).toEqual(["huge"]);
    expect((await readSkill({ id: "huge" })).files).toEqual(["SKILL.md", "small.md"]);
  });

  it("leaves out links, Windows-style paths and dot folders a repository lists", async () => {
    serveRepo("acme/kit", {
      main: {
        "links/SKILL.md": skillMd("links"),
        "links/ok.md": "kept",
        "links/shortcut.md": "../../../.ssh/id_rsa",
        "links/nested/SKILL.md": "../SKILL.md",
        "links/win\\dows.md": "split on Windows",
        "links/../outside.md": "out",
      },
    });
    const served = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const answer = await served(input);
      if (!String(input).includes("/git/trees/")) return answer;
      const listing = (await answer.json()) as { tree: { path: string; mode?: string }[] };
      for (const entry of listing.tree) if (/shortcut|nested\/SKILL/.test(entry.path)) entry.mode = "120000";
      return Response.json(listing);
    });

    const { skills } = await importSkills({ source: "acme/kit/links" });

    expect(skills.map((skill) => skill.id)).toEqual(["links"]);
    expect((await readSkill({ id: "links" })).files).toEqual(["SKILL.md", "ok.md"]);
  });

  it("keeps a skill to 4 MB and refuses a file that turns out larger than its listing says", async () => {
    const chunks = Object.fromEntries(
      Array.from({ length: 10 }, (_, n) => [`bulk/part-${n}.md`, String(n).repeat(500 * 1024)]),
    );
    serveRepo("acme/kit", {
      main: {
        ...chunks,
        "bulk/SKILL.md": skillMd("bulk"),
        "lying/SKILL.md": skillMd("lying"),
        "lying/note.md": "tiny",
      },
    });

    await importSkills({ source: "acme/kit/bulk" });
    expect((await readSkill({ id: "bulk" })).files).toHaveLength(9);

    const served = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL) =>
      String(input).endsWith("/note.md") ? new Response("x".repeat(1024 * 1024)) : served(input),
    );
    await expect(importSkills({ source: "acme/kit/lying" })).rejects.toThrow("note.md is over 512 KB.");
  });

  it("reports a repository with no skills, a missing repository and a source it can't read", async () => {
    serveRepo("acme/kit", { main: { "docs/README.md": "no skills" } });

    await expect(importSkills({ source: "acme/kit/docs" })).rejects.toThrow(
      "No SKILL.md found in acme/kit/docs.",
    );
    await expect(importSkills({ source: "acme/kit" })).rejects.toThrow("No SKILL.md found in acme/kit.");
    await expect(importSkills({ source: "acme/gone" })).rejects.toThrow(
      "https://api.github.com/repos/acme/gone answered 404.",
    );
    await expect(importSkills({ source: "not a repo" })).rejects.toThrow('Use "owner/repo"');
    await expect(importSkills({ source: "https://example.com/notes.md" })).rejects.toThrow(
      "a link to a SKILL.md file",
    );
  });
});

describe("importSkills from a SKILL.md link", () => {
  useTempPaseoHome("paseo-bots-skill-link-");
  const serveLinks = (links: Record<string, string>) =>
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const text = links[String(input)];
      return text === undefined ? missing() : new Response(text);
    });

  it("names the skill from its frontmatter, else its folder, else plainly", async () => {
    const named = "https://example.com/kits/folder-name/SKILL.md";
    const unnamed = "https://example.com/kits/linked-skill/SKILL.md";
    const bare = "https://example.com/SKILL.md";
    serveLinks({ [named]: skillMd("Front Name", "Named"), [unnamed]: "Just steps.", [bare]: "Steps." });

    expect((await importSkills({ source: named })).skills).toEqual([
      { id: "front-name", description: "Named", source: named },
    ]);
    expect((await importSkills({ source: unnamed })).skills).toEqual([
      { id: "linked-skill", description: "", source: unnamed },
    ]);
    expect((await importSkills({ source: bare })).skills.map((skill) => skill.id)).toEqual(["skill"]);
    expect((await readSkill({ id: "linked-skill" })).text).toBe("Just steps.");
  });

  it("reports a link that doesn't answer", async () => {
    serveLinks({});
    await expect(importSkills({ source: "https://example.com/x/SKILL.md" })).rejects.toThrow(
      "https://example.com/x/SKILL.md answered 404.",
    );
  });

  it("refuses a linked SKILL.md over 512 KB, and stops reading one that never ends", async () => {
    serveLinks({ "https://example.com/big/SKILL.md": "x".repeat(600 * 1024) });
    await expect(importSkills({ source: "https://example.com/big/SKILL.md" })).rejects.toThrow(
      "is over 512 KB.",
    );
    expect((await readSkill({ id: "big" })).missing).toBe(true);

    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 64 * 1024;
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    // React Native's BodyInit types shadow the DOM's; Node's Response takes a stream.
    vi.stubGlobal("fetch", async () => new Response(endless as never));
    await expect(importSkills({ source: "https://example.com/endless/SKILL.md" })).rejects.toThrow(
      "is over 512 KB.",
    );
    expect(pulled).toBeLessThan(2 * 1024 * 1024);
  });
});
