export type AskUserQuestionOption = {
  label: string;
  description: string;
};

export type AskUserQuestion = {
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect: boolean;
};

export type AskUserQuestionAnnotations = Record<string, { notes?: string }>;

export type AskUserQuestionResponsePayload = {
  answers: Record<string, string>;
  annotations: AskUserQuestionAnnotations;
};

export type AskUserQuestionDraft = {
  selectedOptions: Record<string, number[]>;
  customAnswers: Record<string, string>;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const normalizeText = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const normalizeQuestions = (value: unknown): AskUserQuestion[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      question: normalizeText(item.question),
      header: normalizeText(item.header),
      options: Array.isArray(item.options)
        ? item.options
            .map((option) => asRecord(option))
            .filter((option): option is Record<string, unknown> => Boolean(option))
            .map((option) => ({
              label: normalizeText(option.label),
              description: normalizeText(option.description),
            }))
        : [],
      multiSelect: item.multiSelect === true,
    }))
    .filter((item) => item.question);
};

const normalizeSelectedOptions = (values: number[] | undefined, max: number, multiSelect: boolean) => {
  const normalized = [...new Set((values ?? []).filter((value) => Number.isInteger(value) && value >= 1 && value <= max))]
    .sort((left, right) => left - right);

  if (!multiSelect && normalized.length > 1) {
    return normalized.slice(0, 1);
  }

  return normalized;
};

export const parseAskUserQuestions = (input: unknown): AskUserQuestion[] => {
  const record = asRecord(input);
  return normalizeQuestions(record?.questions);
};

export const extractAskUserQuestionResponsePayload = (input: unknown): AskUserQuestionResponsePayload => {
  const record = asRecord(input);
  const answersRecord = asRecord(record?.answers);
  const annotationsRecord = asRecord(record?.annotations);
  const answers: Record<string, string> = {};
  const annotations: AskUserQuestionAnnotations = {};

  Object.entries(answersRecord ?? {}).forEach(([question, answer]) => {
    const normalizedAnswer = normalizeText(answer);
    if (question.trim() && normalizedAnswer) {
      answers[question.trim()] = normalizedAnswer;
    }
  });

  Object.entries(annotationsRecord ?? {}).forEach(([question, value]) => {
    const note = normalizeText(asRecord(value)?.notes);
    if (question.trim() && note) {
      annotations[question.trim()] = { notes: note };
    }
  });

  return {
    answers,
    annotations,
  };
};

export const buildAskUserQuestionDraftFromFormData = (
  questions: AskUserQuestion[],
  formData: FormData,
): AskUserQuestionDraft => {
  const selectedOptions: Record<string, number[]> = {};
  const customAnswers: Record<string, string> = {};

  questions.forEach((question, index) => {
    const selectionKey = `selection-${index}`;
    const noteKey = `notes-${index}`;
    const selectedValues = formData
      .getAll(selectionKey)
      .map((value) => (typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN))
      .filter((value) => Number.isInteger(value));
    const customAnswer = normalizeText(formData.get(noteKey));

    if (selectedValues.length > 0) {
      selectedOptions[question.question] = selectedValues;
    }

    if (customAnswer) {
      customAnswers[question.question] = customAnswer;
    }
  });

  return {
    selectedOptions,
    customAnswers,
  };
};

export const buildAskUserQuestionResponsePayload = (
  questions: AskUserQuestion[],
  draft: AskUserQuestionDraft,
): AskUserQuestionResponsePayload => {
  const answers: Record<string, string> = {};
  const annotations: AskUserQuestionAnnotations = {};

  questions.forEach((question) => {
    const selectedOptions = normalizeSelectedOptions(
      draft.selectedOptions[question.question],
      question.options.length,
      question.multiSelect,
    );
    const customAnswer = normalizeText(draft.customAnswers[question.question]);

    if (customAnswer) {
      if (selectedOptions.length > 0) {
        answers[question.question] = question.multiSelect
          ? selectedOptions.join('+')
          : String(selectedOptions[0]);
      } else {
        answers[question.question] = customAnswer;
      }

      annotations[question.question] = {
        notes: customAnswer,
      };
      return;
    }

    if (selectedOptions.length > 0) {
      answers[question.question] = question.multiSelect
        ? selectedOptions.join('+')
        : String(selectedOptions[0]);
    }
  });

  return {
    answers,
    annotations,
  };
};

export const hasAskUserQuestionResponse = (response: AskUserQuestionResponsePayload) =>
  Object.keys(response.answers).length > 0 ||
  Object.values(response.annotations).some((annotation) => normalizeText(annotation.notes).length > 0);

const formatAskUserQuestionAnswer = (question: AskUserQuestion, rawAnswer: string) => {
  const normalizedAnswer = rawAnswer.trim();
  if (!normalizedAnswer || question.options.length === 0) {
    return normalizedAnswer;
  }

  const tokens = normalizedAnswer
    .split(/[+,，、/\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0 || !tokens.every((token) => /^\d+$/.test(token))) {
    return normalizedAnswer;
  }

  const labels = tokens
    .map((token) => question.options[Number(token) - 1]?.label?.trim())
    .filter((label): label is string => Boolean(label));

  return labels.length === tokens.length ? labels.join(', ') : normalizedAnswer;
};

export const buildAskUserQuestionResultText = (
  questions: AskUserQuestion[],
  response: AskUserQuestionResponsePayload,
) => {
  const answerPairs = questions
    .map((question) => {
      const answer = normalizeText(response.answers[question.question]);
      return answer ? `"${question.question}"="${answer}"` : '';
    })
    .filter(Boolean)
    .join(' ');

  const noteText = questions
    .map((question) => normalizeText(response.annotations[question.question]?.notes))
    .filter(Boolean)
    .join(' | ');

  const answerSegment = answerPairs ? ` ${answerPairs}` : ' ';
  const noteSegment = noteText ? ` user notes: ${noteText}.` : '.';
  return `User has answered your questions:${answerSegment}${noteSegment} You can now continue with the user's answers in mind.`;
};

export const buildAskUserQuestionFollowUpPrompt = (
  questions: AskUserQuestion[],
  response: AskUserQuestionResponsePayload,
) => {
  if (!hasAskUserQuestionResponse(response)) {
    return [
      'I skipped the interactive questionnaire.',
      'Continue the previous task using your best assumptions.',
      'Do not call AskUserQuestion again for the same missing details.',
    ].join('\n');
  }

  const lines = questions
    .map((question) => {
      const answer = normalizeText(response.answers[question.question]);
      const note = normalizeText(response.annotations[question.question]?.notes);
      if (!answer && !note) {
        return '';
      }

      const label = question.header || question.question;
      const parts: string[] = [];
      if (answer) {
        parts.push(formatAskUserQuestionAnswer(question, answer));
      }
      if (note && note !== answer) {
        parts.push(`note: ${note}`);
      }
      return `${label}: ${parts.join(' | ')}`;
    })
    .filter(Boolean);

  return [
    'Continue the previous task using my answers to your clarification questions:',
    ...lines.map((line) => `- ${line}`),
    '',
    'Do not call AskUserQuestion again for these already-answered questions.',
  ].join('\n');
};
