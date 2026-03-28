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
  askUserQuestion?: SessionAskUserQuestion;
  planModeRequest?: SessionPlanModeRequest;
  isGrantingPermission?: boolean;
  isSubmittingAskUserQuestion?: boolean;
  isSubmittingPlanMode?: boolean;
};
