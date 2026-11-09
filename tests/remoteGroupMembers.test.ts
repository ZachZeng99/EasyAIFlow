import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DeviceServiceClient } from '../backend/deviceServiceClient.ts';
import type { DeviceDescriptor, DevicePairingCode, GroupPlacementOptions } from '../src/data/devices.ts';
import type { ProviderModelCatalog } from '../src/data/providerModels.ts';
import type { GroupParticipantConfig, ProjectCreateResult, SessionCreateResult, SessionRecord } from '../src/data/types.ts';

// Two isolated device services on one host stand in for two machines: the
// controller owns the group room; the executor owns the remote member session.
const live = process.argv.includes('--live');
await mkdir('.tmp-tests', { recursive: true });
const root = await mkdtemp(path.resolve('.tmp-tests', 'remote-group-'));
const peers = await Promise.all(['controller', 'executor'].map(async (name) => {
  const directory = path.join(root, name);
  const dataDirectory = path.join(directory, 'data');
  const homeDirectory = live ? os.homedir() : path.join(directory, 'home');
  const workspace = path.join(directory, 'workspace');
  await Promise.all([dataDirectory, homeDirectory, workspace].map((entry) => mkdir(entry, { recursive: true })));
  await writeFile(path.join(dataDirectory, 'easyaiflow-sessions.json'), JSON.stringify({ projects: [], deletedImports: { claudeSessionIds: [], codexThreadIds: [] } }));
  return { dataDirectory, homeDirectory, workspace, client: new DeviceServiceClient({ dataDirectory, homeDirectory }) };
}));
const [controller, executor] = peers;
const processes: ChildProcess[] = [];
const start = async (peer: typeof controller) => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/server.ts'], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', EASYAIFLOW_DATA_DIR: peer.dataDirectory, EASYAIFLOW_HOME_DIR: peer.homeDirectory } });
  processes.push(child);
  return new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Gateway did not start: ${output}`)), 30000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Gateway exited: ${output}`)); });
    child.stdout!.on('data', (chunk) => { output += chunk; const found = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (found) { clearTimeout(timer); resolve(found[0]); } });
    child.stderr!.on('data', (chunk) => { output += chunk; });
  });
};
const stop = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill(); await exited;
};
const post = (url: string, body: unknown, headers: Record<string, string> = {}) => new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
  const request = httpRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (response) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    response.on('error', reject);
    response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }));
  });
  request.on('error', reject);
  request.end(JSON.stringify(body));
});
const waitForReply = async (roomId: string, messageId: string, timeout = 180000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const room = await controller.client.request<SessionRecord>('getSessionRecord', { sessionId: roomId });
    const reply = room.messages.find((message) => message.id === messageId);
    if (reply?.status === 'error') throw new Error(reply.content);
    if (reply?.status === 'complete') return { room, reply };
    assert.ok(Date.now() < deadline, 'Remote group reply timed out');
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
};

let roomId = '';
try {
  const [originA, originB] = await Promise.all([start(controller), start(executor)]);
  const code = await executor.client.request<DevicePairingCode>('createDevicePairing', { purpose: 'device' });
  const paired = await controller.client.request<DeviceDescriptor>('addRemoteDevice', { origin: originB, code: code.code, expectedDeviceId: code.device.id, name: 'Executor' }, 'pair-executor');
  const remoteProject = await executor.client.request<ProjectCreateResult>('createProject', { name: 'Executor project', rootPath: executor.workspace });
  const localProject = await controller.client.request<ProjectCreateResult>('createProject', { name: 'Controller project', rootPath: controller.workspace });
  const created = await controller.client.request<SessionCreateResult>('createSessionInStreamwork', { streamworkId: localProject.session.dreamId, name: 'Cross-device room', sessionKind: 'group' });
  roomId = created.session.id;
  if (created.session.group?.kind !== 'room') throw new Error('Expected a group room');

  const options = await controller.client.request<GroupPlacementOptions>('getGroupPlacementOptions');
  const option = options.devices.find((device) => device.id === paired.id);
  assert.equal(option?.connection, 'online');
  assert.deepEqual(option?.projects.map((project) => project.id), [remoteProject.project.id]);
  await assert.rejects(controller.client.request('getGroupPlacementOptions', undefined, undefined, paired.id), /远程设备不允许/);
  console.log('PASS placement options list online paired devices and their projects, and are not routable to peers');

  const base: GroupParticipantConfig[] = created.session.group.participants.map(({ id, label, provider, enabled, model, effort }) => ({ id, label, provider, enabled, model, effort }));
  const reviewer: GroupParticipantConfig = { id: 'reviewer', label: 'Remote reviewer', provider: 'claude', enabled: true, effort: 'low',
    placement: { deviceId: paired.id, projectId: remoteProject.project.id } };
  const update = { sessionId: roomId, expectedRevision: created.session.group.configurationRevision ?? 0, participants: [...base, reviewer] };
  const saved = await controller.client.request<{ session: SessionRecord }>('updateGroupParticipants', update, 'place-reviewer');
  const member = saved.session.group?.kind === 'room' ? saved.session.group.participants.find((participant) => participant.id === 'reviewer') : undefined;
  assert.equal(member?.remote?.deviceId, paired.id);
  assert.equal(member?.remote?.projectId, remoteProject.project.id);
  assert.equal(member?.remote?.workspace, executor.workspace);
  assert.equal(member?.model, undefined, 'remote members default to the executor recommendation, not a controller model');
  assert.equal('placement' in (member ?? {}), false);
  const remoteSession = await executor.client.request<SessionRecord>('getSessionRecord', { sessionId: member!.remote!.sessionId });
  assert.equal(remoteSession.provider, 'claude');
  assert.equal(remoteSession.workspace, executor.workspace);
  const retried = await controller.client.request<{ session: SessionRecord }>('updateGroupParticipants', update, 'place-reviewer');
  assert.equal(retried.session.group?.kind === 'room' && retried.session.group.participants.find((participant) => participant.id === 'reviewer')?.remote?.sessionId, member!.remote!.sessionId);
  const executorSessions = (await executor.client.request<{ projects: Array<{ dreams: Array<{ sessions: Array<{ id: string }> }> }> }>('getProjects')).projects
    .flatMap((project) => project.dreams.flatMap((dream) => dream.sessions)).filter((session) => session.id !== remoteProject.session.id);
  assert.equal(executorSessions.length, 1, 'retrying the same operation must not create another remote member session');
  console.log('PASS a placed member gets one executor-owned session; retries reuse it');

  const revision = saved.session.group?.kind === 'room' ? saved.session.group.configurationRevision ?? 0 : 0;
  const local = saved.session.group?.kind === 'room' ? saved.session.group.participants.map(({ id, label, provider, enabled, model, effort, remote }) =>
    ({ id, label, provider, enabled, model, effort, ...(remote ? { placement: { deviceId: remote.deviceId, projectId: remote.projectId } } : {}) })) : [];
  await assert.rejects(controller.client.request('updateGroupParticipants', { sessionId: roomId, expectedRevision: revision,
    participants: local.map((participant) => participant.id === 'reviewer' ? { ...participant, placement: undefined } : participant) }, 'move-reviewer'), /执行设备不能更换/);
  console.log('PASS an existing member cannot silently move between devices');

  // A device-purpose grant may control the controller, but not its peers through the room.
  const controllerCode = await controller.client.request<DevicePairingCode>('createDevicePairing', { purpose: 'device' });
  const grant = await post(`${originA}/api/device/pair`, { code: controllerCode.code, purpose: 'device', name: 'Third machine' });
  const token = String(grant.body.token);
  const denied = await post(`${originA}/api/rpc`, { method: 'sendMessage', operationId: 'grant-send', payload: { sessionId: roomId, prompt: '@reviewer hi' } }, { Authorization: `Bearer ${token}` });
  assert.equal(denied.body.code, 'EAF_ACCESS_DENIED');
  const deniedConfig = await post(`${originA}/api/rpc`, { method: 'updateGroupParticipants', operationId: 'grant-config', payload: update }, { Authorization: `Bearer ${token}` });
  assert.equal(deniedConfig.body.code, 'EAF_ACCESS_DENIED');
  const deniedOptions = await post(`${originA}/api/rpc`, { method: 'getGroupPlacementOptions' }, { Authorization: `Bearer ${token}` });
  assert.equal(deniedOptions.status, 403);
  const allowed = await post(`${originA}/api/rpc`, { method: 'getSessionRecord', payload: { sessionId: roomId } }, { Authorization: `Bearer ${token}` });
  assert.equal(allowed.status, 200);
  const room = await controller.client.request<SessionRecord>('getSessionRecord', { sessionId: roomId });
  assert.equal(room.messages.length, 0, 'the denied send must not append anything');
  console.log('PASS device grants cannot drive peers transitively through cross-device members');

  if (process.argv.includes('--preview')) {
    console.log(`Preview controller: ${originA}; room: ${roomId}`);
    await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 10 * 60 * 1000); process.once('SIGINT', () => { clearTimeout(timer); resolve(); }); });
  }

  if (live) {
    const catalog = await controller.client.request<ProviderModelCatalog>('getProviderModels', { provider: 'claude', cwd: executor.workspace }, undefined, paired.id);
    const sonnet = catalog.models.find((model) => model.aliases?.includes('sonnet'))?.id;
    const localCodex = await controller.client.request<ProviderModelCatalog>('getProviderModels', { provider: 'codex', cwd: controller.workspace });
    const instructions = 'For this integration test, use only the EAF team MCP tools when asked to delegate. Do not use shell, file, external-network or native subagent tools.';
    const members = local.map((participant) => participant.id === 'reviewer' ? { ...participant, model: sonnet, instructions }
      : participant.provider === 'codex' ? { ...participant, model: localCodex.models.find((model) => model.isDefault)?.id, effort: 'low', instructions } : { ...participant, enabled: false });
    await controller.client.request('updateGroupParticipants', { sessionId: roomId, expectedRevision: revision, participants: members, collaborationEnabled: true }, 'live-config');

    const direct = await controller.client.request<{ queued: { assistantMessageId: string } }>('sendMessage', { sessionId: roomId, targetParticipantIds: ['reviewer'],
      prompt: 'Integration test. Do not use tools. Reply exactly REMOTE_MEMBER_OK.' }, 'live-direct');
    const { reply } = await waitForReply(roomId, direct.queued.assistantMessageId);
    assert.match(reply.content, /REMOTE_MEMBER_OK/);
    const executed = await executor.client.request<SessionRecord>('getSessionRecord', { sessionId: member!.remote!.sessionId });
    assert.ok(executed.messages.some((message) => message.role === 'assistant' && message.content.includes('REMOTE_MEMBER_OK')), 'the reply must come from the executor session');
    console.log('PASS real remote Claude member replies through the executor and is mirrored into the room');

    const sender = members.find((participant) => participant.provider === 'codex')!.id;
    const before = await controller.client.request<SessionRecord>('getSessionRecord', { sessionId: roomId });
    const parent = await controller.client.request<{ queued: { assistantMessageId: string } }>('sendMessage', { sessionId: roomId, targetParticipantIds: [sender], prompt:
      'Integration test: use the eaf_team MCP tool team_send to delegate to member reviewer. Set request_id to "cross-device" and message to "Do not use tools. Reply exactly CROSS_DEVICE_CHILD_OK." Then use team_wait with the returned delivery_id until you receive the actual reply. Finally reply exactly "CROSS_DEVICE_PARENT_OK" followed by the actual child marker. Do not use native subagents, shell, file or external-network tools. If EAF tools fail, report the exact failure instead of inventing a reply.' }, 'live-team');
    const done = await waitForReply(roomId, parent.queued.assistantMessageId, 300000);
    assert.match(done.reply.content.trim(), /^CROSS_DEVICE_PARENT_OK\s+CROSS_DEVICE_CHILD_OK$/);
    const deliveries = done.room.messages.filter((message) => !before.messages.some((old) => old.id === message.id) && message.role === 'user' && message.speakerId === sender);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].teamDelivery?.recipientId, 'reviewer');
    const child = await executor.client.request<SessionRecord>('getSessionRecord', { sessionId: member!.remote!.sessionId });
    assert.ok(child.messages.some((message) => message.role === 'assistant' && message.content.includes('CROSS_DEVICE_CHILD_OK')));
    console.log('PASS real cross-device round trip: local Codex -> remote Claude -> local Codex through team tools');
    console.log(`Live artifacts: ${root}`);
  }
} finally {
  if (roomId) await controller.client.request('stopSessionRun', { sessionId: roomId }, `cleanup-stop-${Date.now()}`).catch(() => undefined);
  await Promise.all(processes.map(stop));
  for (const peer of peers) { await peer.client.request('shutdownDeviceService').catch(() => undefined); peer.client.close(); }
}
