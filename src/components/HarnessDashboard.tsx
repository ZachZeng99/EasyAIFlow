import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { buildDisplayItems } from '../data/chatThreadDisplay';
import type { HarnessRole, SessionRecord, SessionSummary } from '../data/types';

type HarnessDashboardProps = {
  session: SessionSummary;
  plannerSession?: SessionRecord;
  generatorSession?: SessionRecord;
  evaluatorSession?: SessionRecord;
};

const roleTitles: Record<HarnessRole, string> = {
  planner: 'Planner',
  generator: 'Generator',
  evaluator: 'Evaluator',
};

const roleDescriptions: Record<HarnessRole, string> = {
  planner: 'Expand the ask into a coherent product and sprint plan.',
  generator: 'Turn the approved sprint into concrete implementation work.',
  evaluator: 'Review the sprint contract and validate the resulting work.',
};

const formatPercent = (value: number) => `${Math.max(0, Math.min(100, Math.round(value)))}%`;

const formatStageLabel = (value: string) =>
  value
    .split('-')
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ') || 'Idle';

const RolePane = ({
  role,
  session,
  active,
}: {
  role: HarnessRole;
  session?: SessionRecord;
  active: boolean;
}) => {
  const displayItems = buildDisplayItems(session?.messages ?? []);

  return (
    <article className={`harness-role-pane ${role}${active ? ' active' : ''}`}>
      <header className="harness-role-head">
        <div>
          <p className="section-kicker">{roleTitles[role]}</p>
          <h2>{session?.title ?? `${roleTitles[role]} waiting`}</h2>
        </div>
        <span className={`harness-role-badge ${active ? 'active' : ''}`}>{active ? 'Working' : 'Standby'}</span>
      </header>
      <p className="harness-role-copy">{roleDescriptions[role]}</p>
      <div className="harness-role-stream">
        {displayItems.length > 0 ? (
          displayItems.map((item) =>
            item.type === 'trace-group' ? (
              <section key={item.id} className="harness-trace-group">
                <div className="harness-trace-head">
                  <strong>Process</strong>
                  <span>{item.items.length} steps</span>
                </div>
                <div className="harness-trace-list">
                  {item.items.map((message) => (
                    <article key={message.id} className={`harness-trace-row ${message.kind ?? 'trace'}`}>
                      <div className="harness-trace-meta">
                        <span className={`trace-dot ${message.status ?? 'running'}`} />
                        <span>{message.timestamp}</span>
                        <span>{message.kind ?? 'trace'}</span>
                      </div>
                      <strong>{message.title}</strong>
                    </article>
                  ))}
                </div>
              </section>
            ) : (
              <article key={item.message.id} className={`harness-message-card ${item.message.role}`}>
                <div className="message-meta">
                  <span className={`message-role ${item.message.role}`}>
                    {item.message.role === 'user' ? 'You' : 'Claude'}
                  </span>
                  <span>{item.message.timestamp}</span>
                  {item.message.status ? (
                    <span className={`message-status ${item.message.status}`}>{item.message.status}</span>
                  ) : null}
                </div>
                {item.message.role === 'assistant' ? (
                  <div className="markdown-body harness-markdown">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.message.content}</ReactMarkdown>
                  </div>
                ) : (
                  <pre className="message-body">{item.message.content}</pre>
                )}
              </article>
            ),
          )
        ) : (
          <div className="harness-empty-state">No activity yet.</div>
        )}
      </div>
    </article>
  );
};

export function HarnessDashboard({
  session,
  plannerSession,
  generatorSession,
  evaluatorSession,
}: HarnessDashboardProps) {
  const state = session.harnessState;
  const progressPercent =
    state && state.totalTurns > 0 ? (state.completedTurns / state.totalTurns) * 100 : state?.status === 'ready' ? 0 : 0;

  return (
    <section className="harness-dashboard">
      <header className="harness-banner">
        <div className="harness-banner-copy">
          <p className="section-kicker">Harness Session</p>
          <h1>{session.title}</h1>
          <p>{state?.summary ?? 'This harness is ready to run.'}</p>
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
              Progress {state?.completedTurns ?? 0} / {state?.totalTurns ?? 0}
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
        <RolePane role="planner" session={plannerSession} active={state?.currentOwner === 'planner'} />
        <RolePane role="generator" session={generatorSession} active={state?.currentOwner === 'generator'} />
        <RolePane role="evaluator" session={evaluatorSession} active={state?.currentOwner === 'evaluator'} />
      </div>
    </section>
  );
}
