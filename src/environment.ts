import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const MARKER = '__OBSIDIAN_DUET_PATH__';
const COMMON_DIRS = ['.local/bin', '.npm-global/bin', '.bun/bin', '.volta/bin'].map((dir) =>
  path.join(homedir(), dir),
);
const SYSTEM_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

let shellPath: Promise<string | undefined> | undefined;

/**
 * Returns PATH as the user's login shell sets it.
 * A macOS app started from the Dock or Finder, such as Obsidian, gets only the system PATH.
 * The harness binaries and Node usually live in directories that the shell profile adds.
 */
export function loginShellPath(): Promise<string | undefined> {
  if (process.platform === 'win32') return Promise.resolve(undefined);
  shellPath ??= new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh';
    execFile(
      shell,
      ['-ilc', `printf '${MARKER}%s${MARKER}' "$PATH"`],
      { timeout: 10_000, env: process.env },
      (_error, stdout) => {
        const match = stdout?.match(new RegExp(`${MARKER}(.*)${MARKER}`));
        resolve(match?.[1] || undefined);
      },
    );
  });
  return shellPath;
}

/** Builds the environment for a harness process: the inherited environment, a full PATH, and the caller's variables. */
export async function harnessEnvironment(
  extra: Record<string, string> = {},
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Windows environment keys are case-insensitive, but this plain object is not.
    if (value !== undefined) env[process.platform === 'win32' && key.toLowerCase() === 'path' ? 'PATH' : key] = value;
  }
  const dirs = [
    ...(env.PATH ?? '').split(path.delimiter),
    ...((await loginShellPath()) ?? '').split(path.delimiter),
    ...COMMON_DIRS,
    ...SYSTEM_DIRS,
  ];
  env.PATH = [...new Set(dirs.filter(Boolean))].join(path.delimiter);
  for (const [key, value] of Object.entries(extra)) {
    env[process.platform === 'win32' && key.toLowerCase() === 'path' ? 'PATH' : key] = value;
  }
  return env;
}

/** Returns a function that shows a path relative to `cwd` when the path is inside it. */
export function pathDisplay(cwd: string): (file: string) => string {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    // Keep the path as given.
  }
  return (file) => {
    for (const root of [cwd, real]) {
      const relative = path.relative(root, file);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
    }
    return file;
  };
}

/** Finds an executable on the PATH of `env`. Throws with an install hint when it is missing. */
export async function findExecutable(name: string, env: Record<string, string>): Promise<string> {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Try the next candidate.
      }
    }
  }
  throw new Error(
    `Could not find the '${name}' executable. Install it, or set executablePath to its full path.`,
  );
}
