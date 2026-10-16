import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DeviceServiceClient } from '../backend/deviceServiceClient.ts';
import type { SessionCreateResult, SessionRecord, ProjectCreateResult } from '../src/data/types.ts';
import type { ProviderModelCatalog } from '../src/data/providerModels.ts';

await mkdir('.tmp-tests', { recursive: true });
const root = await mkdtemp(path.resolve('.tmp-tests', 'live-native-agents-'));
const workspace = path.join(root, 'workspace');
const dataDirectory = path.join(root, 'data');
await Promise.all([workspace, dataDirectory].map((directory) => mkdir(directory)));
await writeFile(path.join(dataDirectory, 'easyaiflow-sessions.json'), JSON.stringify({ projects: [], deletedImports: { claudeSessionIds: [], codexThreadIds: [] } }));
process.env.EASYAIFLOW_PROTOCOL_CAPTURE_DIR = path.join(root, 'protocol');
const options = { dataDirectory, homeDirectory: os.homedir() };
let client = new DeviceServiceClient(options);
const sessions: string[] = [];
const background = process.argv.includes('--background-codex');
let sawBackground = false;
client.onEvent((event) => { if (event.type === 'status' && event.status === 'background') sawBackground = true; });
console.log(`Native agent artifacts: ${root}`);
try {
  const project = await client.request<ProjectCreateResult>('createProject', { name: 'Native agent smoke', rootPath: workspace });
  for (const provider of ['claude', 'codex'] as const) {
    if (background && provider !== 'codex') continue;
    const catalog = await client.request<ProviderModelCatalog>('getProviderModels', { provider, cwd: workspace });
    const model = provider === 'claude' ? catalog.models.find((entry) => entry.aliases?.includes('sonnet'))?.id : catalog.models.find((entry) => entry.isDefault)?.id;
    assert.ok(model);
    const created = await client.request<SessionCreateResult>('createSessionInStreamwork', { streamworkId: project.session.dreamId, name: `${provider} native agents`, provider });
    sessions.push(created.session.id);
    const submitted = await client.request<{ queued: { assistantMessageId: string } }>('sendMessage', {
      sessionId: created.session.id, model, effort: 'low',
      prompt: background
        ? 'Integration test: launch exactly one native subagent. Tell it to run a single harmless shell command using Node.js that waits 8 seconds, then reply exactly CHILD_NATIVE_OK. No file edits, network calls or further agents. You must NOT wait for the child: immediately after launching it reply exactly ROOT_NATIVE_OK. This tests that the host preserves a child after its parent final answer.'
        : 'Integration test: launch exactly one native subagent. Its only job is to reply CHILD_NATIVE_OK. Instruct it not to use tools or spawn other agents. Wait for it, then reply exactly ROOT_NATIVE_OK. Do not run shell commands, edit files or use other tools.',
    });
    const deadline = Date.now() + 120000;
    let verified = false;
    while (Date.now() < deadline) {
      const record = await client.request<SessionRecord>('getSessionRecord', { sessionId: created.session.id });
      const reply = record.messages.find((message) => message.id === submitted.queued.assistantMessageId);
      if (reply?.status === 'error') throw new Error(`${provider}: ${reply.content}`);
      if (reply?.status === 'complete') {
        assert.equal(reply.content.trim(), 'ROOT_NATIVE_OK');
        const agents = record.messages.filter((message) => message.nativeAgent);
        assert.equal(agents.length, 1);
        assert.equal(agents[0].nativeAgent?.status, 'completed');
        assert.match(agents[0].content, /CHILD_NATIVE_OK/);
        assert.equal(agents[0].nativeAgent?.rootAssistantMessageId, reply.id);
        verified = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    assert.ok(verified, `${provider}: native agent round trip timed out`);
    if (background) assert.equal(sawBackground, true, 'Parent never entered background while its child remained active');
    await client.request('disconnectSession', { sessionId: created.session.id });
    console.log(`PASS ${provider}: real native child output and completed state are separate from the root answer`);
  }
  await client.request('shutdownDeviceService');
  client.close();
  client = new DeviceServiceClient(options);
  for (const sessionId of sessions) {
    const record = await client.request<SessionRecord>('getSessionRecord', { sessionId });
    const agents = record.messages.filter((message) => message.nativeAgent);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].nativeAgent?.status, 'completed');
    assert.match(agents[0].content, /CHILD_NATIVE_OK/);
  }
  console.log('PASS native agent identity, output and status survive a device service restart');
} finally {
  for (const sessionId of sessions) {
    await client.request('stopSessionRun', { sessionId }).catch(() => undefined);
    await client.request('disconnectSession', { sessionId }).catch(() => undefined);
  }
  await client.request('shutdownDeviceService').catch((error) => console.error(`Native smoke cleanup: ${error.message}`));
  client.close();
}
