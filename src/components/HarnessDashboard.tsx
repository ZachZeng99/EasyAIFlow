import { useState } from 'react';
import type { AskUserQuestionDraft } from '../data/askUserQuestion';
import type { PlanModeResponsePayload } from '../data/planMode';
import { normalizeSessionProvider } from '../data/sessionProvider';
import type { SessionInteractionState } from '../data/sessionInteraction';
import type { DiffPayload, HarnessRole, SessionRecord, SessionSummary, TokenUsage } from '../data/types';
import { ChatThread } from './ChatThread';
import { ChatComposer } from './ChatComposer';

type HarnessDashboardProps = {
  session: SessionSummary;
  plannerSession?: SessionRecord;
  generatorSession?: SessionRecord;
  evaluatorSession?: SessionRecord;
  roleInteractions?: Map<string, SessionInteractionState>;
  onRunHarness?: () => void;
  canRunHarness?: boolean;
  isRunningHarness?: boolean;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'max';
  slashCommands: string[];
  isWebRuntime?: boolean;
  onSendRoleMessage?: (sessionId: string, prompt: string) => void;
  onStopRole?: (sessionId: string) => void;
  onDisconnectRole?: (sessionId: string) => void;
  onRequestDiff?: (filePath: string) => Promise<DiffPayload>;
  onRequestPermission?: (sessionId: string, targetPath: string, sensitive: boolean) => void;
  onGrantPermission?: (sessionId: string) => void;
  onDenyPermission?: (sessionId: string) => void;
  onSubmitAskUserQuestion?: (sessionId: string, draft?: AskUserQuestionDraft) => void;
  onSubmitPlanMode?: (sessionId: string, payload: PlanModeResponsePayload) => void;
};

const roleTitles: Record<HarnessRole, string> = {
  planner: 'Planner',
  generator: 'Generator',
  evaluator: 'Evaluator',
};

const formatPercent = (value: number) => `${Math.max(0, Math.min(100, Math.round(value)))}%`;

const formatStageLabel = (value: string) =>
  value
    .split('-')
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ') || 'Idle';

const emptyTokenUsage: TokenUsage = { contextWindow: 0, used: 0, input: 0, output: 0, cached: 0 };

const findLastAssistantMessage = (session: SessionRecord) =>
  [...(session.messages ?? [])].reverse().find((message) => message.role === 'assistant');

const isAssistantPending = (status: string | undefined) =>
  status === 'queued' || status === 'streaming' || status === 'running';

const RoleChatPane = ({
  role,
  session,
  active,
  interaction,
  model,
  effort,
  slashCommands,
  isWebRuntime,
  onSendMessage,
  onStop,
  onDisconnect,
  onRequestDiff,
  onRequestPermission,
  onGrantPermission,
  onDenyPermission,
  onSubmitAskUserQuestion,
  onSubmitPlanMode,
}: {
  role: HarnessRole;
  session?: SessionRecord;
  active: boolean;
  interaction?: SessionInteractionState;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'max';
  slashCommands: string[];
  isWebRuntime?: boolean;
  onSendMessage?: (sessionId: string, prompt: string) => void;
  onStop?: (sessionId: string) => void;
  onDisconnect?: (sessionId: string) => void;
  onRequestDiff?: (filePath: string) => Promise<DiffPayload>;
  onRequestPermission?: (sessionId: string, targetPath: string, sensitive: boolean) => void;
  onGrantPermission?: (sessionId: string) => void;
  onDenyPermission?: (sessionId: string) => void;
  onSubmitAskUserQuestion?: (sessionId: string, draft?: AskUserQuestionDraft) => void;
  onSubmitPlanMode?: (sessionId: string, payload: PlanModeResponsePayload) => void;
}) => {
  const [draft, setDraft] = useState('');
  const sessionId = session?.id;
  const isResponding = session ? isAssistantPending(findLastAssistantMessage(session)?.status) : false;

  const handleSend = () => {
    if (!sessionId || !draft.trim()) {
      return;
    }
    onSendMessage?.(sessionId, draft.trim());
    setDraft('');
  };

  return (
    <article className={`harness-role-pane ${role}${active ? ' active' : ''}`}>
      <header className="harness-role-head">
        <div>
          <p className="section-kicker">{roleTitles[role]}</p>
          <h2>{session?.title ?? `${roleTitles[role]} waiting`}</h2>
        </div>
        <span className={`harness-role-badge ${active ? 'active' : ''}`}>{active ? 'Working' : 'Standby'}</span>
      </header>

      {session ? (
        <>
          <ChatThread
            session={session}
            messages={session.messages ?? []}
            isCliOnline={Boolean(interaction?.runtime?.processActive)}
            onDisconnect={
              sessionId
                ? () => {
                    onDisconnect?.(sessionId);
                  }
                : undefined
            }
            onRequestDiff={onRequestDiff}
            onRequestPermission={
              sessionId
                ? (request) => onRequestPermission?.(sessionId, request.targetPath, request.sensitive)
                : undefined
            }
            interaction={interaction}
            onGrantPermission={sessionId ? () => onGrantPermission?.(sessionId) : undefined}
            onDenyPermission={sessionId ? () => onDenyPermission?.(sessionId) : undefined}
            onSubmitAskUserQuestion={sessionId ? (d) => onSubmitAskUserQuestion?.(sessionId, d) : undefined}
            onSubmitPlanMode={sessionId ? (payload) => onSubmitPlanMode?.(sessionId, payload) : undefined}
          />
          <ChatComposer
            provider={normalizeSessionProvider(session.provider)}
            draft={draft}
            tokenUsage={session.tokenUsage ?? emptyTokenUsage}
            sessionModel={session.model ?? ''}
            contextReferences={session.contextReferences ?? []}
            slashCommands={slashCommands}
            attachments={[]}
            isSending={false}
            isResponding={isResponding}
            model={model}
            effort={effort}
            supportsPathDrop={!isWebRuntime}
            onDraftChange={setDraft}
            onModelChange={() => {}}
            onEffortChange={() => {}}
            onUpdateContextReferenceMode={() => {}}
            onRemoveContextReference={() => {}}
            onInsertDroppedPaths={() => {}}
            onAttachFiles={() => {}}
            onRemoveAttachment={() => {}}
            onSend={handleSend}
            onStop={() => {
              if (sessionId) {
                onStop?.(sessionId);
              }
            }}
          />
        </>
      ) : (
        <div className="harness-empty-state">Session not created yet.</div>
      )}
    </article>
  );
};

export function HarnessDashboard({
  session,
  plannerSession,
  generatorSession,
  evaluatorSession,
  roleInteractions,
  onRunHarness,
  canRunHarness = false,
  isRunningHarness = false,
  model,
  effort,
  slashCommands,
  isWebRuntime,
  onSendRoleMessage,
  onStopRole,
  onDisconnectRole,
  onRequestDiff,
  onRequestPermission,
  onGrantPermission,
  onDenyPermission,
  onSubmitAskUserQuestion,
  onSubmitPlanMode,
}: HarnessDashboardProps) {
  const state = session.harnessState;
  const progressPercent =
    state?.status === 'completed' || state?.status === 'failed'
      ? 100
      : state && state.totalTurns > 0
        ? (state.completedTurns / state.totalTurns) * 100
        : 0;

  const getInteraction = (roleSession?: SessionRecord) =>
    roleSession ? roleInteractions?.get(roleSession.id) : undefined;

  const sharedProps = {
    model,
    effort,
    slashCommands,
    isWebRuntime,
    onSendMessage: onSendRoleMessage,
    onStop: onStopRole,
    onDisconnect: onDisconnectRole,
    onRequestDiff,
    onRequestPermission,
    onGrantPermission,
    onDenyPermission,
    onSubmitAskUserQuestion,
    onSubmitPlanMode,
  } as const;

  return (
    <section className="harness-dashboard">
      <header className="harness-banner">
        <div className="harness-banner-copy">
          <p className="section-kicker">Harness Session</p>
          <h1>{session.title}</h1>
          <p>{state?.summary ?? 'This harness is ready to run.'}</p>
          {canRunHarness ? (
            <button
              type="button"
              className="mini-action primary"
              onClick={onRunHarness}
              disabled={isRunningHarness}
            >
              {isRunningHarness ? 'Running...' : 'Run Harness'}
            </button>
          ) : null}
        </div>
        <div className="harness-banner-meta">
          <div className="harness-meta-chip">
            <span>Status</span>
            <strong>{state?.status ?? 'ready'}</strong>
          </div>
          <div className="harness-meta-chip">
            <span>Owner</span>
            <strong>{state?.currentOwner ?? 'idle'}</strong>
          </div>
          <div className="harness-meta-chip">
            <span>Stage</span>
            <strong>{formatStageLabel(state?.currentStage ?? 'ready')}</strong>
          </div>
          <div className="harness-meta-chip">
            <span>Sprint</span>
            <strong>
              {state?.currentSprint ?? 0} / {state?.maxSprints ?? 0}
            </strong>
          </div>
        </div>
        <div className="harness-progress">
          <div className="harness-progress-bar">
            <div className="harness-progress-fill" style={{ width: formatPercent(progressPercent) }} />
          </div>
          <div className="harness-progress-meta">
            <span>
              {state?.status === 'completed' || state?.status === 'failed'
                ? `${state.completedTurns} turns completed`
                : `Progress ${state?.completedTurns ?? 0} / ${state?.totalTurns ?? 0}`}
            </span>
            <strong>{formatPercent(progressPercent)}</strong>
          </div>
          <div className="harness-progress-submeta">
            <span>Current round: {state?.currentRound ?? 0}</span>
            <span>Last decision: {state?.lastDecision ?? 'READY'}</span>
            <span>Completed sprints: {state?.completedSprints ?? 0}</span>
          </div>
        </div>
      </header>

      <div className="harness-role-grid">
        <RoleChatPane
          role="planner"
          session={plannerSession}
          active={state?.currentOwner === 'planner'}
          interaction={getInteraction(plannerSession)}
          {...sharedProps}
        />
        <RoleChatPane
          role="generator"
          session={generatorSession}
          active={state?.currentOwner === 'generator'}
          interaction={getInteraction(generatorSession)}
          {...sharedProps}
        />
        <RoleChatPane
          role="evaluator"
          session={evaluatorSession}
          active={state?.currentOwner === 'evaluator'}
          interaction={getInteraction(evaluatorSession)}
          {...sharedProps}
        />
      </div>
    </section>
  );
}
