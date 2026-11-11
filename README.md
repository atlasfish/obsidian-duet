# Duet

Work with Claude Code or Codex inside your Obsidian notes. You and the agent edit the same note at the same time: you see the agent's cursor and each change it makes, and your own typing is never lost.

![Claude cleans up a note after a mention, with its cursor visible](docs/images/mention-edit.gif)

## About

Coding agents such as Claude Code and Codex are good at more than code. They can read your notes, summarize them, restructure them, and write new ones. But they run in a terminal, and a terminal is a poor place to work with notes.

Duet puts these agents in the editor. Write `@claude` and a request on any line, and the agent answers under that line. It can also edit the note while you keep typing, like a second person in a shared document. For longer work, open a conversation note: the conversation becomes a note in your vault, with every message and tool call recorded. You can also comment on a passage and let an agent act on the comment, and see at a glance which text an agent wrote.

Duet uses your own Claude Code or Codex installation and login. It needs no API key of its own.

## Configurable inline tools in this fork

Codex note mentions and passage-comment requests use a profile-specific optional tool policy. In **Settings → Duet**, select your Codex agent and enable **Configure inline tools**. With the switch off, Yami supplies its standard agent behavior. Claude and conversation notes use their profile settings.

| Setting | Behavior |
|---|---|
| Inline web search | Enables Codex's native live web search. The model and provider must support it. |
| Inline Shell | Exposes `duet.run_command` in note mentions and passage-comment requests. |
| Inline Shell approvals | **Ask** prompts for every command; **YOLO** executes without approval prompts. |
| Inline MCP tools | One exact `server/tool` per line. Empty means no MCP tools. |

For example, if your Codex `config.toml` defines an MCP server named `my-server` with tools named `read_logs` and `get_status`, enter:

```text
my-server/read_logs
my-server/get_status
```

Server names are the keys under `[mcp_servers]`; tool names are the original MCP tool names, without Codex's `mcp__` prefix. Wildcards are not supported. Existing Codex `enabled_tools` and `disabled_tools` restrictions still apply. Unknown or disabled servers cause an error. Only servers declared in the effective Codex configuration are eligible; plugin-provided tools and app connectors are disabled for these controlled mentions.

Shell commands run in the vault directory with **Obsidian's OS permissions**, outside Codex's sandbox. They can use the network and modify accessible files. Commands inherit the agent profile's environment variables and run through `cmd.exe` on Windows or `/bin/sh` elsewhere. Each command has a 60-second default timeout (up to 300 seconds), captures up to 64 KiB of output, and is terminated with its child processes when cancelled or timed out. Ask displays the exact command before execution; YOLO skips that prompt. Select **YOLO** to use SSH or other command-line tools without approving each invocation.

Yami supplies read-only native filesystem permissions. Codex native command and plugin entry points are disabled by the profile policy; Duet supplies host Shell access through its command tool. Note edits use Duet's shared-document tools with live editing and undo. Shell and MCP file writes use their own filesystem operations.

Different inline tool policies use separate stored conversations. Changing settings leaves existing replies in the note. An in-progress turn keeps its original policy; wait for it to finish before sending a request with the new policy. Returning to an earlier policy resumes its matching conversation.

The search toggle does not modify the model catalog. If your provider omits native search (for example, a Responses Lite model configuration), use a compatible model catalog in the Codex home selected by your agent's `CODEX_HOME` environment variable.

The runtime uses Yami's public agent and session interfaces. The fork requirements and module boundaries are described in [SPEC.md](SPEC.md).

## Quickstart

### Prerequisites

- Obsidian 1.13 or later, on desktop. Duet is tested on macOS.
- Claude Code (`claude`) or the Codex CLI (`codex`), installed and logged in. Check this in a terminal with `claude --version` or `codex --version`.

### Install

1. In Obsidian, open **Settings → Community plugins** and turn off restricted mode.
2. Select **Browse**, search for **Duet**, then select **Install** and **Enable**.

To install by hand, download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/nathanaday/obsidian-duet/releases/latest). Put them in `<your vault>/.obsidian/plugins/duet/`, then turn on **Duet** under **Settings → Community plugins**.

### Ask Your First Question

1. Open a note with some text in it.
2. On a new line, write `@claude Summarize this note in one sentence`.
3. Press Enter.

The answer streams into a callout under the line. For Codex, write `@codex` instead.

## Usage

### Mentions

Write `@claude` or `@codex` and a request, then press Enter at the end of the line. The tag can follow other text on the line. When you type the tag of an agent, it turns into a pill in the agent's color, so you know the tag will work. Tags in code, in blockquotes and callouts, and in email addresses stay plain text.

![A mention answers in a callout under the line](docs/images/mention-reply.png)

- **Edit the note:** ask for a change, such as `@claude make the list shorter`. Duet note tools edit this note while Yami supplies read-only native filesystem access. A Codex profile with inline tools enabled can also use the configured search, MCP tools and host Shell; Ask mode prompts for each host command.
- **Follow up:** each note keeps its own conversation. A later `@claude make it shorter` in the same note continues it, also after you restart Obsidian.
- **Use a skill:** `@claude/<skill>` runs the request with one of your skills (see [Skills and Agents in Your Vault](#skills-and-agents-in-your-vault)).
- **Undo the agent:** run **Duet: Undo the agent's last changes in this note**. This removes the edits of the agent's last turn and keeps your own typing and the agent's reply. Cmd+Z or Ctrl+Z undoes only your own typing.
- **Stop:** run **Duet: Stop the agent in this note**. While a mention agent works, the status bar says so, for example `claude working in Ideas`; select it to open the note.
- **Start over:** run **Duet: Forget the mention conversation in this note**.

### Optional request styling

Copy [`docs/snippets/duet-requests.css`](docs/snippets/duet-requests.css) to your vault's `.obsidian/snippets/` folder and enable **duet-requests** under **Settings → Appearance → CSS snippets**. It styles editor lines containing a configured agent tag with smaller muted text, a subtle background, and a rounded border. The agent pill keeps its own color. This does not change the Markdown or mention trigger.

In Reading view, this snippet styles paragraphs containing an agent tag. Keep each request in its own paragraph, with a blank line before and after it. Tight list items without a paragraph wrapper are not covered by the Reading view rule; Live Preview still styles their request line.

### Conversation Notes

Run **Duet: New conversation with claude** (or the command of another agent), or select the ribbon button, which starts one with your first agent. You get a note with a message box at the bottom. The note records the conversation: your messages, the agent's replies, and its tool calls in collapsed sections. It takes its name from your first message.

![A conversation note with the message box](docs/images/conversation.png)

- **Send:** press Enter; Shift+Enter starts a new line. A message that you send while the agent works waits for the current turn to end.
- **Link notes:** type `[[` to pick a note. The agent reads linked notes when it needs them.
- **Commands:** type `/` to see commands. `/model`, `/effort`, `/mode`, `/new` and `/end` belong to Duet; the others come from the agent, for example your Claude Code skills.
- **Model, effort and approvals:** use the buttons under the message box. Your choice is saved in the note's properties. A new model or effort applies from the next turn. A new approval mode applies at once, also to a request that waits for you.
- **Stop:** press Escape in the message box, or select the stop button.
- **End:** type `/end`, or run **Duet: End this conversation**. The note stays as a record. Select **Continue it** to reopen the conversation.

In a conversation, the agent can change any file in the vault. Before it changes a file or runs a command, the request shows above the message box with the exact change. Press `Y` to allow it once, `A` to allow it for the rest of the conversation, or `N` to deny it.

![Claude asks before it changes a file](docs/images/approval.png)

The approval mode decides which actions ask first:

| Agent | Mode | Behavior |
|---|---|---|
| Claude Code | Ask first | Asks before edits and commands. |
| Claude Code | Accept edits | Edits files in the vault without asking; asks before commands. |
| Claude Code | Auto | Lets Claude Code decide which actions are safe to run without asking. |
| Claude Code | Plan only | Reads and plans, and changes nothing. |
| Codex | Ask first | Asks before every command. |
| Codex | Sandbox | Asks only for actions outside Codex's sandbox. |

When Claude has questions for you, they show above the message box, one at a time. Pick an option with a click or its number key, or write your own answer and press Enter. Select **Back** to change an answer, or **Skip** to answer nothing. The note records the questions and your answers.

When the agent changes a note that is open, you see its cursor in that note, and its changes merge with the text you type at the same time.

![Claude edits the open reading list while the conversation continues](docs/images/conversation-edit.png)

### Comments

Comment on a passage of a note, as in Google Docs or Word, and tag an agent to have it act on the comment.

1. Select text in a note, then choose **Add comment** in the editor's menu, or run **Duet: Add a comment on the selection**.
2. The passage gets a highlight, and the **Comments** view opens in the right sidebar with the new thread. Write your comment and press Enter.

Each thread shows its passage, its comments, and a reply box. Select the passage to show it in the note, or select a highlight in the note to open its thread. From a comment's menu you can edit your own comments or remove any comment; the trash button removes a thread with its highlight. **Duet: Open the comments of this note** opens the view.

- **Ask an agent:** write `@claude` in a comment, for example `@claude shorten this`. The agent gets the note, the passage and the thread, and its reply streams into the thread. It is asked to change only the highlighted passage, and can read the whole note for context.
- **Handle every comment:** run **Duet: Let Claude handle the comments in this note** (or the command of another agent). The agent gets every thread whose last comment is yours, in one turn, and replies in each thread.
- **See what an agent changed:** when a Duet agent changes a highlighted passage, the highlight takes the agent's color. Your own highlights use the **Comment color** setting.

Highlights show in the editor only, not in Reading view. Duet keeps the comments in the hidden folder `.duet/comments/`, one file for each note that has comments. Highlights follow your edits, including edits made while Obsidian was closed: Duet compares the note with the text it saw last.

### Skills and Agents in Your Vault

Turn on **Use the skills and agents in this vault** in the settings. Every `SKILL.md` and `AGENT.md` in a named folder of your vault then becomes a skill or an agent of Duet's agents, named after its folder: `Writing/Summarize/SKILL.md` gives the skill `summarize`. Files under `internal/` and in the conversation folder do not count. The settings list what Duet found, and what it could not use and why.

- **In a conversation note:** type `/` and pick `/vault:summarize`, as you pick any other skill of the agent.
- **In a mention:** write `@claude/summarize make this shorter`. While you type `@claude/`, Obsidian suggests the skills and agents with their descriptions. Your own installed skills work the same way: `~/.claude/skills` and `~/.claude/agents` when the agent has **Load my MCP servers and plugins** on, and `~/.codex/skills` for Codex.
- **Agents:** an `AGENT.md` has a `description` in its front matter, and its text is the agent's prompt. `tools` and `model` are passed on, and `access: read-only` gives it reading tools only. It runs as a subagent of Claude Code: `@claude/skeptic check this plan` hands the request to it, and in a conversation Claude Code picks it when its description fits.

Duet copies the skill folders into the hidden folder `.duet/skills/vault/` and keeps the copy current as you edit. Claude Code uses the vault's skills in mentions and conversation notes. Codex uses them in mentions only; Codex conversation notes do not see them yet. Vault agents work with Claude Code only.

### Contribution Lens

Duet records which text of a note its agents wrote. To see it, select the lens button in the ribbon, or run **Duet: Toggle contribution lens**. Text that a Duet agent wrote gets a cyan mark; hold the pointer over a mark to see which agent wrote it and when.

![The lens marks the words that Claude changed in the note, and its reply](docs/images/lens.png)

- **What counts:** all text that a Duet agent writes: its edits, its mention replies, and its parts of a conversation note. When an agent changes part of a word, the whole word counts as the agent's.
- **Your changes win:** when you or any other program changes a word that an agent wrote, the word loses its mark. Duet also follows changes made while it was not running, for example through sync.
- **Only Duet's agents:** the lens is not an AI detector. Text that another tool wrote, or that you pasted, stays plain, even when an AI wrote it.
- **Limits:** a Codex edit can go unrecorded when Codex does not ask for approval first, and a file that an agent changes with a shell command is not recorded. In Live Preview, a rendered block such as a callout or a table gets a bar on its left edge instead of marks; in Reading view, whole sections get the bar.

Duet keeps the record in the hidden folder `.duet/contributions/`, one file for each note that an agent wrote in.

## Settings

Duet starts with two agents, `claude` and `codex`. You can change them or add more, for example a second Claude account. Each agent has these settings:

| Setting | What it does |
|---|---|
| Tag | The name you write after `@`. |
| Color | The color of the agent's cursor and highlights. |
| Agent | Claude Code or Codex. |
| Approvals | When the agent asks before it acts, in conversation notes. |
| Model | The model to use. Leave empty for the default. |
| Effort | How much the model reasons. Leave empty for the default. |
| Program path | Leave empty to find the program on your shell's PATH. |
| Environment variables | One `KEY=VALUE` per line. |
| Load my MCP servers and plugins | Claude Code only. Off by default. |

General settings:

| Setting | What it does |
|---|---|
| Conversation folder | Where new conversation notes go. The default is `conversations`. |
| Show agents typing | Agents type their edits into open notes. When off, edits appear at once. Duet also turns this off when your system asks for reduced motion. |
| Comment color | The highlight of the passages you commented on. |
| Close idle agents after | Minutes without activity before an agent process stops (default 15). The next message continues the same conversation. |
| Use the skills and agents in this vault | Turns every `SKILL.md` and `AGENT.md` in a named folder into a skill or an agent. Off by default. |

To use a second Claude account, add an agent with the tag `work`, the agent Claude Code, and the environment variable `CLAUDE_CONFIG_DIR=~/.claude-work`. For a second Codex account, set `CODEX_HOME` instead.

Changes apply at once, with no restart. A new agent's tag works in mentions right away, and **Duet: New conversation with work** appears in the command palette. A changed agent starts with its new options at the next message; an agent that is working finishes its turn first.

## Network Use, Accounts and Privacy

Duet itself does not connect to the internet. It starts Claude Code or Codex on your computer, and those programs connect to their providers.

- **Network use:** Claude Code sends your requests, and the note text that it reads, to Anthropic. Codex sends them to OpenAI. The language models run on the providers' servers.
- **Accounts and payment:** Duet is free. Claude Code and Codex each need an account with their provider, and their use can cost money under that account's plan.
- **Files in the vault:** Duet keeps its data in the hidden folder `.duet/`: the contribution record in `contributions/` (positions of the agents' text and a copy of the note's text, used to follow changes Duet did not see), comments in `comments/`, and, when you use the vault's skills, their copy in `skills/`.
- **Files outside the vault:** Duet runs `claude` or `codex`, and your login shell once after Obsidian starts, to read its PATH. Claude Code and Codex save their conversation history in their own folders, such as `~/.claude` and `~/.codex`. The agents work in the vault folder; their own permission rules control access to other files, and Duet shows you each approval request they send.
- **Your environment:** to find and start Claude Code and Codex, Duet reads your environment variables and your home folder, and passes your environment to the agent programs, as a terminal does. Duet sends this information nowhere.
- **Telemetry:** Duet collects no data. Claude Code and Codex follow the privacy policies of Anthropic and OpenAI.

## What Duet Adds to Your Vault

Duet runs on [Yami](https://github.com/nathanaday/yami), a library that other plugins such as [Yami Wiki](https://github.com/nathanaday/yami-wiki) and [Yami Threads](https://github.com/nathanaday/yami-threads) also use. Besides `.duet/`, it adds:

- **The base skill of Yami's sessions,** at `internal/yami/skills/run/SKILL.md`. Duet runs no sessions; the file serves Yami plugins that do. Yami never overwrites the file once you edit it.
- **A status bar item** that shows which agents are working, in mentions and in conversation notes.
- **`plugin: duet` in the properties of conversation notes,** so Yami Wiki or Yami Threads in the same vault leave Duet's notes alone, and Duet leaves theirs. A note from Duet before 0.5.0 has no `plugin` and goes to whichever Yami plugin loaded first; add `plugin: duet` to such a note to keep it with Duet.

### Upgrading From Versions Before 0.5.0

Earlier versions of Duet also installed Yami's wiki and threads modules. These now belong to Yami Wiki and Yami Threads. The folders they wrote stay in your vault; delete `internal/wiki/` and `internal/threads/` if you do not install those plugins.

Duet 0.5.0 takes its conversation commands from Yami, so their ids changed. If you gave one a hotkey, set it again:

| Command | Before 0.5.0 | Now |
|---|---|---|
| New conversation with `<tag>` | `duet:new-chat`, `duet:new-chat-<tag>` | `duet:yami-new-conversation-<tag>` |
| End this conversation | `duet:end-chat` | `duet:yami-end-conversation` |
| Stop the agent in this note | `duet:stop` | `duet:yami-stop` |
| Undo the agent's last changes in this note | `duet:revert` | `duet:yami-revert` |
| Focus the message box | `duet:focus-composer` | `duet:yami-focus-composer` |
| Forget the mention conversation in this note | `duet:new-conversation` | `duet:forget-mentions` |

## API for Other Plugins

Another Obsidian plugin can start a Duet conversation and follow it, instead of running its own agents. [`plugin/src/api.ts`](plugin/src/api.ts) declares `DuetApi`. Its option and result types (`NewConversationOptions`, `ConversationStatus`, `TurnEnd`) come from `yami/obsidian`: install Yami from its [release tarball](https://github.com/nathanaday/yami/releases), as Duet does, or copy the declarations from `dist/obsidian/api.d.ts` in that package.

```ts
import type { DuetApi } from './duet-api'; // your copy of plugin/src/api.ts

const duet = (this.app as any).plugins.getPlugin('duet')?.api as DuetApi | undefined;
if (duet && duet.version >= 2) {
  const { path } = await duet.newConversation({ message: '/my-plugin:my-skill' });
  const stop = duet.onTurnEnd(path, (turn) => console.log(turn.status));
}
```

| Member | What it does |
|---|---|
| `version` | `2`. Version 2 renamed the `newConversation` option `profile` to `agent`. A later version only adds members. |
| `newConversation(options)` | Creates a conversation note, opens it in a new tab, and sends `options.message` as the first message. Resolves with `{ path }` when the message is sent. |
| `conversationStatus(path)` | `working`, `active` (waits for a message), `ended`, or `none` (no conversation note has this path). |
| `onTurnEnd(path, callback)` | Calls `callback` with `{ path, status, text?, error? }` after each turn. `text` is the agent's final message; `status` is `completed`, `interrupted` or `failed`. Returns a function that stops the calls. |

Options of `newConversation`:

| Option | Default | What it does |
|---|---|---|
| `message` | (required) | The first message. A `/` command runs an agent command, such as a Claude Code skill. |
| `agent` | the first agent | The tag of a Duet agent, with or without `@`. |
| `module` | none | The module session document that the conversation runs, as a vault path. |
| `title` | the date and the first words of the message | The name of the note. |
| `folder` | the conversation folder setting | The folder of the note. |
| `open` | `true` | `false` creates the note without opening it. |

Behavior to plan for:

- `api` is undefined when Duet is not installed or is turned off, so get it each time you need it. After Duet turns off, `newConversation` on an old `api` rejects.
- `newConversation` rejects when the message is empty or when no agent has the tag in `agent`. A call that still passes `profile` (version 1) is refused with an error that names `agent`.
- When the agent cannot start, Duet shows a notice, and the turn ends with the status `failed`.
- The agent asks for approval and asks its questions as in other conversations: in the message box when the note is open, otherwise in a dialog.
- A listener follows its note when the user renames it, and `conversationStatus` takes the current path.

## Development

```sh
npm install
npm run plugin:dev   # creates dev-vault/ and rebuilds the plugin into it on every change
```

Open `dev-vault/` as a vault in Obsidian. Other commands:

| Command | What it does |
|---|---|
| `npm run plugin:build` | Builds the plugin into `plugin/dist`. |
| `npm run typecheck` | Type-checks the plugin, the tests and the scripts. |
| `npm run lint` | Runs Obsidian's review rules on the plugin code and fails on any warning. |
| `npm test` | Runs the unit tests. |
| `npm run test:obsidian` | Starts a separate Obsidian with a temporary vault and tests mentions and conversations with Claude Code and Codex. Your own Obsidian and vaults are not touched. |
| `npm run screenshots` | Captures the images in this README with real agent sessions. |
| `npm run set-version <x.y.z>` | Sets the release version in every file that holds it. |

### How Duet Uses Yami

Duet keeps only what is its own: mentions, agent profiles and settings, comments, the vault's skills and agents, the contribution record and lens, and the API. Yami's `createYami` gives it the shared documents, conversation notes and their commands, approval prompts, and the status bar, and `yami/esbuild` gives the bundle options and stylesheet. Duet turns off Yami's built-in wiki and threads modules, which belong to Yami Wiki and Yami Threads. `package.json` installs Yami from the `.tgz` of a Yami GitHub release, so `npm install` needs no checkout of Yami; a Duet change that needs a newer Yami waits for that Yami release. The design notes are in [docs/design.md](docs/design.md).

### Branches and Releases

Work happens on the `preview` branch. `main` takes changes only through a pull request from `preview` whose checks pass; CI runs the type check, the lint, the unit tests and the build. To release a version:

1. On `preview`, run `npm run set-version <x.y.z>`. It sets the version in `manifest.json`, `package.json` and `package-lock.json`, and adds it to `versions.json` with the current `minAppVersion`. A unit test holds the four files to one version.
2. Open a pull request from `preview` into `main`. Run `npm run test:obsidian` before you merge, because CI has no Obsidian to run it in.
3. Merge it. The release workflow checks the code again, tags the commit with the version (no `v`), and publishes `main.js`, `manifest.json` and `styles.css` with build provenance. A merge whose version is already released publishes nothing.

Obsidian reads `manifest.json` from `main`, so until the release job finishes, `main` names a version with no release, and an install in that window fails once. The checks and releases shared by every Yami repository are in [docs/releasing.md](https://github.com/nathanaday/yami/blob/main/docs/releasing.md) of the Yami repository.

## Related Plugins

- [Yami Wiki](https://github.com/nathanaday/yami-wiki)
- [Yami Threads](https://github.com/nathanaday/yami-threads)
- [Yami Wiki for Claude Code and Codex](https://github.com/nathanaday/yami-wiki-agent-plugin)

## License

[MIT](LICENSE)
