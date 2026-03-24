import assert from 'node:assert/strict';
import {
  resolveDefaultDesktopUserDataPath,
  resolveDefaultWebUserDataPath,
} from '../backend/runtimePaths.ts';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('resolveDefaultDesktopUserDataPath matches the desktop EasyAIFlow app-data folder on Windows', () => {
  const resolved = resolveDefaultDesktopUserDataPath({
    platform: 'win32',
    env: {
      APPDATA: 'C:\\Users\\L\\AppData\\Roaming',
    },
    homePath: 'C:\\Users\\L',
  });

  assert.equal(resolved, 'C:\\Users\\L\\AppData\\Roaming\\EasyAIFlow');
});

run('resolveDefaultWebUserDataPath prefers the shared desktop store when it exists', () => {
  const resolved = resolveDefaultWebUserDataPath({
    platform: 'win32',
    env: {
      APPDATA: 'C:\\Users\\L\\AppData\\Roaming',
    },
    homePath: 'C:\\Users\\L',
    pathExists: (candidate) => candidate === 'C:\\Users\\L\\AppData\\Roaming\\EasyAIFlow',
  });

  assert.equal(resolved, 'C:\\Users\\L\\AppData\\Roaming\\EasyAIFlow');
});

run('resolveDefaultWebUserDataPath falls back to the legacy web store when no shared desktop store exists', () => {
  const resolved = resolveDefaultWebUserDataPath({
    platform: 'win32',
    env: {
      APPDATA: 'C:\\Users\\L\\AppData\\Roaming',
    },
    homePath: 'C:\\Users\\L',
    pathExists: () => false,
  });

  assert.equal(resolved, 'C:\\Users\\L\\.easyaiflow-web');
});

run('resolveDefaultWebUserDataPath respects the explicit override env var', () => {
  const resolved = resolveDefaultWebUserDataPath({
    platform: 'win32',
    env: {
      APPDATA: 'C:\\Users\\L\\AppData\\Roaming',
      EASYAIFLOW_DATA_DIR: 'D:\\custom-store',
    },
    homePath: 'C:\\Users\\L',
    pathExists: () => true,
  });

  assert.equal(resolved, 'D:\\custom-store');
});
