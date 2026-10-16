// Explicit integration probe: consumes a small real Claude/Codex turn in an
// isolated EAF data directory. Existing EAF projects and sessions are not loaded.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DeviceServiceClient } from '../backend/deviceServiceClient.ts';
import type { ProviderModelCatalog } from '../src/data/providerModels.ts';
import type { ProjectCreateResult, SessionCreateResult, SessionRecord } from '../src/data/types.ts';

await mkdir('.tmp-tests', { recursive: true });
const root = await mkdtemp(path.resolve('.tmp-tests', 'live-providers-'));
const workspace = path.join(root, 'workspace');
const homeDirectory = os.homedir();
await mkdir(workspace);
const options = { dataDirectory: path.join(root, 'data'), homeDirectory };
await mkdir(options.dataDirectory);
await writeFile(path.join(options.dataDirectory, 'easyaiflow-sessions.json'), JSON.stringify({ projects: [], deletedImports: { claudeSessionIds: [], codexThreadIds: [] } }));
console.log(`Smoke artifacts: ${root}`);
let client = new DeviceServiceClient(options);
const sessions: string[] = [];
try {
  const claudeCatalog = await client.request<ProviderModelCatalog>('getProviderModels', { provider: 'claude', cwd: workspace, force: true });
  const codexCatalog = await client.request<ProviderModelCatalog>('getProviderModels', { provider: 'codex', cwd: workspace, force: true });
  const claudeModel = claudeCatalog.models.find((model) => model.aliases?.includes('sonnet'))?.id;
  const codexModel = codexCatalog.models.find((model) => model.isDefault)?.id;
  assert.ok(claudeModel && codexModel, 'Both providers must expose usable runtime model catalogs');
  const project = await client.request<ProjectCreateResult>('createProject', { rootPath: workspace, name: 'EAF v2 smoke' });
  const originalStatus = await client.request<{ instanceId: string }>('getDeviceStatus');
  for (const provider of ['claude', 'codex'] as const) {
    const created = await client.request<SessionCreateResult>('createSessionInStreamwork', {
      streamworkId: project.session.dreamId, name: `P0 ${provider} smoke`, provider,
    });
    sessions.push(created.session.id);
    const request = { sessionId: created.session.id,
      prompt: 'This is an EasyAIFlow integration smoke test. Do not run tools or edit files. Reply with exactly EAF_SYNC_OK.',
      model: provider === 'codex' ? codexModel : claudeModel, effort: 'default',
    };
    const queued = await client.request<{ queued: { assistantMessageId: string } }>('sendMessage', request, `smoke-${provider}`);
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    client = new DeviceServiceClient(options);
    const status = await client.request<{ instanceId: string }>('getDeviceStatus');
    assert.equal(status.instanceId, originalStatus.instanceId);
    const deadline = Date.now() + 90000;
    let completed = false;
    while (Date.now() < deadline) {
      const record = await client.request<SessionRecord>('getSessionRecord', { sessionId: created.session.id });
      const reply = record.messages.find((item) => item.id === queued.queued.assistantMessageId);
      if (reply?.status === 'error') throw new Error(`${provider}: ${reply.content}`);
      if (reply?.status === 'complete') {
        assert.match(reply.content, /EAF_SYNC_OK/);
        assert.equal(record.messageRevision, record.historyPage?.sessionRevision);
        completed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.ok(completed, `${provider} did not finish within 90 seconds`);
    const retry = await client.request<{ queued: { assistantMessageId: string } }>('sendMessage', request, `smoke-${provider}`);
    assert.equal(retry.queued.assistantMessageId, queued.queued.assistantMessageId);
    await client.request('disconnectSession', { sessionId: created.session.id });
    console.log(`PASS real ${provider} (${request.model}) reply survives client close/reopen and duplicate submission`);
  }
  console.log(`Smoke artifacts: ${root}`);
} finally {
  for (const sessionId of sessions) {
    await client.request('stopSessionRun', { sessionId }).catch(() => undefined);
    await client.request('disconnectSession', { sessionId }).catch(() => undefined);
  }
  await client.request('shutdownDeviceService').catch((error) => console.error('Smoke service shutdown:', error.message));
  client.close();
}
