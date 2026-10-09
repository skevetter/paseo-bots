<p align="center">
  <img src="https://raw.githubusercontent.com/skevetter/paseo-bots/main/docs/bots.svg" width="512" alt="Six pixel-art bots">
</p>

# paseo-bots

paseo-bots is a [Paseo](https://paseo.sh) plugin for personal bots. You chat with a bot in its workspace, or a routine runs it on a schedule or from a webhook.

This repository is a fork of [oliexe/paseo-bots](https://github.com/oliexe/paseo-bots).

## Features

- **Bots**: instructions, a model, an approval mode, an avatar and a `MEMORY.md`. A bot can propose setup changes on a card you apply.
- **Routines**: a prompt that runs on a schedule, once, or when its webhook gets a `POST`.
- **Teams**: a Chief of Staff hands parts of your requests to its teammates.
- **Skills & Tools**: one library of skills and MCP servers, turned on per bot.
- **Connected apps**: 1,000+ apps through your own [Composio](https://composio.dev) account. A local relay holds the API key and keeps each bot to its apps, tools and accounts.

## Install

```bash
paseo plugin install git:skevetter/paseo-bots --ref v0.4.0
```

The plugin needs Paseo 0.11.0 or later. The install has no npm step. [Releases](https://github.com/skevetter/paseo-bots/releases) lists each version.

## Usage

1. Open **Bots** in Paseo's sidebar and press **New bot**.
2. Start blank, from a role, from a preset, or from a bot or team file under **Import**.
3. Chat with the bot. The panel button at the top right of a chat opens its settings.
4. Press **Skills & Tools** below the bot list to add skills, MCP servers and apps. Give them to a bot under its **Skills** and **Access** settings.

An imported bot or team file brings its instructions, model, skills, routines and playbooks. The bot starts on its provider's default approval mode, with no always-allowed tools, MCP servers or apps. Its routines start paused. The file's skills and MCP servers wait in the library, switched off, until you review them.

## The Browser preset and its risk

The library has a built-in **Browser** MCP server. It runs [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) against a Chromium browser you use, such as Chrome, Brave or Edge.

A bot with this server acts as you on every site where that browser is signed in. It can read your mail, send messages and buy things. A web page can carry text that steers the bot to do something you did not ask for.

The preset is off for every bot. Importing a bot or team file does not turn it on. To use it:

1. Start the browser with `--remote-debugging-port=9222`. While that port is open, any program on your computer can control the browser.
2. Set **Browser address** if you use another port.
3. Press **Test and turn on**, and give the server to one bot under **Access**.

A separate browser profile without your main accounts limits the damage.

## What this fork changes

Compared with oliexe/paseo-bots 0.2.0, this fork:

- targets the Paseo 0.11 plugin SDK, with its own screen and sidebar items;
- shows proposal and sign-in cards for ACP providers such as Hermes and omp;
- adds the Browser preset;
- writes state files through a temporary file and sets an unreadable file aside;
- checks each relay token before it reads a request, and bounds request sizes;
- keeps routine history through corrupt files, missed runs and failing routines;
- shows loading and error states for apps, server tests and runs;
- labels icon buttons for screen readers;
- lints with Biome and releases from this repository with semantic-release.

## Development

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run bench
```

Paseo supplies React 19.1, React Native 0.81 and React Query 5.90 at runtime. Use no newer React Query API.
