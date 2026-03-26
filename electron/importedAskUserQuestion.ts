import { parseAskUserQuestions, type AskUserQuestion } from '../src/data/askUserQuestion.js';

type ImportedQuestionAnnotations = Record<string, { notes?: string }>;

export type ImportedAskUserQuestionDisplay = {
  title: string;
  content: string;
  hasExplicitAnswer: boolean;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const normalizeText = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const getDisplayTitle = (question: AskUserQuestion) =>
  question.header?.trim() || question.question?.trim() || 'Interactive question';

const getAnswerLabel = (rawAnswer: string, question: AskUserQuestion) => {
  const normalizedAnswer = rawAnswer.trim();
  if (!normalizedAnswer || !question.options?.length) {
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
    .map((token) => question.options?.[Number(token) - 1]?.label?.trim())
    .filter((label): label is string => Boolean(label));

  return labels.length === tokens.length ? labels.join(', ') : normalizedAnswer;
};

const parseFallbackAnswers = (fallbackText: string) => {
  const answers = new Map<string, string>();

  for (const match of fallbackText.matchAll(/"([^"]+)"="([^"]*)"/g)) {
    const question = match[1]?.trim();
    const answer = match[2]?.trim();
    if (question && answer) {
      answers.set(question, answer);
    }
  }

  const noteMatch = fallbackText.match(/user notes:\s*(.+?)(?:\. You can now continue|$)/i);
  return {
    answers,
    note: noteMatch?.[1]?.trim() ?? '',
  };
};

const renderQuestionPrompt = (question: AskUserQuestion) => {
  const lines: string[] = [];

  if (question.header) {
    lines.push(`### ${question.header}`);
  }

  lines.push(question.question ?? '');

  if ((question.options?.length ?? 0) > 0) {
    lines.push('');
    lines.push(question.multiSelect ? '可选项（可多选）:' : '可选项:');
    question.options?.forEach((option, index) => {
      const label = option.label?.trim() || `Option ${index + 1}`;
      const description = option.description?.trim();
      lines.push(`${index + 1}. ${description ? `${label} - ${description}` : label}`);
    });
  }

  return lines.join('\n').trim();
};

export const formatImportedAskUserQuestionPrompt = (input: unknown): ImportedAskUserQuestionDisplay | null => {
  const questions = parseAskUserQuestions(input);
  if (questions.length === 0) {
    return null;
  }

  return {
    title: getDisplayTitle(questions[0]!),
    content: questions.map(renderQuestionPrompt).join('\n\n'),
    hasExplicitAnswer: false,
  };
};

export const formatImportedAskUserQuestionAnswer = (
  toolUseResult: unknown,
  fallbackText = '',
): ImportedAskUserQuestionDisplay | null => {
  const record = asRecord(toolUseResult);
  const questions = parseAskUserQuestions(record);
  if (questions.length === 0) {
    return null;
  }

  const explicitAnswers = new Map<string, string>();
  const answerRecord = asRecord(record?.answers);
  if (answerRecord) {
    Object.entries(answerRecord).forEach(([question, answer]) => {
      const normalizedAnswer = normalizeText(answer);
      if (question.trim() && normalizedAnswer) {
        explicitAnswers.set(question.trim(), normalizedAnswer);
      }
    });
  }

  const fallback = parseFallbackAnswers(fallbackText);
  if (explicitAnswers.size === 0) {
    fallback.answers.forEach((answer, question) => {
      explicitAnswers.set(question, answer);
    });
  }

  const annotations = (asRecord(record?.annotations) ?? {}) as ImportedQuestionAnnotations;
  const noteFallback = fallback.note;
  const hasExplicitAnswer = explicitAnswers.size > 0;

  const content = questions
    .map((question) => {
      const lines: string[] = [];

      if (question.header) {
        lines.push(`### ${question.header}`);
      }

      lines.push(question.question ?? '');
      lines.push('');

      const rawAnswer = explicitAnswers.get(question.question ?? '');
      const note = normalizeText(annotations[question.question ?? '']?.notes) || noteFallback;

      if (rawAnswer) {
        lines.push(`回答：${getAnswerLabel(rawAnswer, question)}`);
      } else {
        lines.push('已通过交互式问题回答，但原始记录未保留答案详情。');
      }

      if (note) {
        lines.push(`备注：${note}`);
      }

      return lines.join('\n').trim();
    })
    .join('\n\n');

  return {
    title: getDisplayTitle(questions[0]!),
    content,
    hasExplicitAnswer,
  };
};
