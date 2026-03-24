import assert from 'node:assert/strict';
import { resolveDiffTarget } from '../electron/fileDiff.ts';

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
