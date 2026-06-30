import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const run = async (name: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

await run('Vite dev server defaults to client port 4173', async () => {
  const originalClientPort = process.env.EASYAIFLOW_WEB_CLIENT_PORT;
  delete process.env.EASYAIFLOW_WEB_CLIENT_PORT;

  try {
    const config = (await import('../vite.config.ts')).default;
    assert.equal(config.server?.port, 4173);
  } finally {
    if (originalClientPort === undefined) {
      delete process.env.EASYAIFLOW_WEB_CLIENT_PORT;
    } else {
      process.env.EASYAIFLOW_WEB_CLIENT_PORT = originalClientPort;
    }
  }
});

await run('desktop dev script waits for the Vite client on port 4173', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );

  assert.equal(
    packageJson.scripts['dev:desktop'],
    'wait-on http-get://127.0.0.1:4173 && npm run build:electron && electron .',
  );
});
