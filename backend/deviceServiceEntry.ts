import os from 'node:os';
import { startDeviceService } from './deviceServiceServer.js';

const dataDirectory = process.env.EASYAIFLOW_DATA_DIR;
if (!dataDirectory) throw new Error('EASYAIFLOW_DATA_DIR is required for the device service.');
try {
  const service = await startDeviceService({
    dataDirectory,
    homeDirectory: process.env.EASYAIFLOW_HOME_DIR || os.homedir(),
  });
  const shutdown = () => { void service.stop().finally(() => process.exit(0)); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
    console.error(error);
    process.exitCode = 1;
  }
}
