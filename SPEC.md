# Duet fork specification

Duet runs Claude Code and Codex inside Obsidian notes through Yami. The upstream baseline is Duet 0.6.0 with Yami 0.20.0. Upstream owns mentions, conversation notes, passage comments, vault skills and agents, collaboration, and the public plugin API.

## Configurable Codex mention tools

Each Codex profile has an optional tool policy for note mentions and agents invoked from passage comments. The policy selects live web search, exact configured MCP server/tool names, and the host command tool `duet.run_command`. Disabled policies use the upstream agent behavior. Conversation notes and Claude Code use upstream tool policies.

The Codex integration extends Yami's public agent/session interfaces. It reads the effective Codex configuration for the vault and profile environment through the CLI configuration API, supplies the selected MCP tools and disabled plugin/native command entry points as session configuration, and preserves the user's server restrictions. Native Codex sessions retain Yami's read-only filesystem permissions. Duet note tools apply note edits through the shared document.

`duet.run_command` runs with Obsidian's operating-system permissions, the vault working directory, and the profile environment. Ask mode requests approval for each invocation through Yami. YOLO mode executes without a prompt. Cancellation and timeout stop the command process tree; output is bounded to 64 KiB and timeout defaults to 60 seconds with a configurable maximum of 300 seconds.

Tool policies keep separate stored mention-session IDs. The same policy resumes its own session across process restarts. Yami manages session lifetime, note renames, agent activity, and shutdown. Note and comment request paths use the same policy selection.

## Host environment

Harnesses and host commands inherit the operating-system environment and profile overrides. On Windows the environment builder emits one canonical `PATH` key and preserves the inherited `Path` value and explicit profile path overrides. Yami supplies executable discovery and login-shell path resolution.

## Request presentation

The optional `docs/snippets/duet-requests.css` snippet styles mention request lines with smaller muted text, a background and a rounded border. It uses Duet's mention-tag classes and remains separate from plugin behavior.

## Integration boundaries

The plugin exposes upstream API version 2. Conversation creation selects an agent with the `agent` option. Passage comments reside in `.duet/comments/`; inline callouts remain Markdown in their notes. ObShare's callout exporter handles inline callouts; exporting passage-comment files is a separate integration.

Development checks include type checking, lint, unit tests and plugin bundling. An isolated CLI integration test uses a local model endpoint and local MCP fixtures to exercise tool declarations, host commands and resumed sessions without the user's model account.
