import { useEffect, useRef, useState } from 'react';
import {
  buildAskUserQuestionDraftFromFormData,
  buildAskUserQuestionResponsePayload,
  hasAskUserQuestionResponse,
  type AskUserQuestion,
  type AskUserQuestionDraft,
} from '../data/askUserQuestion';

type InlineAskUserQuestionCardProps = {
  toolUseId: string;
  questions: AskUserQuestion[];
  busy: boolean;
  onSkip: () => void;
  onSubmit: (draft: AskUserQuestionDraft) => void;
};

export function InlineAskUserQuestionCard({
  toolUseId,
  questions,
  busy,
  onSkip,
  onSubmit,
}: InlineAskUserQuestionCardProps) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const [canSubmit, setCanSubmit] = useState(false);

  useEffect(() => {
    setCanSubmit(false);
  }, [toolUseId]);

  const collectDraft = () => {
    const form = formRef.current;
    if (!form) {
      return { selectedOptions: {}, customAnswers: {} } satisfies AskUserQuestionDraft;
    }
    return buildAskUserQuestionDraftFromFormData(questions, new FormData(form));
  };

  const syncSubmitState = () => {
    const draft = collectDraft();
    const response = buildAskUserQuestionResponsePayload(questions, draft);
    setCanSubmit(hasAskUserQuestionResponse(response));
  };

  return (
    <article className="inline-interaction-card">
      <div className="dialog-head">
        <h2>Claude Needs Your Input</h2>
      </div>
      <form
        key={toolUseId}
        ref={formRef}
        className="dialog-body ask-user-dialog-body"
        onChange={syncSubmitState}
        onSubmit={(event) => {
          event.preventDefault();
          const draft = collectDraft();
          const response = buildAskUserQuestionResponsePayload(questions, draft);
          if (!hasAskUserQuestionResponse(response) || busy) return;
          onSubmit(draft);
        }}
      >
        <p className="dialog-description">
          Claude asked a follow-up question before it can continue. Pick an option, type a custom answer, or do both.
        </p>

        {questions.map((question, questionIndex) => (
          <section key={question.question} className="ask-user-question-block">
            {question.header ? <p className="ask-user-question-header">{question.header}</p> : null}
            <h3 className="ask-user-question-title">
              {questionIndex + 1}. {question.question}
            </h3>

            {question.options.length > 0 ? (
              <div className="ask-user-option-list">
                {question.options.map((option, optionIndex) => {
                  const choiceIndex = optionIndex + 1;
                  return (
                    <label key={`${question.question}-${choiceIndex}`} className="dialog-toggle ask-user-option">
                      <input
                        type={question.multiSelect ? 'checkbox' : 'radio'}
                        name={`selection-${questionIndex}`}
                        value={String(choiceIndex)}
                      />
                      <div>
                        <strong>{option.label || `Option ${choiceIndex}`}</strong>
                        {option.description ? <span>{option.description}</span> : null}
                      </div>
                    </label>
                  );
                })}
              </div>
            ) : null}

            <label className="dialog-field">
              <span>Custom Answer</span>
              <input
                type="text"
                name={`notes-${questionIndex}`}
                placeholder="Type a specific answer or extra notes"
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && canSubmit && !busy) {
                    event.preventDefault();
                    const draft = collectDraft();
                    const response = buildAskUserQuestionResponsePayload(questions, draft);
                    if (hasAskUserQuestionResponse(response)) {
                      onSubmit(draft);
                    }
                  }
                }}
              />
            </label>
          </section>
        ))}
      </form>
      <div className="dialog-actions ask-user-dialog-actions">
        <button type="button" className="dialog-button secondary" onClick={onSkip} disabled={busy}>
          Skip
        </button>
        <button
          type="button"
          className="dialog-button primary"
          onClick={() => {
            const draft = collectDraft();
            const response = buildAskUserQuestionResponsePayload(questions, draft);
            if (!hasAskUserQuestionResponse(response) || busy) return;
            onSubmit(draft);
          }}
          disabled={busy || !canSubmit}
        >
          {busy ? 'Submitting...' : 'Submit Answer'}
        </button>
      </div>
    </article>
  );
}
