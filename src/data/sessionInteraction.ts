import type { AskUserQuestion } from './askUserQuestion.js';
import type { PlanModeRequest } from './planMode.js';

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
