import { useState } from 'react';

import type { PlanModeAllowedPrompt } from '../data/types';

export type PlanModeDialogChoice = 'clear-auto' | 'auto' | 'manual' | 'revise';

type PlanModeDialogProps = {
  open: boolean;
  mode: 'enter' | 'exit';
  planText: string;
  planFilePath?: string;
  allowedPrompts: PlanModeAllowedPrompt[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (choice: PlanModeDialogChoice, notes?: string) => void;
};

const options: Array<{
  id: PlanModeDialogChoice;
  title: string;
  description: string;
}> = [
  {
    id: 'clear-auto',
    title: 'Yes, clear context and auto-accept edits',
    description: 'Continue with a fresh context window and proceed automatically.',
  },
  {
    id: 'auto',
    title: 'Yes, auto-accept edits',
    description: 'Continue with the current plan and let Claude proceed directly.',
  },
  {
    id: 'manual',
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
  mode,
  planText,
  planFilePath,
  allowedPrompts,
  busy,
  onCancel,
  onSubmit,
}: PlanModeDialogProps) {
  const [choice, setChoice] = useState<PlanModeDialogChoice>('auto');
  const [notes, setNotes] = useState('');

  if (!open) {
    return null;
  }

  const requiresNotes = choice === 'revise';

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onCancel}>
      <section
        className="dialog-card plan-mode-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Plan mode review"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <h2>{mode === 'enter' ? 'Plan Mode Proposal' : 'Ready To Exit Plan Mode'}</h2>
        </div>
        <div className="dialog-body plan-mode-body">
          <p className="dialog-description">
            Claude has prepared a plan. Review it below and choose how to proceed.
          </p>
          {planFilePath ? (
            <p className="dialog-description">Plan file: <code>{planFilePath}</code></p>
          ) : null}
          <pre className="message-body plan-mode-preview">{planText || 'Claude is preparing a plan preview.'}</pre>
          {allowedPrompts.length > 0 ? (
            <div className="plan-mode-allowed-list">
              <span>Allowed prompts in this execution pass</span>
              {allowedPrompts.map((item, index) => (
                <code key={`${item.tool}-${index}`}>
                  {item.tool}: {item.prompt}
                </code>
              ))}
            </div>
          ) : null}
          <div className="plan-mode-options">
            {options.map((option) => (
              <label key={option.id} className={`plan-mode-option${choice === option.id ? ' active' : ''}`}>
                <input
                  type="radio"
                  name="plan-mode-choice"
                  checked={choice === option.id}
                  onChange={() => setChoice(option.id)}
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
          <button type="button" className="dialog-button secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="dialog-button primary"
            onClick={() => onSubmit(choice, notes)}
            disabled={busy || (requiresNotes && !notes.trim())}
          >
            {busy ? 'Applying...' : requiresNotes ? 'Send Feedback' : 'Continue'}
          </button>
        </div>
      </section>
    </div>
  );
}
