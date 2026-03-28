import assert from 'node:assert/strict';
import {
  advanceSessionPermissionRequest,
  enqueueSessionPermissionRequest,
  getActiveSessionPermissionRequest,
} from '../src/data/sessionInteraction.ts';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const makeRequest = (requestId: string, path: string) => ({
  requestId,
  path,
  sensitive: false,
  sessionId: 'session-1',
});

run('enqueueSessionPermissionRequest keeps the first pending permission active', () => {
  const first = makeRequest('req-1', 'agents/openai.yaml');
  const second = makeRequest('req-2', 'agents/claude.yaml');

  const state = enqueueSessionPermissionRequest(
    enqueueSessionPermissionRequest({}, first),
    second,
  );

  assert.equal(getActiveSessionPermissionRequest(state)?.requestId, 'req-1');
  assert.deepEqual(state.pendingPermissions?.map((request) => request.requestId), ['req-2']);
});

run('advanceSessionPermissionRequest promotes the next queued permission', () => {
  const first = makeRequest('req-1', 'agents/openai.yaml');
  const second = makeRequest('req-2', 'agents/claude.yaml');

  const state = advanceSessionPermissionRequest(
    enqueueSessionPermissionRequest(
      enqueueSessionPermissionRequest({}, first),
      second,
    ),
  );

  assert.equal(getActiveSessionPermissionRequest(state)?.requestId, 'req-2');
  assert.deepEqual(state.pendingPermissions ?? [], []);
});
