import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OperationLedger } from './operationLedger.js';
import { getRuntimePaths } from './runtimePaths.js';
import type { ClaudeInteractionState } from './claudeInteractionState.js';

export type TeamTaskContext = { rootTaskId: string; ancestors: string[]; senderId?: string; senderLabel?: string; deliveryId?: string };
export type TeamDeliveryReceipt = { sessionId: string; userMessageId: string; assistantMessageId: string; recipient: string };
export type TeamReply = { status: 'queued' | 'running' | 'replied' | 'failed' | 'unknown'; content?: string; truncated?: boolean };
type TeamMember = { id: string; label: string; provider: string; enabled: boolean };
export type TeamLease = {
  sessionId: string; roomId: string; memberId: string; memberLabel: string; context: TeamTaskContext; signal: AbortSignal;
  members: TeamMember[];
  send: (recipient: string, message: string, context: TeamTaskContext) => Promise<TeamDeliveryReceipt>;
  read: (receipt: TeamDeliveryReceipt) => Promise<TeamReply>;
};
export type TeamToolConfig = { claudeConfigPath: string; codexConfig: Record<string, unknown>; release: () => void };
type Capability = { token: string; claudeConfigPath: string; codexConfig: Record<string, unknown>; lease?: TeamLease; waitingFor?: string };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const MAX_DELIVERIES = 16;
const MAX_DEPTH = 4;

/** Capabilities are process-local; durable receipts never contain their secrets. */
export class AgentMessaging {
  private capabilities = new Map<string, Capability>();
  private byToken = new Map<string, Capability>();
  private dispatches = new Map<string, Promise<unknown>>();
  constructor(private readonly directory: string) {}

  async bind(lease: TeamLease): Promise<TeamToolConfig> {
    lease.signal.throwIfAborted();
    if (this.capabilities.has(lease.sessionId)) throw new Error('Another team turn already owns this member.');
    if (this.capabilities.size >= 256) throw new Error('Too many simultaneous team members.');
    const token = randomBytes(32).toString('base64url');
    const prefix = path.join(this.directory, 'agent-tools', `${digest(lease.sessionId)}-${randomBytes(8).toString('hex')}`);
    const credentialFile = prefix + '.access.json';
    const claudeConfigPath = prefix + '.mcp.json';
    const capability: Capability = { token, claudeConfigPath, codexConfig: {}, lease };
    this.capabilities.set(lease.sessionId, capability);
    const release = () => {
      if (this.capabilities.get(lease.sessionId) !== capability) return;
      capability.lease = undefined; capability.waitingFor = undefined;
      this.capabilities.delete(lease.sessionId); this.byToken.delete(token);
      // Each path was generated inside this service's agent-tools directory;
      // unlink exact files only, never recursively delete a computed directory.
      void Promise.all([credentialFile, claudeConfigPath].map((file) => unlink(file).catch(() => undefined)));
    };
    try {
      await mkdir(path.dirname(prefix), { recursive: true });
      await writeFile(credentialFile, JSON.stringify({ dataDirectory: this.directory, token }), { mode: 0o600 });
      const source = import.meta.url.endsWith('.ts');
      const loader = source ? pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href : undefined;
      const server = { command: process.execPath, args: [...(loader ? ['--import', loader] : []), fileURLToPath(new URL(`./agentMcpServer.${source ? 'ts' : 'js'}`, import.meta.url))],
        env: { ELECTRON_RUN_AS_NODE: '1', EAF_AGENT_LINK: credentialFile } };
      await writeFile(claudeConfigPath, JSON.stringify({ mcpServers: { eaf_team: { type: 'stdio', ...server } } }), { mode: 0o600 });
      capability.codexConfig = { 'mcp_servers.eaf_team': { ...server, startup_timeout_sec: 20, tool_timeout_sec: 40 } };
      lease.signal.throwIfAborted();
      this.byToken.set(token, capability);
      return { claudeConfigPath, codexConfig: capability.codexConfig, release };
    } catch (error) { release(); throw error; }
  }
  private ledger(root: string) {
    const directory = path.join(this.directory, 'agent-messages', digest(root));
    return { ledger: new OperationLedger(directory), directory };
  }
  private receiptId(lease: TeamLease, requestId: string) { return 'team-' + digest(`${lease.roomId}\n${lease.context.rootTaskId}\n${lease.memberId}\n${requestId}`); }
  private check(capability: Capability, lease: TeamLease) {
    if (capability.lease !== lease || lease.signal.aborted) throw new Error('This member turn ended or was stopped; team tools are no longer authorized.');
  }
  async call(token: string, name: string, raw: unknown): Promise<unknown> {
    const capability = this.byToken.get(token);
    const lease = capability?.lease;
    if (!capability || !lease) throw new Error('No active authorized team member.');
    this.check(capability, lease);
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    if (name === 'team_members') return { member: lease.memberId, members: lease.members.filter((member) => member.enabled).map(({ id, label, provider }) => ({ id, label, provider })), remainingDepth: MAX_DEPTH - lease.context.ancestors.length };
    const { ledger, directory } = this.ledger(lease.context.rootTaskId);
    if (name === 'team_send') {
      if (typeof input.recipient !== 'string' || !lease.members.some((member) => member.id === input.recipient && member.enabled)) throw new Error('Choose an enabled member from team_members.');
      if (input.recipient === lease.memberId || lease.context.ancestors.includes(input.recipient)) throw new Error('Cannot delegate to yourself or an ancestor. Return your result to your requester instead.');
      if (lease.context.ancestors.length >= MAX_DEPTH) throw new Error('Delegation depth limit reached. Finish the current task directly.');
      if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 16000) throw new Error('Message must contain 1–16000 characters.');
      if (typeof input.request_id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(input.request_id)) throw new Error('Use a stable request_id of 1–64 letters, digits, underscores or hyphens.');
      const id = this.receiptId(lease, input.request_id);
      const payload = { roomId: lease.roomId, rootTaskId: lease.context.rootTaskId, sender: lease.memberId, recipient: input.recipient, message: input.message };
      // Serialize quota reservation and durable dispatch within each root task.
      const previous = this.dispatches.get(lease.context.rootTaskId) ?? Promise.resolve();
      const pending = previous.catch(() => undefined).then(async () => {
        this.check(capability, lease);
        const existing = await ledger.get(id);
        if (!existing) {
          const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
          if (files.filter((file) => file.endsWith('.json')).length >= MAX_DELIVERIES) throw new Error('This user task reached its 16-message delegation limit. Return the current results.');
        }
        const receipt = await ledger.execute(id, 'team_send', payload, async () => {
          this.check(capability, lease);
          return lease.send(payload.recipient as string, payload.message as string, { ...lease.context, ancestors: [...lease.context.ancestors, lease.memberId], senderId: lease.memberId, senderLabel: lease.memberLabel, deliveryId: id });
        }) as TeamDeliveryReceipt;
        return { delivery_id: id, status: 'queued', recipient: receipt.recipient };
      });
      this.dispatches.set(lease.context.rootTaskId, pending);
      void pending.finally(() => { if (this.dispatches.get(lease.context.rootTaskId) === pending) this.dispatches.delete(lease.context.rootTaskId); }).catch(() => undefined);
      return pending;
    }
    if (name === 'team_wait') {
      if (typeof input.delivery_id !== 'string' || !/^team-[a-f0-9]{64}$/.test(input.delivery_id)) throw new Error('Use a delivery_id returned by team_send.');
      const record = await ledger.get(input.delivery_id);
      const payload = record?.payload as { roomId?: string; sender?: string } | undefined;
      if (!record || payload?.roomId !== lease.roomId || payload.sender !== lease.memberId) throw new Error('This delivery does not belong to the current member task.');
      if (record.status !== 'completed' || !record.result) return { delivery_id: input.delivery_id, status: 'unknown', detail: 'Dispatch outcome is unconfirmed; it has not been resent.' };
      const receipt = record.result as TeamDeliveryReceipt;
      if (capability.waitingFor) throw new Error('This member already has an active wait.');
      const seen = new Set([lease.memberId]);
      let next: string | undefined = receipt.recipient;
      while (next) {
        if (seen.has(next)) throw new Error('Waiting would create a team dependency cycle. Finish your current task without waiting.');
        seen.add(next);
        next = [...this.capabilities.values()].find((entry) => entry.lease?.roomId === lease.roomId && entry.lease?.memberId === next)?.waitingFor;
      }
      capability.waitingFor = receipt.recipient;
      const deadline = Date.now() + 20000;
      try {
        do {
          this.check(capability, lease);
          const reply = await lease.read(receipt);
          if (reply.status !== 'queued' && reply.status !== 'running' || Date.now() >= deadline) return { delivery_id: input.delivery_id, recipient: receipt.recipient, ...reply };
          await new Promise((resolve) => setTimeout(resolve, 400));
        } while (true);
      } finally { if (capability.lease === lease) capability.waitingFor = undefined; }
    }
    throw new Error('Unknown EAF team tool.');
  }
}

const instances = new WeakMap<ClaudeInteractionState, AgentMessaging>();
export const agentMessagingFor = (state: ClaudeInteractionState) => {
  let instance = instances.get(state);
  if (!instance) { instance = new AgentMessaging(getRuntimePaths().userDataPath); instances.set(state, instance); }
  return instance;
};
