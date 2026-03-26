import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const run = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const loadExternalNavigationModule = async () => {
  const moduleUrl = pathToFileURL(path.resolve('electron/externalNavigation.ts')).href;

  try {
    return await import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
  } catch {
    return {};
  }
};

await run('desktop shell routes external https links to the system browser', async () => {
  const module = await loadExternalNavigationModule();
  assert.equal(typeof module.shouldOpenExternally, 'function');
  assert.equal(
    module.shouldOpenExternally({
      currentUrl: 'file:///X:/AITool/EasyAIFlow/dist/index.html',
      targetUrl: 'https://docs.example.com/guide',
    }),
    true,
  );
});

await run('desktop shell keeps same-origin dev server navigations inside the app', async () => {
  const module = await loadExternalNavigationModule();
  assert.equal(typeof module.shouldOpenExternally, 'function');
  assert.equal(
    module.shouldOpenExternally({
      currentUrl: 'http://127.0.0.1:4173/',
      targetUrl: 'http://127.0.0.1:4173/session/123',
    }),
    false,
  );
});

await run('desktop shell routes system protocols like mailto externally', async () => {
  const module = await loadExternalNavigationModule();
  assert.equal(typeof module.shouldOpenExternally, 'function');
  assert.equal(
    module.shouldOpenExternally({
      currentUrl: 'http://127.0.0.1:4173/',
      targetUrl: 'mailto:support@example.com',
    }),
    true,
  );
});
