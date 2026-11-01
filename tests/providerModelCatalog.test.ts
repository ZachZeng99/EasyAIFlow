import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { findProviderModel, normalizeProviderModels, modelOptionsWithCurrent, modelEffortOptions } from '../src/data/providerModels.ts';
import { buildClaudePrintArgs } from '../electron/claudePrintArgs.ts';
import { ProviderModelCatalogStore, queryRuntimeModels } from '../backend/providerModelCatalog.ts';
import { CodexAppServerClient } from '../backend/codexAppServer.ts';
import { syncModelSelectionForSession } from '../src/data/modelSelection.ts';
import { normalizeClaudeModelSelection, resolveClaudeSessionModelArg } from '../electron/claudeModel.ts';

const run = async (name: string, test: () => unknown | Promise<unknown>) => { await test(); console.log(`PASS ${name}`); };
await run('Claude catalog preserves resolved model IDs and merges default aliases', () => {
  const models = normalizeProviderModels('claude', [
    { value: 'default', resolvedModel: 'claude-new-model-99', displayName: 'Default', supportedEffortLevels: ['low', 'high'] },
    { value: 'new', resolvedModel: 'claude-new-model-99', displayName: 'New model' },
    { value: 'custom-100', displayName: 'Custom model' },
  ]);
  assert.equal(models.length, 2);
  assert.equal(models[0].id, 'claude-new-model-99');
  assert.equal(models[0].isDefault, true);
  assert.deepEqual(models[0].aliases, ['default', 'new']);
  assert.deepEqual(models[0].supportedEfforts, ['low', 'high']);
  assert.equal(normalizeClaudeModelSelection('claude-sonnet-99'), 'claude-sonnet-99');
  assert.equal(resolveClaudeSessionModelArg(undefined, 'claude-sonnet-99'), 'claude-sonnet-99');
});
await run('reasoning controls use declared levels and can leave the choice to the provider', () => {
  assert.deepEqual(modelEffortOptions({ id: 'new', label: 'New', supportedEfforts: ['low', 'max', 'ultra'] }), ['default', 'low', 'max', 'ultra']);
  assert.deepEqual(modelEffortOptions({ id: 'unknown', label: 'Unknown' }), ['default']);
  assert.deepEqual(modelEffortOptions({ id: 'future', label: 'Future', supportedEfforts: ['future-effort'] }), ['default', 'future-effort']);
  assert.equal(buildClaudePrintArgs({ effort: 'default' }).includes('--effort'), false);
});
await run('Codex catalog accepts unknown IDs and only uses declared capabilities', () => {
  const models = normalizeProviderModels('codex', [
    { id: 'model-row', model: 'gpt-future', displayName: 'Future', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
    { id: 'hidden-model', hidden: true },
  ]);
  assert.deepEqual(models.map((model) => model.id), ['gpt-future']);
  assert.deepEqual(models[0].supportedEfforts, ['high']);
  assert.equal(models[0].contextWindow, undefined);
  assert.equal(syncModelSelectionForSession('gpt-future', 'explicit', 'gpt-old', 'codex', ['gpt-future']).model, 'gpt-future');
  assert.deepEqual(modelOptionsWithCurrent(models, ['gpt-old']).map((option) => option.value), ['gpt-old', 'gpt-future']);
});
await run('Runtime aliases select their catalog entry instead of duplicating it', () => {
  const models = normalizeProviderModels('claude', [
    { value: 'default', resolvedModel: 'claude-opus-9[1m]', displayName: 'Opus (1M context)', contextWindow: 1000000 },
    { value: 'opus[1m]', resolvedModel: 'claude-opus-9[1m]', displayName: 'Opus (1M context)' },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-9', displayName: 'Sonnet' },
  ]);
  assert.equal(findProviderModel(models, 'opus[1m]')?.id, 'claude-opus-9[1m]');
  assert.equal(findProviderModel(models, 'opus[1m]')?.contextWindow, 1000000);
  assert.deepEqual(modelOptionsWithCurrent(models, ['opus[1m]', 'opus[1m]']).map((option) => option.value), ['opus[1m]', 'claude-sonnet-9']);
  const ids = models.flatMap((model) => [model.id, ...(model.aliases ?? [])]);
  assert.equal(syncModelSelectionForSession('opus[1m]', 'explicit', 'sonnet', 'claude', ids).model, 'opus[1m]');
});
await run('Unavailable explicit models fall back to the runtime recommendation', () => {
  assert.deepEqual(syncModelSelectionForSession('gpt-retired', 'explicit', '', 'codex', ['gpt-next'], 'gpt-next'), { model: 'gpt-next', source: 'implicit' });
});

await mkdir('.tmp-tests', { recursive: true });
const directory = await mkdtemp(path.resolve('.tmp-tests', 'model-catalog-'));
let scope = 'account-A';
let version = 'v1';
let now = 10000;
let calls = 0;
let unavailable = false;
const options = {
  scope: async () => scope,
  version: async () => version,
  now: () => now,
  load: async () => { calls += 1; if (unavailable) throw new Error('offline'); return [{ id: `model-${calls}`, label: 'Discovered', isDefault: true }]; },
};
let store = new ProviderModelCatalogStore(directory, options);
await run('catalog cache refreshes on expiry and CLI version changes', async () => {
  const first = await store.get('codex', directory);
  assert.equal(first.models[0].id, 'model-1');
  await store.get('codex', directory);
  assert.equal(calls, 1);
  now += 16 * 60 * 1000;
  assert.equal((await store.get('codex', directory)).models[0].id, 'model-2');
  version = 'v2';
  assert.equal((await store.get('codex', directory)).models[0].id, 'model-3');
});
await run('offline restart retains the last catalog but never leaks another account cache', async () => {
  store = new ProviderModelCatalogStore(directory, options);
  unavailable = true;
  const cached = await store.get('codex', directory, true);
  assert.equal(cached.models[0].id, 'model-3');
  assert.equal(cached.stale, true);
  assert.equal(cached.error, 'offline');
  scope = 'account-B';
  assert.deepEqual((await store.get('codex', directory, true)).models, []);
});

await run('missing workspaces reject discovery without unhandled child-process errors', async () => {
  const missing = path.join(directory, 'does-not-exist');
  await assert.rejects(queryRuntimeModels('claude', missing));
  await assert.rejects(CodexAppServerClient.create(missing, { timeoutMs: 1000 }));
});

await run('catalog provenance survives disk cache fallback and is supplied by the queried runtime', async () => {
  const provenanceDirectory = path.join(directory, 'provenance');
  const runtime = { runtimePath: 'C:/Codex App/codex.exe', runtimeVersion: 'codex-cli 99.0.0', runtimeSource: 'desktop' as const };
  let offline = false;
  const options = { scope: async () => 'runtime-scope', version: async () => 'older-probe', load: async () => {
    if (offline) throw new Error('offline');
    return { models: [{ id: 'future-model', label: 'Future' }], ...runtime };
  } };
  const fresh = await new ProviderModelCatalogStore(provenanceDirectory, options).get('codex', directory, true);
  assert.equal(fresh.runtimeVersion, runtime.runtimeVersion);
  assert.equal(fresh.runtimePath, runtime.runtimePath);
  offline = true;
  const cached = await new ProviderModelCatalogStore(provenanceDirectory, options).get('codex', directory, true);
  assert.equal(cached.stale, true);
  assert.equal(cached.runtimeSource, 'desktop');
  assert.equal(cached.runtimeVersion, runtime.runtimeVersion);
});
