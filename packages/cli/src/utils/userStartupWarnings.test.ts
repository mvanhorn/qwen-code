/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';

const { canUseRipgrepMock, debugLogger } = vi.hoisted(() => ({
  canUseRipgrepMock: vi.fn(),
  debugLogger: {
    isEnabled: vi.fn().mockReturnValue(true),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@qwen-code/qwen-code-core/utils/ripgrepUtils.js', () => ({
  canUseRipgrep: canUseRipgrepMock,
}));

vi.mock('@qwen-code/qwen-code-core/utils/debugLogger.js', () => ({
  createDebugLogger: () => debugLogger,
}));

import { getUserStartupWarnings } from './userStartupWarnings.js';

const RIPGREP_COULD_NOT_RUN_WARNING =
  'Ripgrep could not run. Built-in grep is being used. Install system ripgrep to restore faster search.';
const RIPGREP_NOT_INSTALLED_WARNING =
  'Ripgrep not available: Please install ripgrep globally to enable faster file content search. Falling back to built-in grep.';

describe('getUserStartupWarnings', () => {
  let testRootDir: string;
  let startupOptions: {
    workspaceRoot: string;
    useRipgrep: boolean;
    useBuiltinRipgrep: boolean;
  };

  beforeEach(async () => {
    canUseRipgrepMock.mockReset();
    canUseRipgrepMock.mockResolvedValue(true);
    debugLogger.debug.mockClear();
    testRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'warnings-test-'));
    startupOptions = {
      workspaceRoot: testRootDir,
      useRipgrep: true,
      useBuiltinRipgrep: true,
    };
  });

  afterEach(async () => {
    await fs.rm(testRootDir, { recursive: true, force: true });
  });

  describe('root directory check', () => {
    it('should return a warning when running in a root directory', async () => {
      const rootDir = path.parse(testRootDir).root;
      const warnings = await getUserStartupWarnings({
        ...startupOptions,
        workspaceRoot: rootDir,
      });
      expect(warnings).toContainEqual(
        expect.stringContaining('root directory'),
      );
      expect(warnings).toContainEqual(
        expect.stringContaining('folder structure will be used'),
      );
    });

    it('should not return a warning when running in a non-root directory', async () => {
      const projectDir = path.join(testRootDir, 'project');
      await fs.mkdir(projectDir);
      const warnings = await getUserStartupWarnings({
        ...startupOptions,
        workspaceRoot: projectDir,
      });
      expect(warnings).not.toContainEqual(
        expect.stringContaining('root directory'),
      );
    });
  });

  describe('error handling', () => {
    it('should handle errors when checking directory', async () => {
      const nonExistentPath = path.join(testRootDir, 'non-existent');
      const warnings = await getUserStartupWarnings({
        ...startupOptions,
        workspaceRoot: nonExistentPath,
      });
      const expectedWarning =
        'Could not verify the current directory due to a file system error.';
      expect(warnings).toEqual([expectedWarning]);
    });
  });

  describe('ripgrep availability', () => {
    it('keeps a rejected probe as one concise warning and logs the original error', async () => {
      const binaryPath = '/opt/qwen/vendor/ripgrep/arm64-linux/rg';
      const probeError = new Error(
        [
          `Command failed: ${binaryPath} --version`,
          '<jemalloc>: Unsupported system page size',
          'memory allocation of 8 bytes failed',
        ].join('\n'),
      );
      canUseRipgrepMock.mockRejectedValue(probeError);

      const warnings = await getUserStartupWarnings(startupOptions);

      expect(warnings).toEqual([RIPGREP_COULD_NOT_RUN_WARNING]);
      expect(warnings[0]).not.toContain('\n');
      expect(warnings[0]).not.toContain(binaryPath);
      expect(warnings[0]).not.toContain('jemalloc');
      expect(warnings[0]).not.toContain('allocation');
      expect(warnings[0]).not.toContain('Command failed');
      expect(debugLogger.debug.mock.calls[0]?.[1]).toBe(probeError);
    });

    it('uses the same warning for an ordinary Error and a non-Error rejection', async () => {
      const ordinary = new Error('rg exited 127');
      canUseRipgrepMock.mockRejectedValueOnce(ordinary);
      const rejected = { reason: 'probe failed' };
      canUseRipgrepMock.mockRejectedValueOnce(rejected);

      const first = await getUserStartupWarnings(startupOptions);
      const second = await getUserStartupWarnings(startupOptions);

      expect(first).toEqual([RIPGREP_COULD_NOT_RUN_WARNING]);
      expect(second).toEqual([RIPGREP_COULD_NOT_RUN_WARNING]);
      expect(debugLogger.debug.mock.calls[0]?.[1]).toBe(ordinary);
      expect(debugLogger.debug.mock.calls[1]?.[1]).toBe(rejected);
    });

    it('keeps the installation guidance when ripgrep is unavailable', async () => {
      canUseRipgrepMock.mockResolvedValue(false);

      const warnings = await getUserStartupWarnings(startupOptions);

      expect(warnings).toEqual([RIPGREP_NOT_INSTALLED_WARNING]);
    });

    it('emits no ripgrep warning when the check succeeds, including a system fallback', async () => {
      canUseRipgrepMock.mockResolvedValue(true);

      const bundled = await getUserStartupWarnings({
        ...startupOptions,
        useBuiltinRipgrep: true,
      });
      const systemFallback = await getUserStartupWarnings({
        ...startupOptions,
        useBuiltinRipgrep: false,
      });

      expect(bundled.some((warning) => /ripgrep/i.test(warning))).toBe(false);
      expect(systemFallback.some((warning) => /ripgrep/i.test(warning))).toBe(
        false,
      );
    });

    it('skips the probe when search is disabled and forwards the builtin flag when it is enabled', async () => {
      canUseRipgrepMock.mockRejectedValue(new Error('should not run'));
      const disabled = await getUserStartupWarnings({
        ...startupOptions,
        useRipgrep: false,
      });
      expect(canUseRipgrepMock).not.toHaveBeenCalled();
      expect(disabled.some((warning) => /ripgrep/i.test(warning))).toBe(false);

      canUseRipgrepMock.mockResolvedValue(true);
      await getUserStartupWarnings({
        ...startupOptions,
        useRipgrep: true,
        useBuiltinRipgrep: true,
      });
      await getUserStartupWarnings({
        ...startupOptions,
        useRipgrep: true,
        useBuiltinRipgrep: false,
      });
      expect(canUseRipgrepMock.mock.calls).toEqual([[true], [false]]);
    });
  });
});
