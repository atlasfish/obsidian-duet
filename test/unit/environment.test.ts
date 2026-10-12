import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { harnessEnvironment } from '../../plugin/src/environment.ts';

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

