# Open items

The feature list of Duet, broken into steps. A step is checked when its code, its tests, and its README text are in.

## Reviewer comments

Comments on highlighted text, as in Google Docs and Word. A comment that tags an agent runs the agent on the passage.

- [x] **Store.** One file for each note at `.duet/comments/<note>.json`: the threads, each with its range in the note, its comments (author, text, time), and the agent that last changed the passage. The ranges follow edits as the contribution ledger's spans do: exactly while the note is shared, and by comparing texts otherwise.
- [x] **Add a comment.** The editor menu while text is selected, and a command, start a thread on the selection. The passage gets a highlight in the comment color of the settings.
- [x] **Comments view.** A view in the right sidebar lists the threads of the open note. Reply, edit your comment, remove a comment, remove a thread. A click on a highlight opens its thread; a click on a thread's passage selects it in the note.
- [x] **An agent in a comment.** A comment that tags an agent, such as `@claude`, runs the agent in the note's mention session with the note, the passage, and the thread. The reply streams into the thread. The agent is told to keep its changes to the passage.
- [x] **The agent's color.** When a Duet agent changes a highlighted passage, the highlight takes the agent's color.
- [x] **Handle every comment.** One command for each agent, `Let <agent> handle the comments in this note`, sends every thread that waits for an answer in one turn. The agent answers each thread with a tool.
- [x] **Settings.** The comment color.
- [x] README, design notes, unit tests.
- [ ] Highlights in Reading view, as the lens marks sections.
- [ ] An end-to-end test in Obsidian (`test/obsidian`), which needs a real agent.

## Skills and agents in the vault

With a setting on, every `SKILL.md` and `AGENT.md` in a named folder of the vault is a skill or an agent of Duet's agents.

- [x] **Setting.** `Use the skills and agents in this vault`, off by default. The settings tab lists what Duet recognized and what it could not use.
- [x] **Recognition.** Scan the vault for `<folder>/SKILL.md` and `<folder>/AGENT.md`, outside `internal/` (Yami's modules have those) and outside the conversation folder. The folder's name is the skill's or the agent's name. Follow the vault's file events, so a new skill works at once.
- [x] **Skills reach the agents.** Duet mirrors the skill folders into one skill set, `.duet/skills/vault/`, which Claude Code loads as a plugin of every session, in mentions and in conversation notes, and Codex gets in mention sessions. Codex conversation notes need a Yami option for a host's skill sets; until then, the README says so.
- [x] **Agents reach Claude Code.** Each `AGENT.md` becomes a subagent of every Claude Code session (`agents` of the Agent SDK): the front matter gives the description, tools, and model, and the body is its prompt.
- [x] **Slash commands.** The `/` menu of a conversation note lists the vault's skills as `/vault:<name>`, as it lists the other skills of the agent.
- [x] **Inline.** `@claude/<skill> request` runs the mention with that skill, and `@claude/<agent> request` sends the request to that subagent. The tag pill shows the suffix. The names of the user's own installed skills and agents (`~/.claude/skills`, `~/.claude/agents`, `~/.codex/skills`) work too.
- [x] **Suggestions.** While the user types `@claude/`, Obsidian suggests the skills and agents, with their descriptions.
- [x] README, design notes, unit tests.
- [ ] Vault skills in Codex conversation notes. Yami has the option on its branch `claude/bold-ramanujan-9jh037`: `createYami({ skills })` and `yami.refreshSkills()`. Once that Yami is released and Duet takes it, pass `() => [set root]` there, call `refreshSkills` from `vaultSkillsChanged`, and drop the plugin in `sdkOptions` and the `skills` of mention sessions, which the option covers.
- [ ] Vault agents for Codex, when Yami's Codex adapter offers subagents.
- [ ] An end-to-end test in Obsidian with a skill folder in the test vault.
