import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import { promisify } from 'node:util';
import { DeviceServiceClient } from '../backend/deviceServiceClient.ts';
import { DeviceAccessStore } from '../backend/deviceAccessStore.ts';
import { RemoteDeviceRouter } from '../backend/remoteDevice.ts';
import type { DevicePairingCode } from '../src/data/devices.ts';

const openssl = process.env.OPENSSL_PATH || (process.platform === 'win32' && existsSync('C:/Program Files/Git/usr/bin/openssl.exe') ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');
await mkdir('.tmp-tests', { recursive: true });
const root = await mkdtemp(path.resolve('.tmp-tests', 'device-tls-'));
const dataDirectory = path.join(root, 'executor');
const homeDirectory = path.join(root, 'home');
await Promise.all([dataDirectory, homeDirectory].map((directory) => mkdir(directory)));
await writeFile(path.join(dataDirectory, 'easyaiflow-sessions.json'), JSON.stringify({ projects: [], deletedImports: { claudeSessionIds: [], codexThreadIds: [] } }));
const certificatePath = path.join(root, 'test-certificate.pem');
const keyPath = path.join(root, 'test-key.pem');
await promisify(execFile)(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=EAF local test', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyPath, '-out', certificatePath], { windowsHide: true });
const certificate = await readFile(certificatePath, 'utf8');
const client = new DeviceServiceClient({ dataDirectory, homeDirectory });
const access = await DeviceAccessStore.open(path.join(root, 'controller'), 'test-only-key');
const router = new RemoteDeviceRouter(access, () => undefined);
let gateway: ChildProcess | undefined;
try {
  gateway = spawn(process.execPath, ['--import', 'tsx', 'server/server.ts'], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, HOST: '127.0.0.1', PORT: '0', EASYAIFLOW_DATA_DIR: dataDirectory, EASYAIFLOW_HOME_DIR: homeDirectory, EASYAIFLOW_TLS_CERT: certificatePath, EASYAIFLOW_TLS_KEY: keyPath,
  } });
  const origin = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(output || 'TLS gateway startup timed out')), 20000);
    gateway!.once('error', (error) => { clearTimeout(timeout); reject(error); });
    gateway!.once('exit', () => { clearTimeout(timeout); reject(new Error(output)); });
    gateway!.stdout!.on('data', (chunk) => { output += chunk; const match = output.match(/https:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timeout); resolve(match[0]); } });
    gateway!.stderr!.on('data', (chunk) => { output += chunk; });
  });
  const code = await client.request<DevicePairingCode>('createDevicePairing', { purpose: 'device' });
  await assert.rejects(router.add({ origin, code: code.code }), /证书/);
  const peer = await router.add({ origin, code: code.code, expectedDeviceId: code.device.id, certificate });
  assert.equal((await router.request<{ deviceId: string }>(peer.id, 'getDeviceStatus')).deviceId, peer.id);
  console.log('PASS HTTPS pairing requires a trusted certificate and preserves device identity');

  await assert.rejects(new Promise<void>((resolve, reject) => {
    const request = https.get(origin + '/api/device/info', { ca: certificate, servername: 'wrong-host.example' }, (response) => { response.resume(); resolve(); });
    request.on('error', reject);
  }), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ERR_TLS_CERT_ALTNAME_INVALID');
  console.log('PASS trusting a self-signed certificate does not disable hostname validation');
} finally {
  router.close();
  if (gateway && gateway.exitCode === null) {
    const exited = new Promise<void>((resolve) => gateway!.once('exit', () => resolve())); gateway.kill(); await exited;
  }
  await client.request('shutdownDeviceService').catch(() => undefined); client.close();
}
