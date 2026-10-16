import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DeviceServiceClient } from '../backend/deviceServiceClient.ts';

await mkdir('.tmp-tests', { recursive: true });
const root = await mkdtemp(path.resolve('.tmp-tests', 'web-gateway-'));
const dataDirectory = path.join(root, 'data');
const homeDirectory = path.join(root, 'home');
const workspace = path.join(root, 'workspace');
await Promise.all([dataDirectory, homeDirectory, workspace].map((directory) => mkdir(directory)));
await writeFile(path.join(dataDirectory, 'easyaiflow-sessions.json'), JSON.stringify({ projects: [], deletedImports: { claudeSessionIds: [], codexThreadIds: [] } }));
const processes: ChildProcess[] = [];
const start = async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/server.ts'], {
    cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', EASYAIFLOW_DATA_DIR: dataDirectory, EASYAIFLOW_HOME_DIR: homeDirectory },
  });
  processes.push(child);
  const origin = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`Gateway did not start: ${output}`)), 30000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Gateway exited ${code}: ${output}`)); });
    child.stdout!.on('data', (chunk) => {
      output += String(chunk);
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    child.stderr!.on('data', (chunk) => { output += String(chunk); });
  });
  return { child, origin };
};
const stop = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill();
  await exited;
};
const control = new DeviceServiceClient({ dataDirectory, homeDirectory, autoStart: false });
try {
  let gateway = await start();
  const status = await control.request<{ instanceId: string }>('getDeviceStatus');
  const eventsResponse = await fetch(`${gateway.origin}/api/events`, { signal: AbortSignal.timeout(10000) });
  const reader = eventsResponse.body!.getReader();
  let stream = '';
  let snapshot: { type: string; snapshot: { version: { epoch: string; sequence: number } } } | undefined;
  try {
    while (!snapshot) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      stream += new TextDecoder().decode(chunk.value);
      snapshot = stream.split('\n').filter((line) => line.startsWith('data: ')).map((line) => {
        try { return JSON.parse(line.slice(6)); } catch { return null; }
      }).find((event) => event?.type === 'interaction-snapshot');
    }
    assert.equal(snapshot.snapshot.version.epoch, status.instanceId);
    assert.ok(snapshot.snapshot.version.sequence > 0);
  } finally { await reader.cancel(); }
  console.log('PASS SSE reconnect delivers one versioned interaction snapshot');
  const body = { method: 'createProject', payload: { name: 'HTTP test', rootPath: workspace }, operationId: 'http-create' };
  const invoke = () => fetch(`${gateway.origin}/api/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const first = await (await invoke()).json();
  const second = await (await invoke()).json();
  assert.equal(first.project.id, second.project.id);
  console.log('PASS HTTP retries share the device operation ledger');
  const denied = await fetch(`${gateway.origin}/api/rpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' }, body: JSON.stringify(body),
  });
  assert.equal(denied.status, 403);
  const admin = await fetch(`${gateway.origin}/api/rpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method: 'shutdownDeviceService' }),
  });
  assert.equal(admin.status, 400);
  console.log('PASS browser gateway rejects foreign origins and service administration methods');
  await stop(gateway.child);
  assert.equal((await control.request<{ instanceId: string }>('getDeviceStatus')).instanceId, status.instanceId);
  gateway = await start();
  const reopened = await (await invoke()).json();
  assert.equal(reopened.project.id, first.project.id);
  console.log('PASS restarting the HTTP gateway preserves the service and prior operation result');
} finally {
  await Promise.all(processes.map(stop));
  await control.request('shutdownDeviceService').catch(() => undefined);
  control.close();
}
