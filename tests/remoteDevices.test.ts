import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, writeFile, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DeviceServiceClient } from '../backend/deviceServiceClient.ts';
import type { DeviceDescriptor, DevicePairingCode } from '../src/data/devices.ts';
import type { ProviderModelCatalog } from '../src/data/providerModels.ts';
import type { SessionCreateResult, SessionRecord } from '../src/data/types.ts';

const live = process.argv.includes('--live');

await mkdir('.tmp-tests', { recursive: true });
const root = await mkdtemp(path.resolve('.tmp-tests', 'remote-devices-'));
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
const start = async (peer: typeof controller, port = '0') => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/server.ts'], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: port, EASYAIFLOW_DATA_DIR: peer.dataDirectory, EASYAIFLOW_HOME_DIR: peer.homeDirectory } });
  processes.push(child);
  const origin = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Gateway did not start: ${output}`)), 30000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Gateway exited: ${output}`)); });
    child.stdout!.on('data', (chunk) => { output += chunk; const found = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (found) { clearTimeout(timer); resolve(found[0]); } });
    child.stderr!.on('data', (chunk) => { output += chunk; });
  });
  return { child, origin };
};
const stop = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill(); await exited;
};
// Undici fetch rewrites Host, so use a real HTTP request for host/auth checks.
const post = (url: string, body: unknown, headers: Record<string, string> = {}) => new Promise<Response>((resolve, reject) => {
  const request = httpRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (response) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    response.on('error', reject);
    response.on('end', () => {
      const resultHeaders = new Headers();
      for (const [key, value] of Object.entries(response.headers)) for (const entry of Array.isArray(value) ? value : value ? [value] : []) resultHeaders.append(key, entry);
      resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: resultHeaders }));
    });
  });
  request.on('error', reject);
  request.end(JSON.stringify(body));
});
const rpc = (origin: string, method: string, payload?: unknown, headers: Record<string, string> = {}, deviceId?: string) => post(`${origin}/api/rpc`, { method, payload, deviceId }, headers);
const waitFor = async (predicate: () => Promise<boolean>) => {
  const end = Date.now() + 20000;
  while (!await predicate()) { assert.ok(Date.now() < end, 'Timed out waiting for device status'); await new Promise((resolve) => setTimeout(resolve, 100)); }
};
try {
  const gatewayA = await start(controller);
  let gatewayB = await start(executor);
  const statusB = await executor.client.request<{ deviceId: string; instanceId: string }>('getDeviceStatus');
  const code = await executor.client.request<DevicePairingCode>('createDevicePairing', { purpose: 'device' });
  const paired = await controller.client.request<DeviceDescriptor>('addRemoteDevice', { origin: gatewayB.origin, code: code.code, expectedDeviceId: code.device.id, name: 'Test executor' }, 'pair-executor');
  assert.equal(paired.id, statusB.deviceId);
  const payload = { rootPath: executor.workspace, name: 'Remote project' };
  const first = await controller.client.request<{ project: { id: string } }>('createProject', payload, 'remote-project', paired.id);
  const duplicate = await controller.client.request<{ project: { id: string } }>('createProject', payload, 'remote-project', paired.id);
  assert.equal(first.project.id, duplicate.project.id);
  assert.equal((await controller.client.request<{ projects: unknown[] }>('getProjects')).projects.length, 0);
  assert.equal((await executor.client.request<{ projects: unknown[] }>('getProjects')).projects.length, 1);
  await assert.rejects(controller.client.request('createProject', payload, 'wrong-device', 'missing-device'), /EAF_DEVICE_UNAVAILABLE/);
  console.log('PASS paired commands execute only on the selected device and retain operation identity');

  const files = await readdir(path.join(controller.dataDirectory, 'operations'));
  const records = await Promise.all(files.filter((file) => file.endsWith('.json')).map((file) => readFile(path.join(controller.dataDirectory, 'operations', file), 'utf8')));
  assert.ok(records.every((record) => !record.includes(code.code)));
  assert.ok(records.some((record) => record.includes('[redacted]')));
  console.log('PASS pairing secrets are redacted from durable operation receipts');

  const events = await fetch(`${gatewayA.origin}/api/events?deviceId=${paired.id}`, { signal: AbortSignal.timeout(10000) });
  const reader = events.body!.getReader();
  try {
    let text = '';
    while (!text.includes('interaction-snapshot')) {
      const chunk = await reader.read(); assert.equal(chunk.done, false); text += new TextDecoder().decode(chunk.value);
    }
    const snapshot = text.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5))).find((event) => event.type === 'interaction-snapshot');
    assert.equal(snapshot.deviceId, paired.id);
    assert.equal(snapshot.snapshot.version.epoch, statusB.instanceId);
  } finally { await reader.cancel(); }
  console.log('PASS selected-device SSE snapshots preserve the execution device identity and epoch');

  const port = new URL(gatewayB.origin).port;
  await stop(gatewayB.child);
  await waitFor(async () => (await controller.client.request<{ devices: DeviceDescriptor[] }>('getDevices')).devices.find((device) => device.id === paired.id)?.connection === 'offline');
  assert.equal((await executor.client.request<{ instanceId: string }>('getDeviceStatus')).instanceId, statusB.instanceId);
  gatewayB = await start(executor, port);
  await waitFor(async () => (await controller.client.request<{ devices: DeviceDescriptor[] }>('getDevices')).devices.find((device) => device.id === paired.id)?.connection === 'online');
  assert.equal((await controller.client.request<{ projects: unknown[] }>('getProjects', undefined, undefined, paired.id)).projects.length, 1);
  console.log('PASS gateway loss marks a device offline without stopping its worker and reconnect restores routing');

  if (live) {
    const { projects } = await controller.client.request<{ projects: Array<{ dreams: Array<{ id: string }> }> }>('getProjects', undefined, undefined, paired.id);
    for (const provider of ['claude', 'codex'] as const) {
      const catalog = await controller.client.request<ProviderModelCatalog>('getProviderModels', { provider, cwd: executor.workspace }, undefined, paired.id);
      const model = provider === 'claude' ? catalog.models.find((item) => item.aliases?.includes('sonnet'))?.id : catalog.models.find((item) => item.isDefault)?.id;
      assert.ok(model);
      const created = await controller.client.request<SessionCreateResult>('createSessionInStreamwork', { streamworkId: projects[0].dreams[0].id, name: `Remote ${provider} probe`, provider }, undefined, paired.id);
      try {
        const input = { sessionId: created.session.id, prompt: 'Integration test. Do not use tools, create agents or edit files. Reply exactly REMOTE_DEVICE_OK.', model, effort: 'default' };
        const queued = await controller.client.request<{ queued: { assistantMessageId: string } }>('sendMessage', input, `remote-${provider}`, paired.id);
        // Disconnect the gateway during execution; the worker must finish independently.
        const livePort = new URL(gatewayB.origin).port;
        await stop(gatewayB.child);
        const deadline = Date.now() + 90000;
        let record: SessionRecord;
        do {
          record = await executor.client.request<SessionRecord>('getSessionRecord', { sessionId: created.session.id });
          const reply = record.messages.find((message) => message.id === queued.queued.assistantMessageId);
          if (reply?.status === 'error') throw new Error(reply.content);
          if (reply?.status === 'complete') { assert.match(reply.content, /REMOTE_DEVICE_OK/); break; }
          assert.ok(Date.now() < deadline, 'Real CLI response timed out');
          await new Promise((resolve) => setTimeout(resolve, 750));
        } while (true);
        gatewayB = await start(executor, livePort);
        const recovered = await controller.client.request<SessionRecord>('getSessionRecord', { sessionId: created.session.id }, undefined, paired.id);
        const duplicate = await controller.client.request<typeof queued>('sendMessage', input, `remote-${provider}`, paired.id);
        assert.equal(duplicate.queued.assistantMessageId, queued.queued.assistantMessageId);
        assert.equal(recovered.messages.find((message) => message.id === queued.queued.assistantMessageId)?.content, record.messages.find((message) => message.id === queued.queued.assistantMessageId)?.content);
        console.log(`PASS real remote ${provider}: execution survives gateway loss and same operation ID does not submit twice`);
      } finally {
        await executor.client.request('stopSessionRun', { sessionId: created.session.id });
        await executor.client.request('disconnectSession', { sessionId: created.session.id });
      }
    }
    console.log(`Live remote-device artifacts: ${root}`);
  }

  if (process.argv.includes('--preview')) {
    console.log(`Preview controller: ${gatewayA.origin}; executor: ${gatewayB.origin}`);
    console.log(`Preview data: ${root}`);
    await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 15 * 60 * 1000); process.once('SIGINT', () => { clearTimeout(timer); resolve(); }); });
  }

  const otherCode = await executor.client.request<DevicePairingCode>('createDevicePairing', { purpose: 'device' });
  const exchanged = await (await fetch(`${gatewayB.origin}/api/device/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: otherCode.code, purpose: 'device', name: 'Scope probe' }) })).json();
  assert.equal((await rpc(gatewayB.origin, 'getDevices', undefined, { Authorization: `Bearer ${exchanged.token}` })).status, 403);
  assert.equal((await rpc(gatewayB.origin, 'getProjects', undefined, { Authorization: `Bearer ${exchanged.token}` }, paired.id + '-other')).status, 403);
  assert.equal((await rpc(gatewayB.origin, 'getProjects', undefined, { Authorization: 'Bearer invalid' })).status, 401);
  assert.equal((await rpc(gatewayB.origin, 'getProjects', undefined, { Host: 'remote.test' })).status, 401);
  console.log('PASS unauthenticated access, management escalation and transitive routing are rejected');

  const browserCode = await executor.client.request<DevicePairingCode>('createDevicePairing', { purpose: 'browser' });
  const login = await post(`${gatewayB.origin}/api/device/pair`, { code: browserCode.code, purpose: 'browser', name: 'Browser probe' }, { Host: 'remote.test' });
  const cookie = login.headers.get('set-cookie')!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal('token' in await login.json(), false);
  assert.equal((await rpc(gatewayB.origin, 'getDevices', undefined, { Cookie: cookie.split(';')[0], Host: 'remote.test' })).status, 200);
  const { grants } = await executor.client.request<{ grants: Array<{ id: string; name: string }> }>('getDeviceAccessGrants');
  for (const grant of grants) await executor.client.request('revokeDeviceAccess', { grantId: grant.id });
  assert.equal((await rpc(gatewayB.origin, 'getDevices', undefined, { Cookie: cookie.split(';')[0], Host: 'remote.test' })).status, 401);
  await assert.rejects(controller.client.request('getProjects', undefined, undefined, paired.id), /EAF_AUTH_REQUIRED/);
  console.log('PASS browser login uses an HTTP-only session and revocation removes browser and controller access');

  const logoutCode = await executor.client.request<DevicePairingCode>('createDevicePairing', { purpose: 'browser' });
  const logoutLogin = await post(`${gatewayB.origin}/api/device/pair`, { code: logoutCode.code, purpose: 'browser' }, { Host: 'remote.test' });
  const logoutCookie = logoutLogin.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await post(`${gatewayB.origin}/api/device/logout`, {}, { Cookie: logoutCookie, Host: 'remote.test' })).status, 200);
  assert.equal((await rpc(gatewayB.origin, 'getProjects', undefined, { Cookie: logoutCookie, Host: 'remote.test' })).status, 401);
  console.log('PASS logout revokes the session server-side, including copies of the old cookie');
} finally {
  await Promise.all(processes.map(stop));
  for (const peer of peers) { await peer.client.request('shutdownDeviceService').catch(() => undefined); peer.client.close(); }
}
