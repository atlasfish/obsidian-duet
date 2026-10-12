import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { harnessEnvironment, pathDisplay } from '../../src/environment.ts';

describe('Windows harness environment', () => {
  it('preserves an inherited mixed-case Path as a single PATH variable', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32', env: { Path: 'parent-bin', DUET_TEST_ENV: 'inherited' } });
    try {
      const env = await harnessEnvironment();
      expect(env.PATH?.split(path.delimiter)).toContain('parent-bin');
      expect(env.DUET_TEST_ENV).toBe('inherited');
      expect(Object.keys(env).filter((key) => key.toLowerCase() === 'path')).toEqual(['PATH']);
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(['Path', 'PATH'])('honors the profile override %s without duplicate path keys', async (key) => {
    vi.stubGlobal('process', { ...process, platform: 'win32', env: { Path: 'parent-bin' } });
    try {
      const env = await harnessEnvironment({ [key]: 'profile-bin' });
      expect(env.PATH).toBe('profile-bin');
      expect(Object.keys(env).filter((name) => name.toLowerCase() === 'path')).toEqual(['PATH']);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('pathDisplay', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'duet-paths-'));
  const show = pathDisplay(cwd);

  it('shows paths inside the working directory relative to it', () => {
    expect(show(path.join(cwd, 'Notes', 'a.md'))).toBe(path.join('Notes', 'a.md'));
  });

  it('matches the resolved directory, as harnesses often report it', () => {
    expect(show(path.join(realpathSync(cwd), 'a.md'))).toBe('a.md');
  });

  it('keeps paths outside the working directory and the directory itself', () => {
    expect(show('/etc/hosts')).toBe('/etc/hosts');
    expect(show(path.join(cwd, '..', 'other.md'))).toBe(path.join(cwd, '..', 'other.md'));
    expect(show(cwd)).toBe(cwd);
  });
});
