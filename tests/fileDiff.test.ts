import assert from 'node:assert/strict';
import { getFileDiff, resolveDiffTarget } from '../electron/fileDiff.ts';

const run = async (name: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('resolveDiffTarget prefers the file repo for absolute paths outside the active workspace', async () => {
  const resolutions = new Map<string, string>([
    ['X:\\PBZ\\ProjectPBZ', 'X:\\PBZ\\ProjectPBZ'],
    ['X:\\UnrealEngine\\Engine\\Source\\Runtime\\Core\\Public\\ProfilingDebugging', 'X:\\UnrealEngine'],
  ]);

  const target = await resolveDiffTarget(
    'X:\\PBZ\\ProjectPBZ',
    'X:\\UnrealEngine\\Engine\\Source\\Runtime\\Core\\Public\\ProfilingDebugging\\DiagnosticTable.h',
    async (candidatePath) => resolutions.get(candidatePath) ?? null,
  );

  assert.equal(target.gitCwd, 'X:\\UnrealEngine');
  assert.equal(target.gitPath, 'Engine\\Source\\Runtime\\Core\\Public\\ProfilingDebugging\\DiagnosticTable.h');
});

run('resolveDiffTarget returns no git target for absolute files outside any known repo', async () => {
  const target = await resolveDiffTarget(
    'X:\\PBZ\\ProjectPBZ',
    'X:\\External\\Scratch\\notes.txt',
    async () => null,
  );

  assert.equal(target.gitCwd, undefined);
  assert.equal(target.gitPath, undefined);
});

run('getFileDiff retries a transient read failure before giving up on preview content', async () => {
  let readAttempts = 0;

  const payload = await getFileDiff(
    'X:\\PBZ\\ProjectPBZ',
    'X:\\PBZ\\ProjectPBZ\\PS5_MemoryOptimization_AssetChanges.md',
    async () => {
      throw new Error('git unavailable');
    },
    async () => {
      readAttempts += 1;
      if (readAttempts === 1) {
        const error = new Error('file busy') as Error & { code?: string };
        error.code = 'EPERM';
        throw error;
      }
      return '# Asset changes';
    },
  );

  assert.equal(readAttempts, 2);
  assert.equal(payload.kind, 'preview');
  assert.equal(payload.content, '# Asset changes');
});
