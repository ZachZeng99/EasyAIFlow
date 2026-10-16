import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import { DeviceServiceClient } from '../backend/deviceServiceClient.ts';
import { serviceAddress } from '../backend/deviceServiceProtocol.ts';
import type { ClaudeStreamEvent, InteractionSnapshot, InteractionVersion, ProjectCreateResult, ProjectRecord, StreamworkCreateResult, SessionCreateResult, SessionRecord } from '../src/data/types.ts';

await mkdir('.tmp-tests', { recursive: true });
const directory = await mkdtemp(path.resolve('.tmp-tests', 'device-service-'));
const dataDirectory = path.join(directory, 'data');
const homeDirectory = path.join(directory, 'home');
const workspace = path.join(directory, 'workspace');
await mkdir(homeDirectory);
await mkdir(workspace);
const options = { dataDirectory, homeDirectory };
const clients: DeviceServiceClient[] = [];
const makeClient = () => { const client = new DeviceServiceClient(options); clients.push(client); return client; };
const desktop = makeClient();
const web = makeClient();
const events: ClaudeStreamEvent[] = [];
desktop.onEvent((event) => events.push(event));
let shutdownClient: DeviceServiceClient | undefined;

try {
  await Promise.all([desktop.connect(), web.connect()]);
  const desktopStatus = await desktop.request<{ pid: number; instanceId: string }>('getDeviceStatus');
  const webStatus = await web.request<{ pid: number; instanceId: string }>('getDeviceStatus');
  assert.equal(desktopStatus.instanceId, webStatus.instanceId);
  assert.notEqual(desktopStatus.pid, process.pid);
  console.log('PASS concurrent desktop and web connections use one independent device service');

  const stateSnapshot = await desktop.request<InteractionSnapshot>('getInteractionSnapshot');
  assert.equal(stateSnapshot.version.epoch, desktopStatus.instanceId);
  const startup = events.find((event) => event.type === 'interaction-snapshot');
  assert.ok(startup?.type === 'interaction-snapshot' && startup.connection);
  assert.equal(startup.snapshot.version.epoch, desktopStatus.instanceId);
  assert.ok(stateSnapshot.version.sequence > startup.snapshot.version.sequence);
  const catalogSnapshot = await desktop.request<{ interactionVersion: InteractionVersion }>('getProjects');
  assert.equal(catalogSnapshot.interactionVersion.epoch, desktopStatus.instanceId);
  assert.ok(catalogSnapshot.interactionVersion.sequence > stateSnapshot.version.sequence);
  console.log('PASS connection, explicit and catalog snapshots share one service interaction clock');

  const payload = { name: 'Daemon test', rootPath: workspace };
  const [first, duplicate] = await Promise.all([
    desktop.request<ProjectCreateResult>('createProject', payload, 'project-create'),
    web.request<ProjectCreateResult>('createProject', payload, 'project-create'),
  ]);
  assert.equal(first.project.id, duplicate.project.id);
  const streamworkPayload = { projectId: first.project.id, name: 'Only once' };
  const [a, b] = await Promise.all([
    desktop.request<StreamworkCreateResult>('createStreamwork', streamworkPayload, 'streamwork-create'),
    web.request<StreamworkCreateResult>('createStreamwork', streamworkPayload, 'streamwork-create'),
  ]);
  assert.equal(a.streamwork.id, b.streamwork.id);
  const bootstrap = await desktop.request<{ projects: ProjectRecord[] }>('getProjects');
  assert.equal(bootstrap.projects.find((project) => project.id === first.project.id)?.dreams.filter((dream) => dream.name === 'Only once').length, 1);
  console.log('PASS duplicate operations from two clients create one persisted result');
  await desktop.request('renameEntity', { kind: 'project', id: first.project.id, name: 'Updated project' });
  const oldReplay = await desktop.request<StreamworkCreateResult>('createStreamwork', streamworkPayload, 'streamwork-create');
  assert.equal(oldReplay.projects.find((project) => project.id === first.project.id)?.name, 'Updated project');
  console.log('PASS replayed operations return fresh catalog state instead of rolling back later changes');

  const group = await desktop.request<SessionCreateResult>('createSessionInStreamwork', { streamworkId: a.streamwork.id, name: 'Configurable team', sessionKind: 'group' });
  assert.ok(group.session.group?.kind === 'room');
  const groupPayload = { sessionId: group.session.id, expectedRevision: 0, participants: [
    ...group.session.group.participants,
    { id: 'reviewer', label: 'Reviewer', provider: 'codex', model: 'future-model', effort: 'ultra', instructions: 'Review only.', enabled: true },
  ] };
  const [configured, sameConfig] = await Promise.all([
    desktop.request<{ session: SessionRecord }>('updateGroupParticipants', groupPayload, 'configure-group'),
    web.request<{ session: SessionRecord }>('updateGroupParticipants', groupPayload, 'configure-group'),
  ]);
  assert.ok(configured.session.group?.kind === 'room' && sameConfig.session.group?.kind === 'room');
  assert.equal(configured.session.group.configurationRevision, 1);
  assert.deepEqual(configured.session.group, sameConfig.session.group);
  assert.equal(configured.session.group.participants.length, 3);
  await assert.rejects(web.request('updateGroupParticipants', groupPayload, 'stale-config'), /EAF_OPERATION_REJECTED/);
  const receipt = await web.request<{ status: string }>('getOperationStatus', { operationId: 'stale-config' });
  assert.equal(receipt.status, 'rejected');
  console.log('PASS group configuration is shared and idempotent with definitive stale-version rejection');

  await new Promise<void>((resolve, reject) => {
    const intruder = createConnection(serviceAddress(dataDirectory));
    const timeout = setTimeout(() => { intruder.destroy(); reject(new Error('Unauthenticated socket was not rejected')); }, 5000);
    intruder.once('connect', () => intruder.write(`${JSON.stringify({ type: 'auth', version: 1, key: '0'.repeat(64) })}\n`));
    intruder.once('close', () => { clearTimeout(timeout); resolve(); });
    intruder.once('error', () => undefined);
  });
  console.log('PASS the local execution pipe rejects unauthenticated connections');

  desktop.close();
  web.close();
  process.kill(desktopStatus.pid, 0);
  shutdownClient = makeClient();
  const after = await shutdownClient.request<{ instanceId: string }>('getDeviceStatus');
  assert.equal(after.instanceId, desktopStatus.instanceId);
  const replay = await shutdownClient.request<StreamworkCreateResult>('createStreamwork', streamworkPayload, 'streamwork-create');
  assert.equal(replay.streamwork.id, a.streamwork.id);
  console.log('PASS closing every client leaves the service alive and reopening recovers the same operation');
} finally {
  try {
    const control = shutdownClient ?? makeClient();
    await control.request('shutdownDeviceService');
  } finally {
    for (const client of clients) client.close();
  }
}
