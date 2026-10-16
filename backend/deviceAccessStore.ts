import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DeviceAccessGrant, DeviceAccessPurpose, DeviceIdentity, DevicePairingCode, RemoteDeviceRecord } from '../src/data/devices.js';
import { RpcRejectedError } from '../src/data/rpcOperations.js';

type StoredGrant = DeviceAccessGrant & { tokenHash: string };
type Registry = { version: 1; identity: DeviceIdentity; peers: RemoteDeviceRecord[]; grants: StoredGrant[] };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const equals = (left: string, right: string) => left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));

export class DeviceAccessStore {
  private pendingCodes = new Map<string, { expiresAt: number; purpose: DeviceAccessPurpose }>();
  private pairingOperations = new Map<string, DevicePairingCode>();
  private queue = Promise.resolve();
  private constructor(private readonly file: string, private registry: Registry, private readonly key: Buffer) {}

  static async open(directory: string, serviceKey: string) {
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, 'device-registry.json');
    const initial: Registry = { version: 1, identity: { id: randomUUID(), name: os.hostname(), platform: process.platform }, peers: [], grants: [] };
    try { await writeFile(file, JSON.stringify(initial), { flag: 'wx', mode: 0o600, flush: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const registry = JSON.parse(await readFile(file, 'utf8')) as Registry;
    if (registry.version !== 1 || !registry.identity?.id || !Array.isArray(registry.peers) || !Array.isArray(registry.grants)) throw new Error('设备注册文件无效，未覆盖原文件。');
    return new DeviceAccessStore(file, registry, createHash('sha256').update(`eaf-device-credentials:${serviceKey}`).digest());
  }
  get identity() { return { ...this.registry.identity }; }
  get peers() { return this.registry.peers.map((peer) => ({ ...peer })); }
  get grants(): DeviceAccessGrant[] { return this.registry.grants.map(({ tokenHash: _secret, ...grant }) => grant); }

  private mutate(update: (registry: Registry) => void) {
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.registry);
      update(next);
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flush: true });
      await rename(temporary, this.file);
      this.registry = next;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  createPairing(purpose: DeviceAccessPurpose, operationId?: string): DevicePairingCode {
    if (purpose !== 'device' && purpose !== 'browser') throw new RpcRejectedError('配对用途无效。');
    const previous = operationId ? this.pairingOperations.get(operationId) : undefined;
    if (previous) {
      if (previous.purpose !== purpose) throw new RpcRejectedError('同一操作不能改变配对用途。');
      if (previous.expiresAt <= Date.now()) throw new RpcRejectedError('这次操作的接入码已过期，请重新生成。');
      return { ...previous };
    }
    for (const [key, entry] of this.pendingCodes) if (entry.expiresAt <= Date.now()) this.pendingCodes.delete(key);
    for (const [key, entry] of this.pairingOperations) if (entry.expiresAt <= Date.now()) this.pairingOperations.delete(key);
    if (this.pendingCodes.size >= 8) throw new RpcRejectedError('待使用的配对码过多，请稍后重试。');
    const code = randomBytes(12).toString('base64url');
    const expiresAt = Date.now() + 5 * 60 * 1000;
    this.pendingCodes.set(hash(code), { expiresAt, purpose });
    const result = { code, expiresAt, purpose, device: this.identity };
    if (operationId) {
      if (this.pairingOperations.size >= 64) this.pairingOperations.delete(this.pairingOperations.keys().next().value!);
      this.pairingOperations.set(operationId, result);
    }
    return { ...result };
  }
  async exchange(code: string, purpose: DeviceAccessPurpose, name: string) {
    if (typeof code !== 'string' || code.length > 256) throw new RpcRejectedError('配对码无效或已过期。');
    const digest = hash(code);
    const pending = this.pendingCodes.get(digest);
    if (!pending || pending.expiresAt <= Date.now() || pending.purpose !== purpose) throw new RpcRejectedError('配对码无效、用途不匹配或已过期。');
    if (this.registry.grants.length >= 64) throw new RpcRejectedError('接入授权已达上限，请先撤销不再使用的授权。');
    this.pendingCodes.delete(digest);
    const token = randomBytes(32).toString('base64url');
    const grant: StoredGrant = { id: randomUUID(), name: String(name || '已配对客户端').slice(0, 80), purpose, createdAt: Date.now(),
      ...(purpose === 'browser' ? { expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 } : {}), tokenHash: hash(token) };
    await this.mutate((registry) => {
      if (registry.grants.length >= 64) throw new RpcRejectedError('接入授权已达上限。');
      registry.grants.push(grant);
    });
    return { device: this.identity, token, grantId: grant.id };
  }
  authorize(token: string): DeviceAccessGrant | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const digest = hash(token);
    const found = this.registry.grants.find((grant) => equals(grant.tokenHash, digest));
    if (!found || found.expiresAt && found.expiresAt <= Date.now()) return undefined;
    const { tokenHash: _secret, ...grant } = found;
    return grant;
  }
  async revoke(grantId: string) { await this.mutate((registry) => { registry.grants = registry.grants.filter((grant) => grant.id !== grantId); }); }
  async savePeer(peer: Omit<RemoteDeviceRecord, 'encryptedToken'>, token: string) {
    if (peer.id === this.registry.identity.id) throw new RpcRejectedError('这个地址属于本机，无需重复添加。');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${peer.id}\n${peer.origin}`));
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    const encryptedToken = [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
    await this.mutate((registry) => {
      if (!registry.peers.some((entry) => entry.id === peer.id) && registry.peers.length >= 32) throw new RpcRejectedError('最多连接 32 台设备。');
      registry.peers = [...registry.peers.filter((entry) => entry.id !== peer.id), { ...peer, encryptedToken }];
    });
  }
  tokenFor(peer: RemoteDeviceRecord) {
    const [iv, tag, ciphertext] = peer.encryptedToken.split('.').map((part) => Buffer.from(part, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(Buffer.from(`${peer.id}\n${peer.origin}`));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
  async removePeer(id: string) { await this.mutate((registry) => { registry.peers = registry.peers.filter((peer) => peer.id !== id); }); }
}
