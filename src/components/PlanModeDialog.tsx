import { useState } from 'react';

import type { PlanModeRequest, PlanModeResponsePayload, PlanModeApprovalMode } from '../data/planMode';

type PlanModeDialogProps = {
  open: boolean;
  request: PlanModeRequest | null;
  busy: boolean;
  onSubmit: (payload: PlanModeResponsePayload) => void;
};

const options: Array<{
  id: PlanModeApprovalMode;
  title: string;
  description: string;
}> = [
  {
    id: 'approve_clear_context_accept_edits',
    title: 'Yes, clear context and auto-accept edits',
    description: 'Continue with a fresh context window and proceed automatically.',
  },
  {
    id: 'approve_accept_edits',
    title: 'Yes, auto-accept edits',
    description: 'Continue with the current plan and let Claude proceed directly.',
  },
  {
    id: 'approve_manual',
    title: 'Yes, manually approve edits',
    description: 'Continue with the current plan but keep later file edits gated by approval.',
  },
  {
    id: 'revise',
    title: 'Tell Claude what to change',
    description: 'Reject the current plan and send revision instructions back to Claude.',
  },
];

export function PlanModeDialog({
  open,
  request,
  busy,
  onSubmit,
}: PlanModeDialogProps) {
  const [mode, setMode] = useState<PlanModeApprovalMode>('approve_accept_edits');
  const [notes, setNotes] = useState('');

  if (!open || !request) {
    return null;
  }

  const requiresNotes = mode === 'revise';
  const isEnter = request.toolName === 'EnterPlanMode';

  return (
    <div className="dialog-backdrop" role="presentation" onClick={() => onSubmit({ mode: 'revise', notes: 'User cancelled the plan review dialog.' })}>
      <section
        className="dialog-card plan-mode-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Plan mode review"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <h2>{isEnter ? 'Plan Mode Proposal' : 'Ready To Exit Plan Mode'}</h2>
        </div>
        <div className="dialog-body plan-mode-body">
          <p className="dialog-description">
            Claude has prepared a plan. Review it below and choose how to proceed.
          </p>
          {request.planFilePath ? (
            <p className="dialog-description">Plan file: <code>{request.planFilePath}</code></p>
          ) : null}
          <pre className="message-body plan-mode-preview">{request.plan || 'Claude is preparing a plan preview.'}</pre>
          {request.allowedPrompts.length > 0 ? (
            <div className="plan-mode-allowed-list">
              <span>Allowed prompts in this execution pass</span>
              {request.allowedPrompts.map((item, index) => (
                <code key={`${item.tool}-${index}`}>
                  {item.tool}: {item.prompt}
                </code>
              ))}
            </div>
          ) : null}
          <div className="plan-mode-options">
            {options.map((option) => (
              <label key={option.id} className={`plan-mode-option${mode === option.id ? ' active' : ''}`}>
                <input
                  type="radio"
                  name="plan-mode-choice"
                  checked={mode === option.id}
                  onChange={() => setMode(option.id)}
                />
                <div>
                  <strong>{option.title}</strong>
                  <span>{option.description}</span>
                </div>
              </label>
            ))}
          </div>
          {requiresNotes ? (
            <div className="dialog-field">
              <span>Revision Notes</span>
              <textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Tell Claude what to change in the plan."
                rows={4}
              />
            </div>
          ) : null}
        </div>
        <div className="dialog-actions">
          <button
            type="button"
            className="dialog-button secondary"
            onClick={() => onSubmit({ mode: 'revise', notes: 'User cancelled the plan review dialog.' })}
          >
            Cancel
          </button>
          <button
            type="button"
            className="dialog-button primary"
            onClick={() => onSubmit({ mode, notes: notes.trim() || undefined })}
            disabled={busy || (requiresNotes && !notes.trim())}
          >
            {busy ? 'Applying...' : requiresNotes ? 'Send Feedback' : 'Continue'}
          </button>
        </div>
      </section>
    </div>
  );
}
