import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEVICE_SERVICE_PROTOCOL = 1;
export const MAX_SERVICE_MESSAGE_BYTES = 32 * 1024 * 1024;
export const serviceAddress = (directory: string) => {
  const normalized = process.platform === 'win32' ? path.resolve(directory).toLowerCase() : path.resolve(directory);
  const identity = createHash('sha256').update(normalized).digest('hex').slice(0, 24);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\eaf-${identity}`
    : path.join(os.tmpdir(), `eaf-${process.getuid?.() ?? 'user'}-${identity}.sock`);
};

export const readServiceKey = async (directory: string) => {
  const key = (await readFile(path.join(directory, 'device-service.key'), 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid device service key.');
  return key;
};

export const ensureServiceKey = async (directory: string) => {
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(path.join(directory, 'device-service.key'), randomBytes(32).toString('hex'), {
      encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return readServiceKey(directory);
};
