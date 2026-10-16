import assert from 'node:assert/strict';
import { CodexRuntimeResolver, compareCodexVersions, codexRuntimeSpawnSpec, type CodexRuntime, type CodexRuntimeCandidate } from '../backend/codexRuntime.ts';
import { CodexAppServerManager, type CodexAppServerClient } from '../backend/codexAppServer.ts';

const run = async (name: string, test: () => unknown | Promise<unknown>) => { await test(); console.log(`PASS ${name}`); };
const candidate = (filename: string, source: CodexRuntimeCandidate['source'] = 'path'): CodexRuntimeCandidate => ({ path: filename, command: filename, prefixArgs: [], source });
const npm = candidate('npm/codex.js');
const desktop = candidate('desktop/codex.exe', 'desktop');

await run('runtime selection prefers the newer installed CLI over an earlier PATH shim', async () => {
  const resolver = new CodexRuntimeResolver({ discover: async () => [npm, desktop], probe: async (entry) => entry === npm ? 'codex-cli 0.144.6' : 'codex-cli 0.162.0-alpha.17.2', now: () => 1 });
  assert.equal((await resolver.resolve()).path, desktop.path);
  assert.ok(compareCodexVersions('codex-cli 0.162.0', 'codex-cli 0.162.0-alpha.17.2') > 0);
  assert.ok(compareCodexVersions('codex-cli 0.162.0-alpha.17.2', 'codex-cli 0.162.0-alpha.9.4') > 0);
  assert.equal(compareCodexVersions('codex-cli 1.0.0+build.1', 'codex-cli 1.0.0'), 0);
});

await run('new installations are detected automatically and force refresh bypasses the resolver cache', async () => {
  let now = 1;
  let installed = [npm];
  let probes = 0;
  const resolver = new CodexRuntimeResolver({ discover: async () => installed, probe: async (entry) => { probes++; return entry === npm ? 'codex-cli 0.144.6' : 'codex-cli 0.162.0'; }, now: () => now });
  assert.equal((await resolver.resolve()).path, npm.path);
  installed = [npm, desktop];
  await resolver.resolve();
  assert.equal(probes, 1);
  assert.equal((await resolver.resolve(true)).path, desktop.path);
  installed = [candidate('desktop/new/codex.exe', 'desktop')];
  now += 31000;
  assert.equal((await resolver.resolve()).path, installed[0].path);
});

await run('broken installations are skipped but an explicit override never silently falls back', async () => {
  const resolver = new CodexRuntimeResolver({ discover: async () => [npm, desktop], probe: async (entry) => { if (entry === desktop) throw new Error('incompatible executable'); return 'codex-cli 0.144.6'; }, now: () => 1 });
  assert.equal((await resolver.resolve()).path, npm.path);
  const explicit = new CodexRuntimeResolver({ discover: async () => [candidate('custom/codex.exe', 'override')], probe: async () => { throw new Error('invalid override'); }, now: () => 1 });
  await assert.rejects(explicit.resolve(), /invalid override/);
});

await run('executable paths and prompts remain separate arguments, including npm entrypoints', () => {
  const runtime: CodexRuntime = { ...npm, command: 'C:/Program Files/nodejs/node.exe', prefixArgs: ['C:/User Name/npm/codex.js'], version: 'codex-cli 1.0.0', identity: 'npm' };
  const prompt = 'spaces & pipes | "quotes" %PATH%';
  assert.deepEqual(codexRuntimeSpawnSpec(runtime, ['exec', prompt]), { command: runtime.command, args: [...runtime.prefixArgs, 'exec', prompt], shell: false });
});

await run('runtime upgrades do not close a process still referenced by an existing session', async () => {
  let runtime: CodexRuntime = { ...npm, version: 'codex-cli 0.144.6', identity: 'old' };
  const closed: string[] = [];
  const manager = new CodexAppServerManager(async () => runtime, async (_cwd, selected) => ({ runtime: selected, close: async () => { closed.push(selected.identity); } }) as unknown as CodexAppServerClient);
  const old = await manager.acquire('workspace');
  runtime = { ...desktop, version: 'codex-cli 0.162.0', identity: 'new' };
  const fresh = await manager.acquire('workspace');
  assert.notEqual(old, fresh);
  assert.deepEqual(closed, []);
  assert.equal(await manager.acquire('workspace'), fresh);
  manager.release('workspace', old);
  assert.deepEqual(closed, ['old']);
  manager.release('workspace', fresh);
  assert.deepEqual(closed, ['old']);
  manager.release('workspace', fresh);
  assert.deepEqual(closed, ['old', 'new']);
});
