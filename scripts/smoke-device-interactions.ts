import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DeviceServiceClient } from '../backend/deviceServiceClient.ts';
import { InteractionReconciler } from '../src/data/interactionSync.ts';
import type { SessionInteractionState } from '../src/data/sessionInteraction.ts';
import type { InteractionSnapshot } from '../src/data/types.ts';
import type { ProviderModelCatalog } from '../src/data/providerModels.ts';
import type { ClaudeStreamEvent, ProjectCreateResult, SessionCreateResult, SessionRecord } from '../src/data/types.ts';

await mkdir('.tmp-tests', { recursive: true });
const root = await mkdtemp(path.resolve('.tmp-tests', 'live-interactions-'));
const workspace = path.join(root, 'workspace');
const dataDirectory = path.join(root, 'data');
await Promise.all([workspace, dataDirectory].map((directory) => mkdir(directory)));
await writeFile(path.join(dataDirectory, 'easyaiflow-sessions.json'), JSON.stringify({ projects: [], deletedImports: { claudeSessionIds: [], codexThreadIds: [] } }));
process.env.EASYAIFLOW_PROTOCOL_CAPTURE_DIR = path.join(root, 'protocol');
console.log(`Interaction artifacts: ${root}`);
const clientOptions = { dataDirectory, homeDirectory: os.homedir() };
let client = new DeviceServiceClient(clientOptions);
const reconciliation = new InteractionReconciler();
let projection = new Map<string, SessionInteractionState>();
const observe = (event: ClaudeStreamEvent) => {
  const update = event.type === 'interaction-snapshot'
    ? reconciliation.snapshot(event.snapshot, event.connection)
    : reconciliation.event(event);
  if (update.apply) projection = update.apply(projection);
};
client.onEvent(observe);
const sessions: string[] = [];
const failures: string[] = [];
let askSession = '';
const answered = new Set<string>();
let capturedQuestion: Extract<ClaudeStreamEvent, { type: 'ask-user-question' }> | undefined;
client.onEvent((event) => {
  if (event.type !== 'ask-user-question' || event.sessionId !== askSession || answered.has(event.toolUseId)) return;
  answered.add(event.toolUseId);
  if (process.argv.includes('--reconnect-question')) { capturedQuestion = event; return; }
  void client.request('respondToAskUserQuestion', {
    toolUseId: event.toolUseId,
    answers: Object.fromEntries(event.questions.map((question) => [question.question, question.options[0]?.label ?? 'A'])),
  }, `answer-${event.toolUseId}`).catch((error) => failures.push(`answer: ${error.message}`));
});
const waitFor = async (id: string, predicate: (session: SessionRecord) => boolean, label: string) => {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const session = await client.request<SessionRecord>('getSessionRecord', { sessionId: id });
    if (predicate(session)) return session;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${label} timed out`);
};
const run = async (label: string, body: () => Promise<void>) => {
  try { await body(); console.log(`PASS ${label}`); }
  catch (error) { const message = error instanceof Error ? error.message : String(error); failures.push(`${label}: ${message}`); console.error(`FAIL ${label}: ${message}`); }
};

try {
  const catalog = await client.request<ProviderModelCatalog>('getProviderModels', { provider: 'claude', cwd: workspace });
  const model = catalog.models.find((entry) => entry.aliases?.includes('sonnet'))?.id;
  assert.ok(model);
  const project = await client.request<ProjectCreateResult>('createProject', { rootPath: workspace, name: 'EAF interaction smoke' });
  if (!process.argv.includes('--only-group')) {
  const created = await client.request<SessionCreateResult>('createSessionInStreamwork', { streamworkId: project.session.dreamId, name: 'Question smoke', provider: 'claude' });
  askSession = created.session.id;
  sessions.push(askSession);
  await run('real Claude AskUserQuestion round trip', async () => {
    let delayedSnapshot: InteractionSnapshot | undefined;
    const started = await client.request<{ queued: { assistantMessageId: string } }>('sendMessage', {
      sessionId: askSession, model, effort: 'default',
      prompt: 'Integration test: use AskUserQuestion to ask exactly one question with choices A and B. Do not use any other tools. After receiving my answer, reply with exactly EAF_ASK_OK.',
    });
    if (process.argv.includes('--reconnect-question')) {
      const deadline = Date.now() + 60000;
      while (!capturedQuestion && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
      assert.ok(capturedQuestion, 'No question arrived before reconnect');
      client.close();
      client = new DeviceServiceClient(clientOptions);
      client.onEvent(observe);
      const interactions = await client.request<ClaudeStreamEvent[]>('getInteractionEvents');
      assert.ok(interactions.some((event) => event.type === 'ask-user-question' && event.toolUseId === capturedQuestion!.toolUseId));
      delayedSnapshot = await client.request<InteractionSnapshot>('getInteractionSnapshot');
      await client.request('respondToAskUserQuestion', {
        toolUseId: capturedQuestion.toolUseId,
        answers: Object.fromEntries(capturedQuestion.questions.map((question) => [question.question, question.options[0]?.label ?? 'A'])),
      });
    }
    const record = await waitFor(askSession, (session) => session.messages.some((message) => message.id === started.queued.assistantMessageId && ['complete', 'error'].includes(message.status ?? '')), 'question turn');
    assert.ok(answered.size > 0, 'No interactive question was delivered');
    assert.match(record.messages.find((message) => message.id === started.queued.assistantMessageId)?.content ?? '', /EAF_ASK_OK/);
    if (capturedQuestion) {
      assert.ok(delayedSnapshot?.interactions[askSession]?.askUserQuestion);
      const stale = reconciliation.snapshot(delayedSnapshot!);
      if (stale.apply) projection = stale.apply(projection);
      assert.equal(projection.get(askSession)?.askUserQuestion, undefined);
      console.log('PASS delayed native interaction snapshot cannot reopen an answered question');
      const duplicate = await client.request<{ mode: string }>('respondToAskUserQuestion', {
        toolUseId: capturedQuestion.toolUseId,
        answers: Object.fromEntries(capturedQuestion.questions.map((question) => [question.question, 'B'])),
      });
      assert.equal(duplicate.mode, 'already-handled');
      assert.equal(record.messages.filter((message) => message.role === 'user').length, 1);
      console.log('PASS question survives client reconnect and rejects a late second answer');
    }
  });
  await client.request('stopSessionRun', { sessionId: askSession }).catch(() => undefined);
  await client.request('disconnectSession', { sessionId: askSession }).catch(() => undefined);
  }

  if (!process.argv.includes('--only-ask')) {
  const room = await client.request<SessionCreateResult>('createSessionInStreamwork', { streamworkId: project.session.dreamId, name: 'Group smoke', sessionKind: 'group' });
  const roomId = room.session.id;
  sessions.push(roomId);
  await run('first unmentioned group message has a default recipient', async () => {
    const started = await client.request<{ queued: { assistantMessageId: string } }>('sendMessage', { sessionId: roomId, effort: 'default', prompt: 'Do not use tools. Reply with exactly DEFAULT_GROUP_OK.' });
    assert.ok(started.queued.assistantMessageId);
    const record = await waitFor(roomId, (session) => session.messages.some((message) => message.id === started.queued.assistantMessageId && message.status === 'complete'), 'default group recipient');
    assert.match(record.messages.find((message) => message.id === started.queued.assistantMessageId)?.content ?? '', /DEFAULT_GROUP_OK/);
  });
  await run('real group fan-out and shared context', async () => {
    const started = await client.request<{ queued: { userMessageId: string } }>('sendMessage', { sessionId: roomId, effort: 'default', prompt: '@all Do not use tools. Reply with exactly your participant label followed by _GROUP_OK.' });
    const first = await waitFor(roomId, (session) => {
      const userSeq = session.messages.find((message) => message.id === started.queued.userMessageId)?.seq ?? Infinity;
      return ['claude', 'codex'].every((speaker) => session.messages.some((message) => (message.seq ?? 0) > userSeq && message.speakerId === speaker && message.role === 'assistant' && message.status === 'complete' && message.content.includes('_GROUP_OK')));
    }, 'group fan-out');
    assert.ok(first.messages.some((message) => message.role === 'assistant' && /Claude_GROUP_OK/i.test(message.content)));
    assert.ok(first.messages.some((message) => message.role === 'assistant' && /Codex_GROUP_OK/i.test(message.content)));
    const follow = await client.request<{ queued: { assistantMessageId: string } }>('sendMessage', { sessionId: roomId, effort: 'default', prompt: '@codex Repeat Claude\'s previous exact reply. Do not add anything and do not use tools.' });
    const second = await waitFor(roomId, (session) => session.messages.some((message) => message.id === follow.queued.assistantMessageId && message.status === 'complete'), 'group follow-up');
    assert.match(second.messages.find((message) => message.id === follow.queued.assistantMessageId)?.content ?? '', /Claude_GROUP_OK/i);
  });
  for (const provider of ['claude', 'codex']) {
  await run(`queued ${provider} room replies keep their own message identities`, async () => {
    const first = await client.request<{ queued: { assistantMessageId: string } }>('sendMessage', { sessionId: roomId, effort: 'default', prompt: `@${provider} Do not use tools. Reply with exactly QUEUE_A.` });
    const second = await client.request<{ queued: { assistantMessageId: string } }>('sendMessage', { sessionId: roomId, effort: 'default', prompt: `@${provider} Do not use tools. Reply with exactly QUEUE_B.` });
    const record = await waitFor(roomId, (session) => [first, second].every((turn) => session.messages.some((message) => message.id === turn.queued.assistantMessageId && message.status === 'complete')), 'queued room turns');
    assert.match(record.messages.find((message) => message.id === first.queued.assistantMessageId)?.content ?? '', /QUEUE_A/);
    assert.match(record.messages.find((message) => message.id === second.queued.assistantMessageId)?.content ?? '', /QUEUE_B/);
  });
  }
  await run('real group stop settles current and queued turns', async () => {
    for (const provider of ['claude', 'codex']) {
      await client.request('sendMessage', { sessionId: roomId, effort: 'default', prompt: `@${provider} Do not use tools. Write a long numbered list of 100 sample words.` });
      await client.request('sendMessage', { sessionId: roomId, effort: 'default', prompt: `@${provider} Do not use tools. Reply with exactly SHOULD_BE_CANCELLED.` });
    }
    await client.request('stopSessionRun', { sessionId: roomId });
    const record = await client.request<SessionRecord>('getSessionRecord', { sessionId: roomId });
    assert.ok(record.messages.every((message) => !['queued', 'streaming', 'running'].includes(message.status ?? '')));
    assert.ok(!record.messages.some((message) => message.role === 'assistant' && message.content.includes('SHOULD_BE_CANCELLED')));
  });
  }
} finally {
  for (const sessionId of sessions) {
    await client.request('stopSessionRun', { sessionId }).catch(() => undefined);
    await client.request('disconnectSession', { sessionId }).catch(() => undefined);
  }
  await client.request('shutdownDeviceService').catch((error) => console.error(`Service cleanup: ${error.message}`));
  client.close();
}
assert.deepEqual(failures, []);
