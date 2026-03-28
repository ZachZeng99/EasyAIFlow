export type PlanModeToolName = 'EnterPlanMode' | 'ExitPlanMode';

export type PlanModeAllowedPrompt = {
  tool: string;
  prompt: string;
};

export type PlanModeRequest = {
  toolUseId: string;
  toolName: PlanModeToolName;
  plan: string;
  allowedPrompts: PlanModeAllowedPrompt[];
  planFilePath?: string;
};

export type PlanModeApprovalMode =
  | 'approve_clear_context_accept_edits'
  | 'approve_accept_edits'
  | 'approve_manual'
  | 'revise';

export type PlanModeResponsePayload = {
  mode: PlanModeApprovalMode;
  selectedPromptIndex?: number;
  notes?: string;
};

const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const getString = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : '');

export const isPlanModeToolName = (value: unknown): value is PlanModeToolName =>
  value === 'EnterPlanMode' || value === 'ExitPlanMode';

export const parsePlanModeAllowedPrompts = (value: unknown): PlanModeAllowedPrompt[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      const parsed = asObject(item);
      const tool = getString(parsed?.tool);
      const prompt = getString(parsed?.prompt);
      if (!tool || !prompt) {
        return null;
      }

      return {
        tool,
        prompt,
      } satisfies PlanModeAllowedPrompt;
    })
    .filter((item): item is PlanModeAllowedPrompt => Boolean(item));
};

export const parsePlanModeRequest = (payload: {
  toolName: unknown;
  toolUseId: unknown;
  input: unknown;
}): PlanModeRequest | null => {
  if (!isPlanModeToolName(payload.toolName) || typeof payload.toolUseId !== 'string' || !payload.toolUseId.trim()) {
    return null;
  }

  const input = asObject(payload.input);
  const planFilePath = getString(input?.planFilePath) || getString(input?.plan_file_path) || undefined;

  return {
    toolUseId: payload.toolUseId,
    toolName: payload.toolName,
    plan: getString(input?.plan),
    allowedPrompts: parsePlanModeAllowedPrompts(input?.allowedPrompts),
    ...(planFilePath ? { planFilePath } : {}),
  };
};

export const getSelectedPlanModePrompt = (
  request: Pick<PlanModeRequest, 'allowedPrompts'>,
  payload: Pick<PlanModeResponsePayload, 'selectedPromptIndex'>,
) => {
  const prompts = request.allowedPrompts ?? [];
  if (prompts.length === 0) {
    return undefined;
  }

  const selectedIndex =
    typeof payload.selectedPromptIndex === 'number' &&
    payload.selectedPromptIndex >= 0 &&
    payload.selectedPromptIndex < prompts.length
      ? payload.selectedPromptIndex
      : 0;

  return {
    index: selectedIndex,
    prompt: prompts[selectedIndex],
  };
};

export const buildPlanModeTraceContent = (request: PlanModeRequest) => {
  if (request.toolName === 'EnterPlanMode') {
    return 'Plan mode entered.\n\nClaude should present a complete plan for review before making edits.';
  }

  const sections: string[] = [];
  if (request.plan) {
    sections.push(request.plan);
  }

  if (request.allowedPrompts.length > 0) {
    sections.push(
      `## Execution Options\n${request.allowedPrompts
        .map((item, index) => `${index + 1}. \`${item.tool}\` - ${item.prompt}`)
        .join('\n')}`,
    );
  } else {
    sections.push('## Execution Options\nNo explicit execution options were provided.');
  }

  return sections.join('\n\n').trim();
};

export const buildPlanModeEnteredText = () =>
  'EasyAIFlow entered plan mode. Present the full plan for user review before making changes, then call ExitPlanMode when you are ready for approval.';

export const buildPlanModeResponseText = (
  request: PlanModeRequest,
  payload: PlanModeResponsePayload,
) => {
  const notes = payload.notes?.trim();

  if (request.toolName === 'EnterPlanMode') {
    return buildPlanModeEnteredText();
  }

  if (payload.mode === 'approve_clear_context_accept_edits') {
    return [
      'User has approved your plan.',
      'Start implementation with a fresh execution pass and treat file edits as auto-approved.',
      notes ? `User notes: ${notes}` : '',
      'Start with updating your todo list if applicable.',
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (payload.mode === 'approve_accept_edits') {
    return [
      'User has approved your plan.',
      'You can now start coding and treat file edits as auto-approved for this execution.',
      notes ? `User notes: ${notes}` : '',
      'Start with updating your todo list if applicable.',
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (payload.mode === 'approve_manual') {
    return [
      'User has approved your plan.',
      'You can now start coding, but continue requesting approval before making edits.',
      notes ? `User notes: ${notes}` : '',
      'Start with updating your todo list if applicable.',
    ]
      .filter(Boolean)
      .join(' ');
  }

  if (payload.mode === 'revise') {
    return [
      'The user wants changes before execution.',
      notes ? `Requested changes: ${notes}` : 'Stay in plan mode and revise the plan.',
      'Do not start implementation yet.',
    ]
      .filter(Boolean)
      .join(' ');
  }

  return 'Stay in plan mode and revise the plan.';
};

export const buildPlanModeFollowUpPrompt = (
  request: PlanModeRequest,
  payload: PlanModeResponsePayload,
) => {
  if (request.toolName === 'EnterPlanMode') {
    return buildPlanModeEnteredText();
  }

  const selected =
    payload.mode === 'approve_clear_context_accept_edits' ||
    payload.mode === 'approve_accept_edits' ||
    payload.mode === 'approve_manual'
      ? getSelectedPlanModePrompt(request, payload)
      : undefined;
  const lines = [
    'Plan review decision:',
    `- Decision: ${payload.mode}`,
    selected ? `- Execution option: ${selected.prompt.tool} -> ${selected.prompt.prompt}` : '',
    payload.notes?.trim() ? `- Notes: ${payload.notes.trim()}` : '',
    '',
    'Apply this decision to the current plan and continue accordingly.',
  ].filter(Boolean);

  return lines.join('\n');
};
