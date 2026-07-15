type StreamworkTreeProject = {
  dreams: Array<{
    id: string;
    sessions: Array<{
      id: string;
    }>;
  }>;
};

type SessionOnlineIndicators = Record<string, { online?: boolean }>;

export const buildInitialCollapsedStreamworks = (
  projects: StreamworkTreeProject[],
  sessionIndicators: SessionOnlineIndicators,
) =>
  Object.fromEntries(
    projects.flatMap((project) =>
      project.dreams.map((streamwork) => [
        streamwork.id,
        !streamwork.sessions.some((session) => sessionIndicators[session.id]?.online),
      ]),
    ),
  );
