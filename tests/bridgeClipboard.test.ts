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

await run('web bridge emits an interaction sync when the SSE connection opens', async () => {
  const originalEventSource = globalThis.EventSource;
  const events: Array<{ type: string }> = [];

  class MockEventSource {
    static instances: MockEventSource[] = [];
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent<string>) => void) | null = null;
    closed = false;

    constructor(_url: string | URL) {
      MockEventSource.instances.push(this);
    }

    close() {
      this.closed = true;
    }
  }

  Object.defineProperty(globalThis, 'EventSource', {
    configurable: true,
    value: MockEventSource,
  });

  try {
    const unsubscribe = bridge.onClaudeEvent((event) => {
      events.push(event as { type: string });
    });

    const source = MockEventSource.instances[0];
    assert.ok(source);

    source.onopen?.({} as Event);
    unsubscribe();

    assert.equal(events[0]?.type, 'interaction-sync');
    assert.equal(source.closed, true);
  } finally {
    if (typeof originalEventSource === 'undefined') {
      delete (globalThis as typeof globalThis & { EventSource?: typeof EventSource }).EventSource;
    } else {
      Object.defineProperty(globalThis, 'EventSource', {
        configurable: true,
        value: originalEventSource,
      });
    }
  }
});
