export type ActiveClaudeRun<TChild> = {
  runId: string;
  sessionId: string;
  child: TChild;
  projectRoot: string;
};

export type ActiveClaudeRunRegistry<TChild> = Map<string, ActiveClaudeRun<TChild>>;

export const createActiveClaudeRunRegistry = <TChild>(): ActiveClaudeRunRegistry<TChild> =>
  new Map<string, ActiveClaudeRun<TChild>>();

export const addActiveClaudeRun = <TChild>(
  registry: ActiveClaudeRunRegistry<TChild>,
  run: ActiveClaudeRun<TChild>,
) => {
  registry.set(run.runId, run);
  return run;
};

export const removeActiveClaudeRun = <TChild>(
  registry: ActiveClaudeRunRegistry<TChild>,
  runId: string,
) => registry.delete(runId);

export const listActiveClaudeRunsForSession = <TChild>(
  registry: ActiveClaudeRunRegistry<TChild>,
  sessionId: string,
) => [...registry.values()].filter((run) => run.sessionId === sessionId);
