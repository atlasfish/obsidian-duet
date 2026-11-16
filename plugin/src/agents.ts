import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { App } from 'obsidian';
import type { Agent, SessionStart } from 'yami/agent';
import { ClaudeAgent } from 'yami/agent/claude';
import { CodexAgent, type CodexAgentOptions, type CodexPreferences } from 'yami/agent/codex';
import { type ConversationAgent, vaultRoot } from 'yami/obsidian';
import { type AgentProfile, parseEnv } from './settings.ts';
import { inlinePolicy } from './inline-tools.ts';
import { startInlineCodexSession } from './inline-codex.ts';
import type { InlineToolPolicy } from './inline-policy.ts';
import { harnessOverrides } from './environment.ts';

/** Conversation notes use CodexAgent; Duet note tools select the mention policy. */
class DuetCodexAgent extends CodexAgent {
  constructor(private readonly hostOptions: CodexAgentOptions, private readonly policy: InlineToolPolicy) { super(hostOptions); }

  protected override createSession(options: CodexPreferences & SessionStart<CodexPreferences>) {
    if (options.tools?.name !== 'duet' || options.access !== 'read-only') return super.createSession(options);
    return startInlineCodexSession({ ...this.sessionOptions(options), executablePath: this.hostOptions.executable, env: this.hostOptions.env }, this.policy);
  }
}

/** What the vault adds to a profile's agent: Agent SDK options for Claude Code, and a key that names their state. */
export interface AgentExtras {
  key: string;
  sdkOptions?: Partial<Options>;
}

/**
 * The Yami agents of the profiles in the settings. A profile keeps its agent until one of its options, other
 * than its tag and color, changes, or the extras of the vault change.
 */
export class ProfileAgents {
  private readonly agents = new Map<string, { key: string; agent: Agent }>();

  constructor(
    private readonly app: App,
    private readonly profiles: () => AgentProfile[],
    private readonly extras: (profile: AgentProfile) => AgentExtras = () => ({ key: '' }),
  ) {}

  /** The agents for `createYami` and `setAgents`, named by their tags. */
  entries(): ConversationAgent[] {
    const profiles = this.profiles();
    for (const name of this.agents.keys()) if (!profiles.some((profile) => profile.name === name)) this.agents.delete(name);
    return profiles.map((profile) => ({ name: profile.name, color: profile.color, agent: this.agent(profile) }));
  }

  /** A new agent for a changed profile, so Yami closes the idle sessions of the old one and the next message starts the new one. */
  private agent(profile: AgentProfile): Agent {
    const { name: _name, color: _color, ...options } = profile;
    const extras = this.extras(profile);
    const key = `${JSON.stringify(options)}\n${extras.key}`;
    const known = this.agents.get(profile.name);
    if (known?.key === key) return known.agent;
    const agent = this.build(profile, extras);
    this.agents.set(profile.name, { key, agent });
    return agent;
  }

  private build(profile: AgentProfile, extras: AgentExtras): Agent {
    const preferences = { cwd: vaultRoot(this.app), model: profile.model || undefined, effort: profile.effort || undefined, approval: profile.approval };
    const options = { executable: profile.executablePath || undefined, env: harnessOverrides(parseEnv(profile.env)), preferences };
    if (profile.harness === 'codex') {
      const policy = inlinePolicy(profile);
      return policy ? new DuetCodexAgent(options, policy) : new CodexAgent(options);
    }
    // Without the user's settings, Claude Code loads no MCP servers or plugins of the user's own.
    return new ClaudeAgent({
      ...options,
      settingSources: profile.userTools ? ['user', 'project', 'local'] : ['project', 'local'],
      ...(extras.sdkOptions && { sdkOptions: extras.sdkOptions }),
    });
  }
}
