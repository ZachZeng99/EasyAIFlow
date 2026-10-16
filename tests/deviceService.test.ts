import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import { DeviceServiceClient } from '../backend/deviceServiceClient.ts';
import { serviceAddress } from '../backend/deviceServiceProtocol.ts';
import type { ProjectCreateResult, ProjectRecord, StreamworkCreateResult } from '../src/data/types.ts';

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
let shutdownClient: DeviceServiceClient | undefined;

try {
  await Promise.all([desktop.connect(), web.connect()]);
  const desktopStatus = await desktop.request<{ pid: number; instanceId: string }>('getDeviceStatus');
  const webStatus = await web.request<{ pid: number; instanceId: string }>('getDeviceStatus');
  assert.equal(desktopStatus.instanceId, webStatus.instanceId);
  assert.notEqual(desktopStatus.pid, process.pid);
  console.log('PASS concurrent desktop and web connections use one independent device service');

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
