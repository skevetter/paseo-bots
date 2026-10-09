import { describe, expect, it } from "vitest";
import { type Bot, type BotGroup, type BotState, DEFAULT_BOT_LIST_UI } from "../shared/bot";
import { applyChanges, resolveChanges } from "../shared/changes/apply";
import { type ApplyContext, type ProviderInfo, providerInfo, readyProvider } from "../shared/changes/context";
import { changeWarnings, describeChange } from "../shared/changes/describe";
import { botDetails, setupOverview } from "../shared/changes/overview";
import { type Change, ChangeSchema, ChangesSchema } from "../shared/changes/schema";
import { presetFromBot } from "../shared/presets";
import { defined, makeBot, NOW } from "./helpers";

const PROVIDERS: ProviderInfo[] = [
  {
    id: "claude",
    models: [
      { id: "opus", label: "Opus", isDefault: true, thinking: ["low", "high"], defaultThinking: null },
      { id: "haiku", label: "Haiku", isDefault: false, thinking: [], defaultThinking: null },
    ],
    modes: [
      { id: "default", label: "Default" },
      { id: "plan", label: "Plan" },
    ],
    defaultModeId: "default",
  },
  {
    id: "codex",
    models: [{ id: "gpt", label: "GPT", isDefault: true, thinking: [], defaultThinking: null }],
    modes: [{ id: "auto", label: "Auto" }],
    defaultModeId: "auto",
  },
];
const context: ApplyContext = { now: NOW, provider: "claude", providers: PROVIDERS };
const team = (patch: Partial<BotGroup> = {}): BotGroup => ({
  id: "t1",
  name: "Ops",
  logo: null,
  leadId: "chief",
  memberIds: ["chief", "scout"],
  instructions: "",
  createdAt: NOW,
  updatedAt: NOW,
  ...patch,
});

function setup(patch: Partial<BotState> = {}): BotState {
  return {
    bots: [
      makeBot({ id: "chief", name: "Chief" }),
      makeBot({ id: "scout", name: "Scout", model: "haiku" }),
      makeBot({ id: "solo", name: "Solo" }),
    ],
    history: [],
    library: {
      skills: [
        {
          id: "weekly-report",
          description: "Weekly report",
          source: "",
          enabled: true,
          reviewedSha: "abc",
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: "fetched",
          description: "From GitHub",
          source: "github.com/x/y",
          enabled: false,
          reviewedSha: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      mcpServers: [
        {
          id: "mcp-1",
          name: "github",
          description: "",
          enabled: false,
          config: { type: "http", url: "https://example.com/mcp", headers: {} },
          tools: null,
          checkedAt: null,
          checkError: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    },
    groups: [team()],
    ...patch,
  };
}

const apply = (changes: Change[], values = setup()) =>
  applyChanges(values, ChangesSchema.parse(changes), context);

describe("setup changes", () => {
  it("creates bots and a team that refers to them by name", () => {
    const next = apply([
      {
        type: "create_bot",
        name: "Juno",
        role: "ops",
        title: "Producer",
        skills: ["weekly-report"],
        apps: [{ app: "Gmail", tools: "read" }],
        playbooks: [{ name: "Standup", triggers: ["standup"], instructions: "Collect updates." }],
      },
      { type: "create_bot", name: "Mika", instructions: "Draw sprites." },
      {
        type: "create_team",
        name: "Studio",
        lead: "Juno",
        members: ["Mika", "solo"],
        instructions: "Ship on Fridays.",
      },
    ]);
    const juno = defined(
      next.bots.find((bot) => bot.name === "Juno"),
      "Juno",
    );
    expect(juno).toMatchObject({
      title: "Producer",
      provider: "claude",
      skillIds: ["weekly-report"],
      apps: ["gmail"],
      appRules: { gmail: { tools: "read", account: null } },
      contactBots: "ask",
    });
    expect(juno.soul).toMatch(/keep the user's week on track/i);
    expect(juno.playbooks.map((playbook) => playbook.name)).toEqual(["Standup"]);
    const mika = defined(
      next.bots.find((bot) => bot.name === "Mika"),
      "Mika",
    );
    expect(mika.soul).toBe("Draw sprites.");
    const studio = defined(
      next.groups?.find((group) => group.name === "Studio"),
      "Studio team",
    );
    expect(studio.leadId).toBe(juno.id);
    expect(studio.memberIds).toEqual([juno.id, mika.id, "solo"]);
    expect(studio.logo?.seed).toBeTruthy();
    expect(studio.instructions).toBe("Ship on Fridays.");
  });

  it("edits a bot, resets what belonged to its old provider and keeps the edit undoable", () => {
    const next = apply([
      {
        type: "update_bot",
        bot: "scout",
        provider: "codex",
        contact_bots: "off",
        add_skills: ["weekly-report"],
        allow_tools: ["github/search"],
        archived: true,
      },
    ]);
    const scout = defined(
      next.bots.find((bot) => bot.id === "scout"),
      "scout",
    );
    expect(scout).toMatchObject({
      provider: "codex",
      model: null,
      modeId: "auto",
      thinkingOptionId: null,
      contactBots: "off",
      skillIds: ["weekly-report"],
      alwaysAllow: ["github/search"],
      archived: true,
      updatedAt: NOW,
    });
    expect(next.history.map((entry) => [entry.botId, entry.snapshot.model])).toEqual([["scout", "haiku"]]);
  });
});

describe("setup change checks", () => {
  it("checks providers, models, modes and thinking", () => {
    expect(() => apply([{ type: "update_bot", bot: "Scout", provider: "gemini" }])).toThrow(
      'Change 1 (update_bot): There\'s no provider "gemini". Use one of: claude, codex.',
    );
    expect(() => apply([{ type: "update_bot", bot: "Scout", model: "opus-9" }])).toThrow(
      "claude has no model",
    );
    expect(() => apply([{ type: "update_bot", bot: "Scout", mode: "yolo" }])).toThrow(
      "Use one of: default, plan",
    );
    expect(() => apply([{ type: "update_bot", bot: "Scout", model: "opus", thinking: "max" }])).toThrow(
      "Use one of: low, high",
    );
    expect(
      apply([{ type: "update_bot", bot: "Scout", model: "opus", thinking: "high", mode: "plan" }]).bots[1],
    ).toMatchObject({ model: "opus", thinkingOptionId: "high", modeId: "plan" });
  });

  it("names the change that doesn't fit and what exists", () => {
    expect(() =>
      apply([
        { type: "create_bot", name: "A" },
        { type: "update_bot", bot: "Ghost", title: "x" },
      ]),
    ).toThrow('Change 2 (update_bot): There\'s no bot called "Ghost". There are: Chief, Scout, Solo, A.');
    expect(() => apply([{ type: "create_bot", name: "scout" }])).toThrow(
      'There\'s already a bot called "scout".',
    );
    expect(() => apply([{ type: "update_bot", bot: "Chief", add_skills: ["nope"] }])).toThrow(
      'no skill called "nope"',
    );
  });

  it("keeps the review and connection-test gates", () => {
    expect(() => apply([{ type: "set_skill", skill: "fetched", enabled: true }])).toThrow("needs a review");
    expect(
      apply([{ type: "set_skill", skill: "weekly-report", enabled: false }]).library?.skills[0]?.enabled,
    ).toBe(false);
    expect(() => apply([{ type: "set_mcp_server", server: "github", enabled: true }])).toThrow(
      "hasn't passed a connection test",
    );
    const added = defined(
      apply([
        { type: "add_mcp_server", name: "files", command: "npx", args: ["-y", "files-mcp"] },
      ]).library?.mcpServers.find((server) => server.name === "files"),
      "files server",
    );
    expect(added).toMatchObject({
      enabled: false,
      tools: null,
      config: { type: "stdio", command: "npx", args: ["-y", "files-mcp"], env: {} },
    });
    expect(() => apply([{ type: "add_mcp_server", name: "paseo", url: "https://x.dev" }])).toThrow(
      "is taken",
    );
    expect(() =>
      apply([{ type: "add_mcp_server", name: "both", url: "https://x.dev", command: "x" }]),
    ).toThrow("either a command");
  });
});

describe("setup changes to teams, routines and presets", () => {
  it("updates and deletes teams, routines and bots", () => {
    const next = apply([
      {
        type: "update_team",
        team: "Ops",
        lead: "Scout",
        add_members: ["Solo"],
        remove_members: ["Chief"],
        logo: { colour: 3 },
      },
      {
        type: "add_routine",
        bot: "Solo",
        name: "Digest",
        instructions: "Sum up the day.",
        schedule: { type: "daily", time: "18:00", weekdays: [1, 2, 3, 4, 5] },
      },
      { type: "update_routine", bot: "Solo", routine: "digest", enabled: false },
      { type: "delete_bot", bot: "Chief" },
    ]);
    expect(next.groups?.[0]).toMatchObject({
      leadId: "scout",
      memberIds: ["scout", "solo"],
      logo: { seed: "t1", palette: 3, imageUrl: null },
    });
    expect(next.bots.map((bot) => bot.id)).toEqual(["scout", "solo"]);
    expect(next.bots[1]?.routines[0]).toMatchObject({
      name: "Digest",
      enabled: false,
      schedule: { kind: "daily", time: "18:00", weekdays: [1, 2, 3, 4, 5] },
    });
    expect(apply([{ type: "delete_team", team: "t1" }]).groups).toEqual([]);
  });

  it("sets defaults and presets", () => {
    const next = apply([
      { type: "set_defaults", provider: "codex", contact_bots: "off" },
      { type: "save_preset", bot: "Scout" },
    ]);
    expect(next.defaults).toEqual({
      provider: "codex",
      model: null,
      modeId: null,
      thinkingOptionId: null,
      contactBots: "off",
    });
    expect(next.presets?.map((preset) => preset.name)).toEqual(["Scout"]);
    expect(apply([{ type: "delete_preset", preset: "scout" }], next).presets).toEqual([]);
  });

  it("creates a bot from a preset with the defaults, and not from a preset and a role at once", () => {
    const scout = makeBot({
      id: "scout",
      name: "Scout",
      title: "Researcher",
      soul: "Cite sources.",
      avatar: { seed: "scout-face", palette: 2, shape: "square", imageUrl: null },
      skillIds: ["weekly-report"],
      modeId: "plan",
    });
    const values = setup({
      presets: [{ ...presetFromBot(scout, NOW), id: "pr-1" }],
      defaults: { provider: "codex", model: "gpt", modeId: null, thinkingOptionId: null, contactBots: "off" },
    });
    const juno = apply([{ type: "create_bot", name: "Juno", preset: "scout", title: "Analyst" }], values)
      .bots[3];
    expect(juno).toMatchObject({
      name: "Juno",
      title: "Analyst",
      soul: "Cite sources.",
      avatar: scout.avatar,
      skillIds: ["weekly-report"],
      provider: "codex",
      model: "gpt",
      modeId: null,
      contactBots: "off",
    });
    expect(() => apply([{ type: "create_bot", name: "Juno", preset: "pr-1", role: "ops" }], values)).toThrow(
      "Start from a role or a preset, not both.",
    );
    expect(describeChange(ChangeSchema.parse({ type: "create_bot", name: "Juno", preset: "Scout" }))).toBe(
      "**New bot Juno**: starts from preset Scout",
    );
  });
});

describe("team membership edits", () => {
  it("takes the Chief of Staff off the team when the change removes them", () => {
    const [ops] = apply([{ type: "update_team", team: "Ops", remove_members: ["Chief"] }]).groups ?? [];
    expect(ops).toMatchObject({ leadId: null, memberIds: ["scout"] });
  });
});

describe("setup changes on the host", () => {
  it("resolves app accounts by name on the host", () => {
    const accounts = [{ id: "ca_1", slug: "gmail", names: ["work"] }];
    const changes = resolveChanges(
      ChangesSchema.parse([
        { type: "update_bot", bot: "Solo", add_apps: [{ app: "gmail", account: "Work" }] },
      ]),
      { ...context, accounts },
    );
    expect(changes[0]).toMatchObject({ add_apps: [{ app: "gmail", account: "ca_1" }] });
    expect(applyChanges(setup(), changes, { now: NOW, provider: "" }).bots[2]?.appRules).toEqual({
      gmail: { tools: "all", account: "ca_1" },
    });
    expect(() =>
      resolveChanges(
        ChangesSchema.parse([
          { type: "update_bot", bot: "Solo", add_apps: [{ app: "slack", account: "x" }] },
        ]),
        { ...context, accounts },
      ),
    ).toThrow("slack isn't connected yet");
  });

  it("names X by Composio's slug, so its account and connection are found", () => {
    const accounts = [{ id: "ca_9", slug: "twitter", names: ["brand"] }];
    const changes = resolveChanges(
      ChangesSchema.parse([{ type: "update_bot", bot: "Solo", add_apps: [{ app: "X", account: "Brand" }] }]),
      { ...context, accounts },
    );
    const added = botIn(applyChanges(setup(), changes, { now: NOW, provider: "" }), "solo");
    expect(added.apps).toEqual(["twitter"]);
    expect(added.appRules).toEqual({ twitter: { tools: "all", account: "ca_9" } });
    const values = setup({ bots: [added] });
    expect(soloAfter([{ type: "update_bot", bot: "Solo", remove_apps: ["x"] }], values).apps).toEqual([]);
  });

  it("gives new bots the defaults' provider, else the host's pick", () => {
    expect(apply([{ type: "create_bot", name: "Juno" }]).bots[3]?.provider).toBe("claude");
    const withDefaults = setup({
      defaults: { provider: "codex", model: "gpt", modeId: null, thinkingOptionId: null, contactBots: "off" },
    });
    expect(apply([{ type: "create_bot", name: "Juno" }], withDefaults).bots[3]).toMatchObject({
      provider: "codex",
      model: "gpt",
      contactBots: "off",
    });
  });
});

describe("setup descriptions", () => {
  it("describes changes plainly and flags more access", () => {
    const changes = ChangesSchema.parse([
      { type: "create_team", name: "Studio", lead: "Juno", members: ["Juno", "Mika"] },
      {
        type: "update_bot",
        bot: "Scout",
        mode: "plan",
        allow_tools: ["github/search"],
        add_apps: [{ app: "gmail", tools: "read" }],
      },
      { type: "add_mcp_server", name: "files", command: "npx", args: ["files-mcp"] },
      { type: "delete_bot", bot: "Chief" },
    ]);
    expect(changes.map(describeChange)).toEqual([
      "**New team Studio**: led by Juno; with Mika",
      "**Scout**: approval mode plan; may use gmail (read-only tools); uses github/search without asking",
      "**New MCP server files**: runs `npx files-mcp`; off until it passes a test in Skills & Tools",
      "**Delete bot Chief**; its chats stay in Paseo's history",
    ]);
    expect(changeWarnings(changes)).toEqual([
      'Scout runs in approval mode "plan".',
      "Scout may use github/search without asking you.",
      "Scout may use gmail with your connected accounts.",
      "The files MCP server runs a program on this computer once it's on.",
      "Deletes the bot Chief.",
    ]);
  });

  it("gives an overview and a bot's details", () => {
    const text = setupOverview(setup(), PROVIDERS, null);
    expect(text).toContain(
      "- Chief (id chief). claude · default model; team Ops (Chief of Staff); contact other bots: ask.",
    );
    expect(text).toContain("- fetched: From GitHub [needs review]");
    expect(text).toContain("- github [off, untested]");
    expect(text).toContain(
      "- claude: models opus (default) [thinking: low, high], haiku; modes default (default), plan",
    );
    expect(text).toContain("Connected apps: not set up.");
    expect(botDetails(setup(), "scout")).toContain("Instructions (Soul):\n(none)");
  });
});

describe("provider snapshot", () => {
  it("keeps enabled providers and selectable models, and picks a ready default", () => {
    const entries = [
      {
        provider: "codex",
        enabled: true,
        status: "ready",
        models: [
          {
            id: "gpt",
            label: "GPT",
            isDefault: true,
            thinkingOptions: [{ id: "low" }, { id: "high" }],
            defaultThinkingOptionId: "high",
          },
          { id: "old", label: "Old", isSelectable: false },
        ],
        modes: [{ id: "auto", label: "Auto" }],
        defaultModeId: "auto",
      },
      { provider: "claude", enabled: true, status: "loading" },
      { provider: "gemini", enabled: false, status: "ready" },
    ];
    expect(providerInfo(entries)).toEqual([
      {
        id: "codex",
        models: [
          { id: "gpt", label: "GPT", isDefault: true, thinking: ["low", "high"], defaultThinking: "high" },
        ],
        modes: [{ id: "auto", label: "Auto" }],
        defaultModeId: "auto",
      },
      { id: "claude", models: [], modes: [], defaultModeId: null },
    ]);
    expect(readyProvider(entries)).toBe("codex");
    expect(readyProvider([...entries, { provider: "claude", enabled: true, status: "ready" }])).toBe(
      "claude",
    );
  });
});

const rich = (): Bot =>
  makeBot({
    id: "rich",
    name: "Rich",
    title: "Analyst",
    description: "Reads reports.",
    soul: "Be brief.",
    avatar: { seed: "r", palette: 2, shape: "square", imageUrl: "https://x.dev/a.png" },
    model: "opus",
    modeId: "plan",
    thinkingOptionId: "low",
    skillIds: ["weekly-report"],
    mcpServerIds: ["mcp-1"],
    apps: ["gmail", "slack"],
    appRules: { slack: { tools: "read", account: "ca_1" } },
    alwaysAllow: ["github/search"],
    playbooks: [{ id: "pb-1", name: "Triage", triggers: ["triage", "sort"], instructions: "Sort it." }],
    routines: [
      {
        id: "r-1",
        name: "Digest",
        prompt: "Sum up.",
        enabled: true,
        schedule: { kind: "interval", minutes: 60 },
        resultsChatId: null,
        createdAt: NOW,
      },
    ],
    cwd: "/work",
  });

const withRich = (): BotState => {
  const values = setup();
  return { ...values, bots: [...values.bots, rich()] };
};

const at = (minutes: number): ApplyContext => ({
  ...context,
  now: new Date(Date.parse(NOW) + minutes * 60_000).toISOString(),
});

const botIn = (values: BotState, id: string) =>
  defined(
    values.bots.find((bot) => bot.id === id),
    id,
  );

/** What History's Restore puts back: the newest snapshot of the bot. */
function undo(values: BotState, id: string): Bot {
  const entries = values.history.filter((entry) => entry.botId === id);
  return defined(entries.at(-1), `${id} history`).snapshot;
}

const EVERY_FIELD: Change = {
  type: "update_bot",
  bot: "Rich",
  name: "Richer",
  title: "Lead\n  analyst",
  description: " New blurb ",
  instructions: " Be thorough. ",
  model: "haiku",
  mode: "default",
  thinking: null,
  contact_bots: "allow",
  avatar: { new_face: true, colour: null, shape: "circle" },
  working_folder: "C:\\work",
  pinned: true,
  archived: true,
  add_skills: ["fetched"],
  remove_skills: ["weekly-report"],
  remove_mcp_servers: ["github"],
  add_apps: [{ app: "Notion", tools: ["search"] }, { app: "slack" }],
  remove_apps: ["GMAIL"],
  allow_tools: [" notion/search "],
  disallow_tools: ["github/search"],
  add_playbooks: [
    { name: "triage", triggers: ["triage", " sort ", "sort"], instructions: " Sort better. " },
    { name: "Recap", triggers: ["recap"], instructions: "Recap the week." },
  ],
};

function expectEveryFieldEdited(edited: Bot): void {
  expect(edited).toMatchObject({
    name: "Richer",
    title: "Lead analyst",
    description: "New blurb",
    soul: "Be thorough.",
    model: "haiku",
    modeId: "default",
    thinkingOptionId: null,
    contactBots: "allow",
    avatar: { palette: null, shape: "circle", imageUrl: null },
    cwd: "C:\\work",
    pinned: true,
    archived: true,
    skillIds: ["fetched"],
    mcpServerIds: [],
    apps: ["slack", "notion"],
    appRules: { notion: { tools: ["search"], account: null } },
    alwaysAllow: ["notion/search"],
    updatedAt: NOW,
  });
  expect(edited.avatar.seed).not.toBe("r");
  expect(edited.playbooks).toEqual([
    { id: "pb-1", name: "triage", triggers: ["triage", "sort"], instructions: "Sort better." },
    { id: expect.any(String), name: "Recap", triggers: ["recap"], instructions: "Recap the week." },
  ]);
}

const ROUTINE_EDITS: Change[] = [
  {
    type: "add_routine",
    bot: "Rich",
    name: " Ping ",
    instructions: " Check in. ",
    schedule: { type: "webhook" },
  },
  { type: "add_routine", bot: "rich", name: "Temp", instructions: "x", schedule: { type: "webhook" } },
  {
    type: "update_routine",
    bot: "Rich",
    routine: "digest",
    name: "Daily digest",
    instructions: "Sum up the day.",
    schedule: { type: "daily", time: "08:30" },
    enabled: false,
  },
  { type: "update_routine", bot: "Rich", routine: "Ping", instructions: "Pong." },
  { type: "delete_routine", bot: "Rich", routine: "temp" },
];

describe("undoing applied setup changes", () => {
  it("edits every field of a bot, and History's Restore brings the original back exactly", () => {
    const original = withRich();
    const next = applyChanges(original, ChangesSchema.parse([EVERY_FIELD]), context);
    expectEveryFieldEdited(botIn(next, "rich"));
    expect(next.history).toEqual([{ botId: "rich", at: NOW, snapshot: rich() }]);
    expect(undo(next, "rich")).toEqual(botIn(original, "rich"));
  });

  it("adds, edits and deletes routines as one undoable step", () => {
    const next = applyChanges(withRich(), ChangesSchema.parse(ROUTINE_EDITS), context);
    expect(botIn(next, "rich").routines).toEqual([
      {
        id: "r-1",
        name: "Daily digest",
        prompt: "Sum up the day.",
        enabled: false,
        schedule: { kind: "daily", time: "08:30", weekdays: [0, 1, 2, 3, 4, 5, 6] },
        resultsChatId: null,
        createdAt: NOW,
      },
      expect.objectContaining({
        name: "Ping",
        prompt: "Pong.",
        enabled: true,
        schedule: { kind: "webhook" },
      }),
    ]);
    expect(next.history).toHaveLength(1);
    expect(undo(next, "rich")).toEqual(rich());
  });

  it("keeps one History step per proposal a minute apart, and restores them newest first", () => {
    const first = applyChanges(withRich(), [{ type: "update_bot", bot: "rich", title: "One" }], context);
    const second = applyChanges(first, [{ type: "update_bot", bot: "rich", title: "Two" }], at(2));
    expect(second.history.map((entry) => [entry.at, entry.snapshot.title])).toEqual([
      [NOW, "Analyst"],
      [at(2).now, "One"],
    ]);
    expect(undo(second, "rich")).toEqual(botIn(first, "rich"));
    const quick = applyChanges(first, [{ type: "update_bot", bot: "rich", title: "Two" }], at(0.5));
    expect(quick.history).toEqual(first.history);
    expect(undo(quick, "rich")).toEqual(rich());
  });

  it("records no History for a new bot until a later change edits it", () => {
    const created = apply([{ type: "create_bot", name: "Juno", title: "First" }]);
    expect(created.history).toEqual([]);
    const edited = apply([
      { type: "create_bot", name: "Juno", title: "First" },
      { type: "update_bot", bot: "Juno", title: "Second" },
    ]);
    const juno = defined(edited.bots.find((bot) => bot.name === "Juno"));
    expect(juno.title).toBe("Second");
    expect(undo(edited, juno.id)).toMatchObject({ id: juno.id, title: "First" });
  });

  it("leaves the values it was given untouched, even when a change fails", () => {
    const values = withRich();
    const before = structuredClone(values);
    applyChanges(values, ChangesSchema.parse([...ROUTINE_EDITS, EVERY_FIELD]), context);
    expect(() =>
      applyChanges(values, ChangesSchema.parse([EVERY_FIELD, { type: "delete_bot", bot: "Ghost" }]), context),
    ).toThrow('Change 2 (delete_bot): There\'s no bot called "Ghost".');
    expect(values).toEqual(before);
  });
});

describe("deleting bots", () => {
  it("removes the bot from History, its team and the bot list's state", () => {
    const values = setup({
      history: [
        { botId: "chief", at: NOW, snapshot: makeBot({ id: "chief" }) },
        { botId: "solo", at: NOW, snapshot: makeBot({ id: "solo" }) },
      ],
      ui: {
        ...DEFAULT_BOT_LIST_UI,
        collapsed: ["chief", "solo"],
        pinnedChats: [
          { botId: "chief", chatId: "c1" },
          { botId: "solo", chatId: "c2" },
        ],
        chatOrder: { chief: ["c1"], solo: ["c2"] },
      },
    });
    const next = apply([{ type: "delete_bot", bot: "Chief" }], values);
    expect(next.history.map((entry) => entry.botId)).toEqual(["solo"]);
    expect(next.groups?.[0]).toMatchObject({ leadId: null, memberIds: ["scout"], updatedAt: NOW });
    expect(next.ui).toMatchObject({
      collapsed: ["solo"],
      pinnedChats: [{ botId: "solo", chatId: "c2" }],
      chatOrder: { solo: ["c2"] },
    });
  });

  it("works without teams or bot list state", () => {
    const next = apply([{ type: "delete_bot", bot: "solo" }], setup({ groups: undefined }));
    expect(next.groups).toEqual([]);
    expect(next.ui).toBeUndefined();
  });
});

describe("stale and ambiguous targets", () => {
  it("fails on a bot, team, routine or preset that's gone", () => {
    const gone = apply([{ type: "delete_bot", bot: "Chief" }]);
    expect(() => apply([{ type: "update_bot", bot: "Chief", pinned: true }], gone)).toThrow(
      'Change 1 (update_bot): There\'s no bot called "Chief". There are: Scout, Solo.',
    );
    expect(() => apply([{ type: "update_team", team: "Ops", name: "Core" }], setup({ groups: [] }))).toThrow(
      'Change 1 (update_team): There\'s no team called "Ops".',
    );
    expect(() => apply([{ type: "delete_routine", bot: "Solo", routine: "Digest" }])).toThrow(
      'There\'s no routine called "Digest".',
    );
    expect(() => apply([{ type: "delete_preset", preset: "Starter" }])).toThrow(
      'There\'s no preset called "Starter".',
    );
  });

  it("still finds a renamed bot by id, and asks for the id when names collide", () => {
    const values = setup({
      bots: [makeBot({ id: "a", name: "Twin" }), makeBot({ id: "b", name: " twin " })],
    });
    expect(() => apply([{ type: "update_bot", bot: "TWIN", pinned: true }], values)).toThrow(
      '2 bots are called "TWIN". Use the id.',
    );
    const next = apply([{ type: "update_bot", bot: " b ", name: "Second" }], values);
    expect(next.bots.map((bot) => bot.name)).toEqual(["Twin", "Second"]);
    expect(apply([{ type: "update_bot", bot: "b", pinned: true }], next).bots[1]?.pinned).toBe(true);
  });

  it("renames a bot only to a name no other bot has", () => {
    expect(apply([{ type: "update_bot", bot: "Scout", name: " SCOUT " }]).bots[1]?.name).toBe("SCOUT");
    expect(() => apply([{ type: "update_bot", bot: "Scout", name: "chief" }])).toThrow(
      'There\'s already a bot called "chief".',
    );
  });
});

const soloAfter = (changes: Change[], values = setup()) => botIn(apply(changes, values), "solo");

describe("bot field checks", () => {
  it("sets, keeps and removes a bot's picture", () => {
    const pictured = soloAfter([
      { type: "update_bot", bot: "Solo", avatar: { image_url: " https://x.dev/p.png ", colour: 4 } },
    ]);
    expect(pictured.avatar).toEqual({
      seed: "s",
      palette: 4,
      shape: "circle",
      imageUrl: "https://x.dev/p.png",
    });
    const values = setup({ bots: [pictured] });
    expect(
      soloAfter([{ type: "update_bot", bot: "Solo", avatar: { shape: "square" } }], values).avatar,
    ).toEqual({
      ...pictured.avatar,
      shape: "square",
    });
    expect(
      soloAfter([{ type: "update_bot", bot: "Solo", avatar: { image_url: null } }], values).avatar.imageUrl,
    ).toBe(null);
    expect(() =>
      apply([{ type: "update_bot", bot: "Solo", avatar: { image_url: "ftp://x.dev/p.png" } }]),
    ).toThrow("A picture needs an https:// or data:image URL.");
  });

  it("takes only absolute working folders, and blank for the bot's own", () => {
    expect(soloAfter([{ type: "update_bot", bot: "Solo", working_folder: "/srv/app" }]).cwd).toBe("/srv/app");
    expect(soloAfter([{ type: "update_bot", bot: "Solo", working_folder: "D:/code" }]).cwd).toBe("D:/code");
    const values = setup({ bots: [makeBot({ id: "solo", name: "Solo", cwd: "/old" })] });
    expect(soloAfter([{ type: "update_bot", bot: "Solo", working_folder: "  " }], values).cwd).toBeNull();
    expect(soloAfter([{ type: "update_bot", bot: "Solo", working_folder: null }], values).cwd).toBeNull();
    expect(() => apply([{ type: "update_bot", bot: "Solo", working_folder: "code/app" }])).toThrow(
      "A working folder needs an absolute path.",
    );
  });

  it("replaces a playbook by name in place and removes others", () => {
    const playbook = (id: string, name: string) => ({ id, name, triggers: [name], instructions: "x" });
    const values = setup({
      bots: [
        makeBot({
          id: "solo",
          name: "Solo",
          playbooks: [playbook("p1", "A"), playbook("p2", "B"), playbook("p3", "C")],
        }),
      ],
    });
    const next = soloAfter(
      [
        {
          type: "update_bot",
          bot: "Solo",
          remove_playbooks: [" c "],
          add_playbooks: [{ name: "b", triggers: ["  ", "bee"], instructions: "y" }],
        },
      ],
      values,
    );
    expect(next.playbooks).toEqual([
      playbook("p1", "A"),
      { id: "p2", name: "b", triggers: ["bee"], instructions: "y" },
    ]);
  });

  it("rejects bad app slugs, apps the bot doesn't use and malformed tool grants", () => {
    expect(() => apply([{ type: "update_bot", bot: "Solo", add_apps: [{ app: "g mail" }] }])).toThrow(
      '"g mail" isn\'t an app slug, like gmail.',
    );
    expect(() => apply([{ type: "update_bot", bot: "Solo", remove_apps: ["gmail"] }])).toThrow(
      "Solo doesn't use gmail.",
    );
    expect(() => apply([{ type: "update_bot", bot: "Solo", allow_tools: ["search"] }])).toThrow(
      '"search" isn\'t a tool as "server/tool".',
    );
    expect(() => apply([{ type: "update_bot", bot: "Solo", remove_playbooks: ["Ghost"] }])).toThrow(
      'Solo has no playbook called "Ghost".',
    );
  });
});

describe("agent and app account checks", () => {
  it("checks an app account by name when the host knows the accounts", () => {
    const accounts = [
      { id: "ca_1", slug: "gmail", names: ["work"] },
      { id: "ca_2", slug: "gmail", names: ["home", "personal"] },
    ];
    const change: Change[] = [
      { type: "update_bot", bot: "Solo", add_apps: [{ app: "gmail", account: "Personal" }] },
    ];
    expect(applyChanges(setup(), change, { ...context, accounts }).bots[2]?.appRules).toEqual({
      gmail: { tools: "all", account: "ca_2" },
    });
    const unknown: Change[] = [
      { type: "update_bot", bot: "Solo", add_apps: [{ app: "gmail", account: "school" }] },
    ];
    expect(() => applyChanges(setup(), unknown, { ...context, accounts })).toThrow(
      'gmail has no account called "school". Its accounts: work, home.',
    );
  });

  it("checks thinking against the default model and skips checks when providers are unknown", () => {
    expect(soloAfter([{ type: "update_bot", bot: "Solo", thinking: "high" }]).thinkingOptionId).toBe("high");
    expect(() => apply([{ type: "update_bot", bot: "Solo", model: "haiku", thinking: "low" }])).toThrow(
      'That model has no thinking option "low". Use one of: none.',
    );
    const bare = [{ id: "bare", models: [], modes: [], defaultModeId: null }];
    expect(() =>
      applyChanges(setup(), [{ type: "update_bot", bot: "Solo", provider: "bare", mode: "x" }], {
        ...context,
        providers: bare,
      }),
    ).toThrow('bare has no mode "x". Use one of: none.');
    const unchecked = applyChanges(setup(), [{ type: "update_bot", bot: "Solo", provider: "gemini" }], {
      now: NOW,
      provider: "claude",
    });
    expect(unchecked.bots[2]).toMatchObject({ provider: "gemini", model: null, modeId: null });
  });

  it("moves to the new model's default thinking when a model change leaves the current one behind", () => {
    const claude = defined(PROVIDERS[0]);
    const sonnet = {
      id: "sonnet",
      label: "Sonnet",
      isDefault: false,
      thinking: ["medium"],
      defaultThinking: "medium",
    };
    const providers = [{ ...claude, models: [...claude.models, sonnet] }];
    const values = setup({
      bots: [
        makeBot({ id: "chief", name: "Chief" }),
        makeBot({ id: "scout", name: "Scout" }),
        makeBot({ id: "solo", name: "Solo", thinkingOptionId: "high" }),
      ],
      defaults: CLAUDE_DEFAULTS,
    });
    const changed = (change: Change) =>
      applyChanges(values, ChangesSchema.parse([change]), { ...context, providers });
    const solo = (model: string) =>
      changed({ type: "update_bot", bot: "Solo", model }).bots[2]?.thinkingOptionId;
    expect([solo("sonnet"), solo("haiku"), solo("opus")]).toEqual(["medium", null, "high"]);
    expect(changed({ type: "set_defaults", model: "sonnet" }).defaults).toMatchObject({
      model: "sonnet",
      thinkingOptionId: "medium",
    });
    expect(() => changed({ type: "update_bot", bot: "Solo", model: "sonnet", thinking: "high" })).toThrow(
      'That model has no thinking option "high". Use one of: medium.',
    );
  });
});

describe("team changes", () => {
  it("creates a team without a lead, moving its members off their old team", () => {
    const next = apply([{ type: "create_team", name: "Field", members: ["Solo", "Scout"] }]);
    const [ops, field] = next.groups ?? [];
    expect(field).toMatchObject({
      name: "Field",
      leadId: null,
      memberIds: ["solo", "scout"],
      instructions: "",
    });
    expect(ops).toMatchObject({ leadId: "chief", memberIds: ["chief"], updatedAt: NOW });
  });

  it("creates a first team with a picture logo and a lead taken from another team", () => {
    const first = apply(
      [
        {
          type: "create_team",
          name: "Solo act",
          lead: "Solo",
          logo: { image_url: "https://x.dev/l.png", colour: 1 },
        },
      ],
      setup({ groups: undefined }),
    );
    expect(first.groups).toEqual([
      expect.objectContaining({
        leadId: "solo",
        memberIds: ["solo"],
        logo: { seed: expect.any(String), palette: 1, imageUrl: "https://x.dev/l.png" },
      }),
    ]);
    const stolen = apply([{ type: "create_team", name: "Board", lead: "Chief" }]);
    expect(stolen.groups?.[0]).toMatchObject({ leadId: null, memberIds: ["scout"] });
    expect(stolen.groups?.[1]).toMatchObject({ leadId: "chief", memberIds: ["chief"] });
  });

  it("renames a team, drops its Chief of Staff to a member and redraws its logo", () => {
    const values = setup({
      groups: [team({ logo: { seed: "old", palette: 2, imageUrl: "https://x.dev/l.png" } })],
    });
    const next = apply(
      [
        {
          type: "update_team",
          team: "ops",
          name: "Core\nteam",
          lead: null,
          instructions: " Be kind. ",
          logo: { new_logo: true },
        },
      ],
      values,
    );
    const [core] = next.groups ?? [];
    expect(core).toMatchObject({
      name: "Core team",
      leadId: null,
      memberIds: ["chief", "scout"],
      instructions: "Be kind.",
      logo: { palette: 2, imageUrl: null },
    });
    expect(core?.logo?.seed).not.toBe("old");
  });

  it("makes an outsider Chief of Staff, and an explicit lead wins over removing them", () => {
    expect(apply([{ type: "update_team", team: "Ops", lead: "Solo" }]).groups?.[0]).toMatchObject({
      leadId: "solo",
      memberIds: ["chief", "scout", "solo"],
    });
    expect(
      apply([{ type: "update_team", team: "Ops", lead: "Scout", remove_members: ["Scout", "Chief"] }])
        .groups?.[0],
    ).toMatchObject({ leadId: "scout", memberIds: ["scout"] });
  });

  it("moves an added member off the team they were on", () => {
    const values = setup({
      groups: [team(), team({ id: "t2", name: "Labs", leadId: null, memberIds: ["solo"] })],
    });
    const [ops, labs] =
      apply([{ type: "update_team", team: "Labs", add_members: ["Scout"] }], values).groups ?? [];
    expect(ops).toMatchObject({ leadId: "chief", memberIds: ["chief"] });
    expect(labs).toMatchObject({ leadId: null, memberIds: ["solo", "scout"] });
  });

  it("deletes a team and keeps its bots", () => {
    const next = apply(
      [{ type: "delete_team", team: "Ops" }],
      setup({ groups: [team(), team({ id: "t2", name: "Labs" })] }),
    );
    expect(next.groups?.map((group) => group.id)).toEqual(["t2"]);
    expect(next.bots).toHaveLength(3);
    expect(() => apply([{ type: "delete_team", team: "Ops" }], setup({ groups: undefined }))).toThrow(
      'There\'s no team called "Ops".',
    );
  });
});

const TESTED_SERVER = {
  id: "mcp-live",
  name: "live",
  description: "Live docs",
  enabled: false,
  config: { type: "http" as const, url: "https://live.dev/mcp", headers: {} },
  tools: [],
  checkedAt: NOW,
  checkError: null,
  createdAt: NOW,
  updatedAt: NOW,
};

describe("library changes", () => {
  it("adds a remote MCP server and gives it to a bot in the same proposal", () => {
    const next = apply([
      {
        type: "add_mcp_server",
        name: "docs",
        description: " Product docs ",
        url: "https://docs.dev/mcp",
        transport: "sse",
        headers: { Authorization: "Bearer x" },
      },
      { type: "add_mcp_server", name: "plain", url: "https://plain.dev/mcp" },
      { type: "update_bot", bot: "Solo", add_mcp_servers: ["docs"] },
    ]);
    const docs = defined(next.library?.mcpServers.find((server) => server.name === "docs"));
    expect(docs).toMatchObject({
      description: "Product docs",
      enabled: false,
      config: { type: "sse", url: "https://docs.dev/mcp", headers: { Authorization: "Bearer x" } },
    });
    expect(next.library?.mcpServers.find((server) => server.name === "plain")?.config).toEqual({
      type: "http",
      url: "https://plain.dev/mcp",
      headers: {},
    });
    expect(next.bots[2]?.mcpServerIds).toEqual([docs.id]);
  });

  it("rejects a taken MCP server name or one with neither command nor URL", () => {
    expect(() => apply([{ type: "add_mcp_server", name: "github", url: "https://x.dev" }])).toThrow(
      'There\'s already an MCP server called "github".',
    );
    expect(() => apply([{ type: "add_mcp_server", name: "empty" }])).toThrow("either a command");
  });

  it("turns a tested MCP server on and off", () => {
    const values = setup();
    const library = defined(values.library);
    const withLive = {
      ...values,
      library: { ...library, mcpServers: [...library.mcpServers, TESTED_SERVER] },
    };
    const on = apply([{ type: "set_mcp_server", server: "live", enabled: true }], withLive);
    expect(on.library?.mcpServers.map((server) => server.enabled)).toEqual([false, true]);
    const off = apply([{ type: "set_mcp_server", server: "mcp-live", enabled: false }], on);
    expect(off.library?.mcpServers[1]).toMatchObject({ enabled: false, updatedAt: NOW });
    expect(off.library?.mcpServers[0]).toBe(on.library?.mcpServers[0]);
  });

  it("removes an MCP server from the library and every bot that used it, with its always-allowed tools", () => {
    const values = setup({
      bots: [
        makeBot({
          id: "solo",
          name: "Solo",
          mcpServerIds: ["mcp-1", "mcp-x"],
          alwaysAllow: ["github/search", "github/get_issue", "githubber/search", "files/read"],
        }),
      ],
    });
    const next = apply([{ type: "remove_mcp_server", server: "github" }], values);
    expect(next.library?.mcpServers).toEqual([]);
    expect(next.bots[0]).toMatchObject({
      mcpServerIds: ["mcp-x"],
      alwaysAllow: ["githubber/search", "files/read"],
    });
  });

  it("treats a missing library as empty", () => {
    const bare = setup({ library: undefined });
    expect(() => apply([{ type: "remove_mcp_server", server: "github" }], bare)).toThrow(
      'There\'s no MCP server called "github".',
    );
    expect(() => apply([{ type: "set_mcp_server", server: "github", enabled: false }], bare)).toThrow(
      "no MCP server",
    );
    expect(() => apply([{ type: "set_skill", skill: "weekly-report", enabled: false }], bare)).toThrow(
      'There\'s no skill called "weekly-report".',
    );
    expect(() => apply([{ type: "create_bot", name: "Juno", mcp_servers: ["github"] }], bare)).toThrow(
      "no MCP server",
    );
    const added = apply([{ type: "add_mcp_server", name: "docs", url: "https://docs.dev/mcp" }], bare);
    expect(added.library?.mcpServers.map((server) => server.name)).toEqual(["docs"]);
    expect(apply([{ type: "update_bot", bot: "Solo", title: "Lone" }], bare).bots[2]?.title).toBe("Lone");
  });

  it("creates a bot with library MCP servers", () => {
    const next = apply([{ type: "create_bot", name: "Juno", mcp_servers: ["github"] }]);
    expect(next.bots[3]?.mcpServerIds).toEqual(["mcp-1"]);
  });
});

const CLAUDE_DEFAULTS = {
  provider: "claude",
  model: "opus",
  modeId: "plan",
  thinkingOptionId: "low",
  contactBots: "allow" as const,
};

describe("new-bot defaults", () => {
  it("keeps what belongs to the same provider and replaces only what the change names", () => {
    const values = setup({ defaults: CLAUDE_DEFAULTS });
    expect(
      apply([{ type: "set_defaults", provider: " claude ", model: "haiku", thinking: null }], values)
        .defaults,
    ).toEqual({
      ...CLAUDE_DEFAULTS,
      model: "haiku",
      thinkingOptionId: null,
    });
    expect(apply([{ type: "set_defaults", mode: "default" }], values).defaults).toEqual({
      ...CLAUDE_DEFAULTS,
      modeId: "default",
    });
  });

  it("checks the defaults against the providers, unless any ready provider will do", () => {
    expect(() => apply([{ type: "set_defaults", provider: "codex", mode: "plan" }])).toThrow(
      'codex has no mode "plan". Use one of: auto.',
    );
    expect(apply([{ type: "set_defaults", provider: "", model: "anything" }]).defaults).toMatchObject({
      provider: "",
      model: "anything",
    });
  });

  it("starts a new bot from the defaults' model only when the defaults name a provider", () => {
    const any = setup({ defaults: { ...CLAUDE_DEFAULTS, provider: "" } });
    expect(apply([{ type: "create_bot", name: "Juno" }], any).bots[3]).toMatchObject({
      provider: "claude",
      model: null,
      modeId: null,
      thinkingOptionId: null,
      contactBots: "allow",
    });
    const claude = setup({ defaults: CLAUDE_DEFAULTS });
    expect(apply([{ type: "create_bot", name: "Juno", provider: "codex" }], claude).bots[3]).toMatchObject({
      provider: "codex",
      model: null,
      modeId: "auto",
      thinkingOptionId: null,
    });
  });
});

describe("resolving proposals on the host", () => {
  it("resolves new bots' app accounts and passes other changes through", () => {
    const accounts = [{ id: "ca_1", slug: "gmail", names: ["work"] }];
    const changes = ChangesSchema.parse([
      { type: "create_bot", name: "Juno", apps: [{ app: " Gmail ", account: "work" }, { app: "slack" }] },
      { type: "update_bot", bot: "Solo", pinned: true },
      { type: "delete_team", team: "Ops" },
    ]);
    const [created, updated, deleted] = resolveChanges(changes, { ...context, accounts });
    expect(created).toMatchObject({ apps: [{ app: " Gmail ", account: "ca_1" }, { app: "slack" }] });
    expect(updated).toEqual(changes[1]);
    expect(deleted).toBe(changes[2]);
    expect(resolveChanges(changes, context)[0]).toMatchObject({
      apps: [{ account: "work" }, { app: "slack" }],
    });
  });
});

const DESCRIBED: [unknown, string][] = [
  [
    {
      type: "create_bot",
      name: "Juno\nBot",
      role: "ops",
      title: "Producer",
      description: "x",
      instructions: "y",
      provider: "codex",
      model: null,
      mode: null,
      thinking: "high",
      contact_bots: "allow",
      avatar: { image_url: "https://x.dev/a.png" },
      working_folder: "/w",
      pinned: true,
      skills: ["weekly-report"],
      mcp_servers: ["github"],
      apps: [
        { app: "gmail", tools: ["send", "read_mail"], account: "work" },
        { app: "slack", tools: "all" },
      ],
      playbooks: [{ name: "Standup", triggers: ["standup"], instructions: "z" }],
    },
    '**New bot Juno Bot**: starts as Operations; title "Producer"; a new blurb; new instructions; provider codex; the default model; the default approval mode; thinking high; contacts other bots freely; a picture; working folder /w; pinned; skills weekly-report; MCP servers github; apps gmail (send, read_mail) with one account, slack; playbooks Standup',
  ],
  [{ type: "create_bot", name: "Bare" }, "**New bot Bare**"],
  [
    {
      type: "update_bot",
      bot: "Scout",
      name: "Scout 2",
      model: "opus",
      thinking: null,
      avatar: { image_url: null },
      working_folder: null,
      pinned: false,
      archived: false,
      add_skills: ["a"],
      remove_skills: ["b"],
      add_mcp_servers: ["github"],
      remove_mcp_servers: ["files"],
      remove_apps: ["gmail"],
      disallow_tools: ["github/search"],
      add_playbooks: [{ name: "Recap", triggers: ["recap"], instructions: "z" }],
      remove_playbooks: ["Old"],
    },
    "**Scout**: renamed to Scout 2; model opus; default thinking; the pixel face back; its own working folder; unpinned; unarchived; turns on skills a; turns off skills b; turns on MCP servers github; turns off MCP servers files; no longer uses gmail; asks again before github/search; playbooks Recap; removes playbooks Old",
  ],
  [
    { type: "update_bot", bot: "Scout", contact_bots: "off", avatar: { new_face: true }, archived: true },
    "**Scout**: doesn't contact other bots; a different face; archived",
  ],
  [{ type: "update_bot", bot: "Scout", contact_bots: "ask" }, "**Scout**: asks before contacting other bots"],
  [{ type: "update_bot", bot: "Scout" }, "**Scout**: no changes"],
  [
    { type: "add_routine", bot: "Solo", name: "Ping", instructions: "x", schedule: { type: "webhook" } },
    '**Solo**: new routine "Ping", When its webhook is called',
  ],
  [
    { type: "add_routine", bot: "Solo", name: "Bad", instructions: "x", schedule: { type: "daily" } },
    '**Solo**: new routine "Bad", daily',
  ],
  [
    {
      type: "update_routine",
      bot: "Solo",
      routine: "Ping",
      name: "Pong",
      instructions: "x",
      schedule: { type: "interval", every_minutes: 120 },
      enabled: true,
    },
    '**Solo**: routine "Ping" renamed to "Pong"; new instructions; Every 2h; resumed',
  ],
  [
    { type: "update_routine", bot: "Solo", routine: "Ping", enabled: false },
    '**Solo**: routine "Ping" paused',
  ],
  [{ type: "update_routine", bot: "Solo", routine: "Ping" }, '**Solo**: routine "Ping" unchanged'],
  [{ type: "delete_routine", bot: "Solo", routine: "Ping" }, '**Solo**: delete routine "Ping"'],
  [{ type: "create_team", name: "Bare", instructions: "  " }, "**New team Bare**"],
  [
    { type: "create_team", name: "Studio", members: ["Mika"], instructions: "Ship." },
    "**New team Studio**: with Mika; shared instructions",
  ],
  [
    {
      type: "update_team",
      team: "Ops",
      name: "Core\nteam",
      lead: null,
      add_members: ["Solo"],
      remove_members: ["Scout"],
      instructions: "",
      logo: { new_logo: true },
    },
    "**Team Ops**: renamed to Core team; no Chief of Staff; adds Solo; removes Scout; new shared instructions; a new logo",
  ],
  [{ type: "update_team", team: "Ops", lead: "Solo" }, "**Team Ops**: led by Solo"],
  [{ type: "update_team", team: "Ops" }, "**Team Ops**: no changes"],
  [{ type: "delete_team", team: "Ops" }, "**Delete team Ops**; its bots stay, without a team"],
  [
    { type: "set_skill", skill: "weekly-report", enabled: true },
    "**Skill weekly-report**: on for every bot that uses it",
  ],
  [
    { type: "set_skill", skill: "weekly-report", enabled: false },
    "**Skill weekly-report**: off for every bot that uses it",
  ],
  [
    { type: "add_mcp_server", name: "docs", url: "https://docs.dev/mcp" },
    "**New MCP server docs**: connects to https://docs.dev/mcp; off until it passes a test in Skills & Tools",
  ],
  [
    { type: "add_mcp_server", name: "uv", command: "uvx" },
    "**New MCP server uv**: runs `uvx`; off until it passes a test in Skills & Tools",
  ],
  [{ type: "set_mcp_server", server: "github", enabled: true }, "**MCP server github**: on"],
  [{ type: "set_mcp_server", server: "github", enabled: false }, "**MCP server github**: off"],
  [
    { type: "remove_mcp_server", server: "github" },
    "**Remove MCP server github** from Skills & Tools and every bot",
  ],
  [
    {
      type: "set_defaults",
      provider: "codex",
      model: "gpt",
      mode: "auto",
      thinking: "high",
      contact_bots: "off",
    },
    "**New bots start with** provider codex; model gpt; approval mode auto; thinking high; contact other bots: off",
  ],
  [{ type: "set_defaults" }, "**New bots start with** the same defaults"],
  [{ type: "save_preset", bot: "Scout" }, "**Save Scout as a preset**"],
  [{ type: "delete_preset", preset: "Old" }, "**Delete preset Old**"],
];

const WARNED: [unknown, string[]][] = [
  [
    {
      type: "create_bot",
      name: "Juno",
      mode: "plan",
      contact_bots: "allow",
      apps: [{ app: "gmail" }],
      working_folder: "/w",
    },
    [
      'Juno runs in approval mode "plan".',
      "Juno may ask other bots without asking you.",
      "Juno may use gmail with your connected accounts.",
      "Juno works in /w.",
    ],
  ],
  [
    { type: "update_bot", bot: "Scout", contact_bots: "allow", allow_tools: [] },
    ["Scout may ask other bots without asking you."],
  ],
  [{ type: "add_mcp_server", name: "docs", url: "https://docs.dev/mcp" }, []],
  [{ type: "delete_team", team: "Ops" }, ["Deletes the team Ops."]],
  [{ type: "remove_mcp_server", server: "github" }, ["Removes the MCP server github."]],
  [{ type: "set_skill", skill: "weekly-report", enabled: true }, []],
];

describe("describing every kind of change", () => {
  it.each(DESCRIBED)("describes change %#", (change, text) => {
    expect(describeChange(ChangeSchema.parse(change))).toBe(text);
  });

  it.each(WARNED)("flags what change %# opens up", (change, warnings) => {
    expect(changeWarnings([ChangeSchema.parse(change)])).toEqual(warnings);
  });
});

const SKILL = { source: "", enabled: true, reviewedSha: "abc", createdAt: NOW, updatedAt: NOW };

function overviewValues(): BotState {
  const values = setup();
  const library = defined(values.library);
  const paused = {
    ...defined(rich().routines[0]),
    id: "r-2",
    name: "Paused",
    prompt: "Wait.",
    enabled: false,
  };
  const analyst = rich();
  return {
    ...values,
    bots: [
      ...values.bots,
      {
        ...analyst,
        archived: true,
        mcpServerIds: ["mcp-1", "mcp-gone"],
        appRules: { ...analyst.appRules, notion: { tools: ["search", "list"], account: null } },
        apps: [...analyst.apps, "notion"],
        routines: [...analyst.routines, paused],
      },
      makeBot({ id: "lone", name: "Lone", provider: "", routines: [paused] }),
    ],
    groups: [
      team({ memberIds: ["chief", "scout", "ghost"] }),
      team({ id: "t2", name: "Loose", leadId: null, memberIds: [], instructions: "Be nice." }),
    ],
    library: {
      skills: [...library.skills, { ...SKILL, id: "quiet", description: "", enabled: false }],
      mcpServers: [
        ...library.mcpServers,
        { ...TESTED_SERVER, enabled: true },
        { ...TESTED_SERVER, id: "m3", name: "spare", description: "" },
      ],
    },
    presets: [{ ...presetFromBot(analyst, NOW), name: "Starter" }],
  };
}

const OVERVIEW_LINES = [
  "- Rich (id rich): Analyst. claude · opus · mode plan; skills weekly-report; MCP servers github, mcp-gone; apps gmail, slack, notion; 2 routines; contact other bots: ask; archived.",
  "- Lone (id lone). no provider · default model; 1 routine; contact other bots: ask.",
  "- Ops (id t1): Chief of Staff Chief; members Scout, ghost.",
  "- Loose (id t2): Chief of Staff none; members none; has shared instructions.",
  "- weekly-report: Weekly report [on]",
  "- quiet: no description [off]",
  "- live: Live docs [on]",
  "- spare [off]",
  "Connected apps:\n- gmail: accounts work, ca_2\n- slack: accounts team",
  "New bots start with: provider any ready one, default model, contact other bots: ask.",
  "Presets: Starter.",
  "Providers: unknown right now.",
];

describe("setup overview and bot details", () => {
  it("summarizes bots, teams, the library, apps and presets", () => {
    const apps = [
      { id: "ca_1", slug: "gmail", names: ["work"] },
      { id: "ca_2", slug: "gmail", names: [] },
      { id: "ca_3", slug: "slack", names: ["team", "other"] },
    ];
    const text = setupOverview(overviewValues(), null, apps);
    for (const line of OVERVIEW_LINES) expect(text).toContain(line);
  });

  it("says none for an empty setup", () => {
    const text = setupOverview(
      { bots: [], history: [] },
      [{ id: "bare", models: [], modes: [], defaultModeId: null }],
      [],
    );
    expect(text.split("\n\n")).toEqual([
      "Bots (0):\n- none",
      "Teams (0):\n- none",
      "Library skills (0):\n- none",
      "Library MCP servers (0):\n- none",
      "Connected apps:\n- none",
      "New bots start with: provider any ready one, default model, contact other bots: ask.",
      "Presets: none.",
      "Providers:\n- bare: models none; modes none",
      expect.stringMatching(/^Roles for new bots: assistant \(General assistant\), /),
    ]);
  });

  it("details a bot's playbooks, routines, servers, grants, apps and folder", () => {
    const text = botDetails(overviewValues(), "Rich");
    for (const part of [
      "Blurb:\nReads reports.",
      "Instructions (Soul):\nBe brief.",
      "Playbooks:\n- Triage (triggers: triage, sort):\nSort it.",
      "Routines:\n- Digest (id r-1, Every 1h):\nSum up.\n\n- Paused (id r-2, paused):\nWait.",
      "MCP servers:\ngithub, mcp-gone",
      "Tools allowed without asking:\ngithub/search",
      "Connected apps:\ngmail, slack (tools: read; one account), notion (tools: search, list)",
      "Working folder:\n/work",
    ])
      expect(text).toContain(part);
    expect(botDetails(setup({ library: undefined }), "solo")).toContain(
      "Playbooks:\n(none)\n\nRoutines:\n(none)\n\nMCP servers:\n(none)\n\nTools allowed without asking:\n(none)\n\nConnected apps:\n(none)\n\nWorking folder:\nits own folder in the Bots project",
    );
  });
});
