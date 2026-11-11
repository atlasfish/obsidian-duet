import { harnessEnv } from 'yami/agent';

function canonicalEnvironment(values: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) env[process.platform === 'win32' && key.toLowerCase() === 'path' ? 'PATH' : key] = value;
  }
  return env;
}

/** Gives Yami the inherited Windows Path under its expected PATH spelling. */
export function harnessOverrides(extra: Record<string, string> = {}): Record<string, string> {
  return { ...canonicalEnvironment(process.env), ...canonicalEnvironment(extra) };
}

/** The environment used by harnesses and Duet's host command tool. */
export async function harnessEnvironment(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const env = canonicalEnvironment(await harnessEnv(harnessOverrides(extra)));
  const path = canonicalEnvironment(extra).PATH;
  if (path !== undefined) env.PATH = path;
  return env;
}
