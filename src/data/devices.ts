export type DeviceIdentity = { id: string; name: string; platform: string };
export type DeviceDescriptor = DeviceIdentity & {
  kind: 'local' | 'remote';
  origin?: string;
  connection: 'online' | 'connecting' | 'offline';
  lastSeen?: number;
  active?: boolean;
  error?: string;
};
export type DeviceAccessPurpose = 'device' | 'browser';
export type DeviceAccessGrant = { id: string; name: string; purpose: DeviceAccessPurpose; createdAt: number; expiresAt?: number };
export type DevicePairingCode = { code: string; expiresAt: number; purpose: DeviceAccessPurpose; device: DeviceIdentity };
export type RemoteDeviceInput = {
  origin: string;
  code: string;
  expectedDeviceId?: string;
  name?: string;
  trustedVpn?: boolean;
  certificate?: string;
};
export type RemoteDeviceRecord = DeviceIdentity & { origin: string; encryptedToken: string; trustedVpn?: boolean; certificate?: string; pairedAt: number };

export const DEVICE_MANAGEMENT_METHODS = new Set(['getDevices', 'createDevicePairing', 'addRemoteDevice', 'removeRemoteDevice', 'getDeviceAccessGrants', 'revokeDeviceAccess']);
export const DEVICE_WORK_EXCLUDED_METHODS = new Set([...DEVICE_MANAGEMENT_METHODS, 'clipboard:write-text']);

export const normalizeDeviceOrigin = (value: string, trustedVpn = false) => {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('请输入完整的设备地址，例如 https://电脑名称:8887。'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('设备地址只能包含协议、主机名和端口。');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || trustedVpn))) {
    throw new Error('远程设备需要 HTTPS；通过已有加密 VPN 使用 HTTP 时，请明确选择 VPN 连接。');
  }
  return url.origin;
};
