import { existsSync } from 'node:fs';
import { DeviceServiceClient } from '../backend/deviceServiceClient.ts';
import { resolveDefaultWebUserDataPath } from '../backend/runtimePaths.ts';

const command = process.argv[2] ?? 'status';
if (!['status', 'stop'].includes(command)) throw new Error('Usage: tsx scripts/device-service.ts status|stop');
const client = new DeviceServiceClient({
  dataDirectory: resolveDefaultWebUserDataPath({ env: process.env, pathExists: existsSync }),
  autoStart: false,
});
try {
  console.log(JSON.stringify(await client.request(command === 'stop' ? 'shutdownDeviceService' : 'getDeviceStatus'), null, 2));
} finally { client.close(); }
