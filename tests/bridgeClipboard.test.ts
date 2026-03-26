import assert from 'node:assert/strict';
import { bridge } from '../src/bridge.ts';

const run = async (name: string, fn: () => Promise<void>) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

await run('web bridge falls back to RPC clipboard writes when the browser Clipboard API is unavailable', async () => {
  const originalNavigator = globalThis.navigator;
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string | URL | Request; body: string }> = [];

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {},
  });

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url,
      body: String(init?.body ?? ''),
    });

    return {
      ok: true,
      json: async () => null,
    } as Response;
  }) as typeof fetch;

  try {
    await bridge.writeClipboardText('[[session:session-1]]');
  } finally {
    if (typeof originalNavigator === 'undefined') {
      delete (globalThis as typeof globalThis & { navigator?: Navigator }).navigator;
    } else {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: originalNavigator,
      });
    }

    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(String(calls[0]?.url), '/api/rpc');
  assert.match(calls[0]?.body ?? '', /"method":"clipboard:write-text"/);
  assert.match(calls[0]?.body ?? '', /\[\[session:session-1\]\]/);
});
