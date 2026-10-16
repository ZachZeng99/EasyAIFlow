import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ProviderModelCatalog } from '../src/data/providerModels.ts';
import type { ProjectCreateResult, SessionCreateResult, SessionRecord } from '../src/data/types.ts';

const { DeviceServiceClient } = process.argv.includes('--compiled')
  ? await import('../dist-server/backend/deviceServiceClient.js')
  : await import('../backend/deviceServiceClient.ts');

await mkdir('.tmp-tests', { recursive: true });
const root = await mkdtemp(path.resolve('.tmp-tests', 'live-team-'));
const dataDirectory = path.join(root, 'data'); const workspace = path.join(root, 'workspace');
await Promise.all([dataDirectory, workspace].map((directory) => mkdir(directory)));
await writeFile(path.join(dataDirectory, 'easyaiflow-sessions.json'), JSON.stringify({ projects: [], deletedImports: { claudeSessionIds: [], codexThreadIds: [] } }));
process.env.EASYAIFLOW_PROTOCOL_CAPTURE_DIR = path.join(root, 'protocol');
const client = new DeviceServiceClient({ dataDirectory, homeDirectory: os.homedir() });
let roomId = '';
console.log(`Team smoke artifacts: ${root}`);
try {
  const project = await client.request<ProjectCreateResult>('createProject', { name: 'Team communication smoke', rootPath: workspace });
  const created = await client.request<SessionCreateResult>('createSessionInStreamwork', { streamworkId: project.session.dreamId, name: 'Agent communication', sessionKind: 'group' });
  roomId = created.session.id;
  assert.equal(created.session.group?.kind, 'room');
  if (created.session.group?.kind !== 'room') throw new Error('Expected group');
  const catalogs = await Promise.all((['claude', 'codex'] as const).map((provider) => client.request<ProviderModelCatalog>('getProviderModels', { provider, cwd: workspace })));
  const members = created.session.group.participants.map((member) => ({ ...member,
    model: member.provider === 'claude' ? catalogs[0].models.find((model) => model.aliases?.includes('sonnet'))?.id : catalogs[1].models.find((model) => model.isDefault)?.id,
    effort: 'low', instructions: 'For this integration test, use only the EAF team MCP tools when asked to delegate. Do not use shell, file, external-network or native subagent tools. A delegated task only needs the requested marker reply.',
  }));
  await client.request('updateGroupParticipants', { sessionId: roomId, expectedRevision: created.session.group.configurationRevision ?? 0, participants: members, collaborationEnabled: true });
  for (const sender of ['claude', 'codex']) {
    const recipient = sender === 'claude' ? 'codex' : 'claude';
    const before = await client.request<SessionRecord>('getSessionRecord', { sessionId: roomId });
    const queued = await client.request<{ queued: { assistantMessageId: string } }>('sendMessage', { sessionId: roomId, targetParticipantIds: [sender], prompt:
      `Integration test: use the eaf_team MCP tool team_send to delegate to member ${recipient}. Set request_id to "roundtrip-${sender}" and message to "Do not use tools. Reply exactly TEAM_CHILD_${sender.toUpperCase()}_OK." Then use team_wait with the returned delivery_id until you receive the actual reply. Finally reply exactly "TEAM_PARENT_${sender.toUpperCase()}_OK" followed by the actual child marker. Do not use native subagents, shell, file or external-network tools. If EAF tools fail, report the exact failure instead of inventing a reply.` });
    const deadline = Date.now() + 180000;
    while (true) {
      const room = await client.request<SessionRecord>('getSessionRecord', { sessionId: roomId });
      const reply = room.messages.find((message) => message.id === queued.queued.assistantMessageId);
      if (reply?.status === 'error') throw new Error(reply.content);
      if (reply?.status === 'complete') {
        assert.match(reply.content.trim(), new RegExp(`^TEAM_PARENT_${sender.toUpperCase()}_OK\\s+TEAM_CHILD_${sender.toUpperCase()}_OK$`));
        const deliveries = room.messages.filter((message) => !before.messages.some((old) => old.id === message.id) && message.role === 'user' && message.speakerId === sender);
        assert.equal(deliveries.length, 1, 'A single actual team delivery must exist');
        assert.equal(deliveries[0].teamDelivery?.recipientId, recipient);
        assert.ok(room.messages.some((message) => message.speakerId === recipient && message.role === 'assistant' && message.content.includes(`TEAM_CHILD_${sender.toUpperCase()}_OK`)));
        console.log(`PASS real ${sender} -> ${recipient} -> ${sender}: tool delivery and actual reply round trip`);
        break;
      }
      assert.ok(Date.now() < deadline, `${sender} team round trip timed out`);
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }
} finally {
  if (roomId) { await client.request('stopSessionRun', { sessionId: roomId }).catch(() => undefined); await client.request('disconnectSession', { sessionId: roomId }).catch(() => undefined); }
  await client.request('shutdownDeviceService').catch((error) => console.error(error.message)); client.close();
}
