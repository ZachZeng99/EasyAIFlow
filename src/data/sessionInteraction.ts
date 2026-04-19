import type { AskUserQuestion } from './askUserQuestion.js';
import type { PlanModeRequest } from './planMode.js';
import type { BackgroundTaskRecord, SessionRuntimePhase, SessionRuntimeState } from './types.js';

export type SessionPermissionRequest = {
  path: string;
  sensitive: boolean;
  requestId?: string;
  sessionId: string;
};

export type SessionAskUserQuestion = {
  sessionId: string;
  toolUseId: string;
  questions: AskUserQuestion[];
};

export type SessionPlanModeRequest = {
  sessionId: string;
  request: PlanModeRequest;
};

export type SessionInteractionState = {
  permission?: SessionPermissionRequest;
  pendingPermissions?: SessionPermissionRequest[];
  askUserQuestion?: SessionAskUserQuestion;
  planModeRequest?: SessionPlanModeRequest;
  backgroundTasks?: BackgroundTaskRecord[];
  runtime?: SessionRuntimeState;
  isGrantingPermission?: boolean;
  isSubmittingAskUserQuestion?: boolean;
  isSubmittingPlanMode?: boolean;
};

const isSamePermissionRequest = (
  left: SessionPermissionRequest,
  right: SessionPermissionRequest,
) => {
  if (left.requestId && right.requestId) {
    return left.requestId === right.requestId;
  }

  return (
    left.sessionId === right.sessionId &&
    left.path === right.path &&
    left.sensitive === right.sensitive
  );
};

export const getActiveSessionPermissionRequest = (
  state?: SessionInteractionState,
) => state?.permission ?? state?.pendingPermissions?.[0];

export const enqueueSessionPermissionRequest = (
  state: SessionInteractionState,
  request: SessionPermissionRequest,
): SessionInteractionState => {
  const active = getActiveSessionPermissionRequest(state);
  if (active && isSamePermissionRequest(active, request)) {
    return state;
  }

  const pendingPermissions = state.pendingPermissions ?? [];
  if (pendingPermissions.some((item) => isSamePermissionRequest(item, request))) {
    return state;
  }

  if (!active) {
    return {
      ...state,
      permission: request,
    };
  }

  return {
    ...state,
    permission: active,
    pendingPermissions: [...pendingPermissions, request],
  };
};

export const advanceSessionPermissionRequest = (
  state: SessionInteractionState,
): SessionInteractionState => {
  const [nextPermission, ...remaining] = state.pendingPermissions ?? [];

  return {
    ...state,
    permission: nextPermission,
    pendingPermissions: remaining.length > 0 ? remaining : undefined,
    isGrantingPermission: false,
  };
};

export const upsertSessionBackgroundTask = (
  state: SessionInteractionState,
  task: BackgroundTaskRecord,
): SessionInteractionState => {
  const tasks = [...(state.backgroundTasks ?? [])];
  const existingIndex = tasks.findIndex((candidate) => candidate.taskId === task.taskId);
  if (existingIndex >= 0) {
    tasks[existingIndex] = {
      ...tasks[existingIndex],
      ...task,
    };
  } else {
    tasks.unshift(task);
  }

  tasks.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));

  return {
    ...state,
    backgroundTasks: tasks.slice(0, 24),
  };
};

export const clearSessionBackgroundTasks = (
  state: SessionInteractionState,
): SessionInteractionState => ({
  ...state,
  backgroundTasks: undefined,
});

const pruneActiveBackgroundTasks = (
  tasks: BackgroundTaskRecord[] | undefined,
): BackgroundTaskRecord[] | undefined => {
  if (!tasks) {
    return undefined;
  }

  const next = tasks.filter(
    (task) => task.status !== 'pending' && task.status !== 'running',
  );
  return next.length > 0 ? next : undefined;
};

export const setSessionRuntimeState = (
  state: SessionInteractionState,
  runtime: SessionRuntimeState,
): SessionInteractionState => ({
  ...state,
  backgroundTasks:
    runtime.phase === 'background'
      ? state.backgroundTasks
      : pruneActiveBackgroundTasks(state.backgroundTasks),
  runtime: {
    ...(state.runtime ?? {}),
    ...runtime,
  },
});

const runtimePhasePriority: Record<SessionRuntimePhase, number> = {
  awaiting_reply: 6,
  background: 5,
  running: 4,
  terminating: 3,
  idle: 2,
  inactive: 1,
};

const compareRuntimeStates = (left: SessionRuntimeState, right: SessionRuntimeState) => {
  const priorityDiff = runtimePhasePriority[right.phase] - runtimePhasePriority[left.phase];
  if (priorityDiff !== 0) {
    return priorityDiff;
  }

  return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
};

export const mergeSessionRuntimeStates = (
  states: Array<SessionRuntimeState | undefined>,
): SessionRuntimeState | undefined => {
  const present = states.filter((state): state is SessionRuntimeState => Boolean(state));
  if (present.length === 0) {
    return undefined;
  }

  const online = present.filter((state) => state.processActive);
  const candidates = online.length > 0 ? online : present;
  const [selected] = [...candidates].sort(compareRuntimeStates);
  if (!selected) {
    return undefined;
  }

  return {
    ...selected,
    processActive: online.length > 0,
    updatedAt: Math.max(...present.map((state) => state.updatedAt ?? 0)),
  };
};

export const mergeGroupRoomRuntimeState = (
  roomState: SessionRuntimeState | undefined,
  participantStates: Array<SessionRuntimeState | undefined>,
): SessionRuntimeState | undefined => {
  const presentParticipants = participantStates.filter(
    (state): state is SessionRuntimeState => Boolean(state),
  );

  if (presentParticipants.length > 0) {
    return mergeSessionRuntimeStates(presentParticipants);
  }

  return roomState;
};
