# paseo-bots

paseo-bots adds personal bots to Paseo. A bot is an agent with its own name, avatar, instructions, model, approval mode and memory. You chat with a bot in its workspace, and routines run a bot without you.

## What it does

- **Bots** keep a `MEMORY.md` file and a log of their chats. A new chat starts with what the bot remembers.
- **Routines** send a bot a prompt on a schedule, once, or when a local webhook URL receives a request.
- **Teams** group bots under a Chief of Staff, who hands parts of a request to its teammates.
- **Skills & Tools** is one library of skills and MCP servers. You turn each item on for the bots that need it.
- **Connected apps** link bots to Gmail, Slack, Notion and other apps through your own Composio account.
- **Setup by chat**: a bot can propose new bots, teams, routines and library items. Nothing changes until you press **Apply changes** on its card.

## What it can reach

paseo-bots runs on your Paseo host. It makes network requests in these cases:

- **Composio** (`backend.composio.dev`): when you add a Composio API key and use connected apps. The key stays on the host. Bots reach Composio through a relay on `127.0.0.1` that allows each bot its own apps, tools and accounts.
- **GitHub** (`api.github.com`, `raw.githubusercontent.com`): when you import skills from a GitHub repository. A skill import from a `SKILL.md` link fetches that link.
- **npm, through `npx`**: when an MCP server you add runs with `npx`, Paseo starts it, and `npx` downloads the package from the npm registry. The built-in Browser server runs `npx chrome-devtools-mcp`.
- **MCP servers you add**: the plugin connects to their URLs to test them and list their tools. The bots you give them to use those tools.
- **OpenAI** (`api.openai.com`): when you generate an avatar with your own OpenAI key.
- **Google's favicon service**: to show icons for connected apps.
- **Image links**: avatar and team logo pictures load from the links you enter.

The plugin listens on `127.0.0.1` in these cases. Each request needs a token or secret that the plugin holds.

- **Relay**: the MCP tools and connected apps of each bot chat, with a token per chat.
- **Routine webhooks**: on the relay's port, with a secret per routine.
- **External control** (port 6898, or a free port when that one is taken): only while **Settings > Bots > External control (MCP)** is on. MCP clients start `plugin-data/paseo-bots/bin/paseo-bots-mcp`, which reads the token in `plugin-data/paseo-bots/control-token`. Chats get no token for it.

## The Browser server

The built-in Browser MCP server controls a Chromium browser you use, such as Chrome, Brave or Edge. A bot with it acts as you on every site where that browser is signed in, and a web page can try to steer it. The server is off for every bot. Importing a bot or team file does not turn it on. You turn it on for one bot at a time, after you start the browser with a remote debugging port.

## Your data

Bots, teams and the library live in `plugin-data/paseo-bots/state.json` under your Paseo home folder, next to memory, skills and routine history. A bot or team file you export holds the bot's setup and, if you choose, its memory. An imported bot starts on its provider's default approval mode, with no always-allowed tools, MCP servers or apps. Its routines start paused. The file's skills and MCP servers wait in the library, switched off, until you review them.
