import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AgentMessaging, type TeamLease } from '../backend/agentMessaging.ts';

await mkdir('.tmp-tests', { recursive: true });
const directory = await mkdtemp(path.resolve('.tmp-tests', 'agent-messages-'));
const mailbox = new AgentMessaging(directory);
const tokenFor = async (configPath: string) => {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  return JSON.parse(await readFile(config.mcpServers.eaf_team.env.EAF_AGENT_LINK, 'utf8')).token as string;
};
const members = [{ id: 'a', label: 'A', provider: 'claude', enabled: true }, { id: 'b', label: 'B', provider: 'codex', enabled: true }, { id: 'disabled', label: 'Disabled', provider: 'codex', enabled: false }];
let sends = 0;
const controller = new AbortController();
const lease: TeamLease = { sessionId: 'backing-a', roomId: 'room', memberId: 'a', memberLabel: 'A', context: { rootTaskId: 'root', ancestors: [] }, members, signal: controller.signal,
  send: async (recipient, _message, context) => { sends++; assert.equal(context.senderId, 'a'); assert.deepEqual(context.ancestors, ['a']); return { sessionId: 'room', userMessageId: 'request', assistantMessageId: 'reply', recipient }; },
  read: async () => ({ status: 'replied', content: 'actual reply' }),
};
const bound = await mailbox.bind(lease);
const token = await tokenFor(bound.claudeConfigPath);
await assert.rejects(mailbox.call('invalid', 'team_members', {}), /authorized/);
await assert.rejects(mailbox.call(token, 'team_send', { recipient: 'disabled', message: 'x', request_id: 'x' }), /enabled/);
await assert.rejects(mailbox.call(token, 'team_send', { recipient: 'a', message: 'x', request_id: 'x' }), /yourself/);
const input = { recipient: 'b', message: 'please review', request_id: 'review' };
const [first, duplicate] = await Promise.all([mailbox.call(token, 'team_send', input), mailbox.call(token, 'team_send', input)]) as Array<{ delivery_id: string }>;
assert.deepEqual(first, duplicate); assert.equal(sends, 1);
assert.deepEqual(await mailbox.call(token, 'team_wait', first), { ...first, status: 'replied', content: 'actual reply' });
await assert.rejects(mailbox.call(token, 'team_send', { ...input, message: 'changed' }), /CONFLICT/);
console.log('PASS active-member scopes, recipient validation and durable send/wait idempotence');

for (let index = 1; index < 16; index++) await mailbox.call(token, 'team_send', { ...input, request_id: `request-${index}` });
await assert.rejects(mailbox.call(token, 'team_send', { ...input, request_id: 'request-17' }), /limit/);
await mailbox.call(token, 'team_send', input);
assert.equal(sends, 16);
bound.release();
await assert.rejects(mailbox.call(token, 'team_send', input), /authorized/);
const reopened = new AgentMessaging(directory);
const reopenedConfig = await reopened.bind(lease);
const reopenedToken = await tokenFor(reopenedConfig.claudeConfigPath);
await assert.rejects(reopened.call(token, 'team_members', {}), /authorized/);
assert.deepEqual(await reopened.call(reopenedToken, 'team_send', input), first);
assert.equal(sends, 16);
reopenedConfig.release();
console.log('PASS per-task quota, stopped capabilities and replay after restart without resubmission');

const uncertainLease = { ...lease, context: { rootTaskId: 'uncertain', ancestors: [] }, send: async () => { sends++; throw new Error('lost confirmation'); } };
const uncertainConfig = await mailbox.bind(uncertainLease);
const uncertainToken = await tokenFor(uncertainConfig.claudeConfigPath);
assert.notEqual(uncertainToken, token);
await assert.rejects(mailbox.call(token, 'team_members', {}), /authorized/);
await assert.rejects(mailbox.call(uncertainToken, 'team_send', input), /UNCERTAIN/);
await assert.rejects(mailbox.call(uncertainToken, 'team_send', input), /UNCERTAIN/);
assert.equal(sends, 17);
uncertainConfig.release();
console.log('PASS an unconfirmed dispatch remains uncertain and is never silently executed twice');

const cyclicAbort = new AbortController();
const pendingRead = async () => ({ status: 'queued' as const });
const leftLease: TeamLease = { ...lease, signal: cyclicAbort.signal, context: { rootTaskId: 'left-root', ancestors: [] }, read: pendingRead };
const rightLease: TeamLease = { ...leftLease, sessionId: 'backing-b', memberId: 'b', memberLabel: 'B', context: { rootTaskId: 'right-root', ancestors: [] }, send: async (recipient) => ({ sessionId: 'room', userMessageId: 'right-request', assistantMessageId: 'right-reply', recipient }) };
const left = await mailbox.bind(leftLease); const right = await mailbox.bind(rightLease);
const leftToken = await tokenFor(left.claudeConfigPath); const rightToken = await tokenFor(right.claudeConfigPath);
const leftReceipt = await mailbox.call(leftToken, 'team_send', input);
const rightReceipt = await mailbox.call(rightToken, 'team_send', { ...input, recipient: 'a' });
const waiting = mailbox.call(leftToken, 'team_wait', leftReceipt);
const stopped = assert.rejects(waiting, /ended or was stopped/);
await new Promise((resolve) => setTimeout(resolve, 50));
await assert.rejects(mailbox.call(rightToken, 'team_wait', rightReceipt), /cycle/);
cyclicAbort.abort(); await stopped;
left.release(); right.release();
console.log('PASS waits reject cross-task dependency cycles and unblock when the group stops');

const ancestor = await mailbox.bind({ ...lease, memberId: 'b', context: { rootTaskId: 'descendant', ancestors: ['a'] } });
await assert.rejects(mailbox.call(await tokenFor(ancestor.claudeConfigPath), 'team_send', { ...input, recipient: 'a' }), /ancestor/);
ancestor.release();
console.log('PASS descendants cannot enqueue work back onto a waiting ancestor');
