import assert from 'node:assert/strict';
import {
  buildAskUserQuestionFollowUpPrompt,
  buildAskUserQuestionDraftFromFormData,
  buildAskUserQuestionResponsePayload,
  buildAskUserQuestionResultText,
  extractAskUserQuestionResponsePayload,
  hasAskUserQuestionResponse,
  parseAskUserQuestions,
  type AskUserQuestion,
} from '../src/data/askUserQuestion.ts';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

const sampleQuestions: AskUserQuestion[] = [
  {
    header: 'Integration',
    question: '你希望 agent 通过什么方式与 Jenkins 交互？',
    options: [
      { label: 'MCP Server', description: '最原生的集成方式' },
      { label: 'Claude Code Skill', description: '通过 curl 或 CLI 调 Jenkins API' },
      { label: '不确定，帮我分析', description: '帮我做方案对比' },
    ],
    multiSelect: false,
  },
  {
    header: 'Operations',
    question: '你需要 agent 执行哪些 Jenkins 操作？',
    options: [
      { label: '触发 Job + 查状态', description: '查询构建状态' },
      { label: '获取日志', description: '分析失败原因' },
      { label: '参数化构建', description: '支持分支和平台参数' },
    ],
    multiSelect: true,
  },
];

run('parseAskUserQuestions extracts normalized questions from tool input', () => {
  const questions = parseAskUserQuestions({
    questions: [
      {
        question: ' 你的 Jenkins 环境是怎样的？ ',
        header: ' Jenkins env ',
        options: [
          { label: ' 内网 Jenkins ', description: ' 本机可访问 HTTP API ' },
          { label: ' 云端 Jenkins ', description: ' 需要 VPN 或公网访问 ' },
        ],
        multiSelect: false,
      },
    ],
  });

  assert.deepEqual(questions, [
    {
      question: '你的 Jenkins 环境是怎样的？',
      header: 'Jenkins env',
      options: [
        { label: '内网 Jenkins', description: '本机可访问 HTTP API' },
        { label: '云端 Jenkins', description: '需要 VPN 或公网访问' },
      ],
      multiSelect: false,
    },
  ]);
});

run('buildAskUserQuestionResponsePayload encodes option selections and freeform notes', () => {
  const response = buildAskUserQuestionResponsePayload(sampleQuestions, {
    selectedOptions: {
      '你希望 agent 通过什么方式与 Jenkins 交互？': [1],
      '你需要 agent 执行哪些 Jenkins 操作？': [3, 2, 2],
    },
    customAnswers: {
      '你需要 agent 执行哪些 Jenkins 操作？': '先做 Windows + PS5 两个平台',
    },
  });

  assert.deepEqual(response, {
    answers: {
      '你希望 agent 通过什么方式与 Jenkins 交互？': '1',
      '你需要 agent 执行哪些 Jenkins 操作？': '2+3',
    },
    annotations: {
      '你需要 agent 执行哪些 Jenkins 操作？': {
        notes: '先做 Windows + PS5 两个平台',
      },
    },
  });
});

run('buildAskUserQuestionDraftFromFormData reads radio, checkbox, and note fields', () => {
  const formData = new FormData();
  formData.append('selection-0', '2');
  formData.append('selection-1', '1');
  formData.append('selection-1', '4');
  formData.append('notes-1', '先做最常用的一条链路');

  const draft = buildAskUserQuestionDraftFromFormData(sampleQuestions, formData);

  assert.deepEqual(draft, {
    selectedOptions: {
      '你希望 agent 通过什么方式与 Jenkins 交互？': [2],
      '你需要 agent 执行哪些 Jenkins 操作？': [1, 4],
    },
    customAnswers: {
      '你需要 agent 执行哪些 Jenkins 操作？': '先做最常用的一条链路',
    },
  });
});

run('buildAskUserQuestionResponsePayload uses freeform answers when no option is selected', () => {
  const response = buildAskUserQuestionResponsePayload(sampleQuestions, {
    selectedOptions: {},
    customAnswers: {
      '你希望 agent 通过什么方式与 Jenkins 交互？': '通过现有内网网关代理 Jenkins API',
    },
  });

  assert.deepEqual(response, {
    answers: {
      '你希望 agent 通过什么方式与 Jenkins 交互？': '通过现有内网网关代理 Jenkins API',
    },
    annotations: {
      '你希望 agent 通过什么方式与 Jenkins 交互？': {
        notes: '通过现有内网网关代理 Jenkins API',
      },
    },
  });
});

run('hasAskUserQuestionResponse reports whether the dialog has any usable answer', () => {
  assert.equal(
    hasAskUserQuestionResponse({
      answers: {},
      annotations: {},
    }),
    false,
  );

  assert.equal(
    hasAskUserQuestionResponse({
      answers: {
        '你希望 agent 通过什么方式与 Jenkins 交互？': '1',
      },
      annotations: {},
    }),
    true,
  );
});

run('buildAskUserQuestionResultText serializes answers in Claude-compatible fallback format', () => {
  const text = buildAskUserQuestionResultText(sampleQuestions, {
    answers: {
      '你希望 agent 通过什么方式与 Jenkins 交互？': '1',
      '你需要 agent 执行哪些 Jenkins 操作？': '2+3',
    },
    annotations: {
      '你需要 agent 执行哪些 Jenkins 操作？': {
        notes: '先做 Windows + PS5 两个平台',
      },
    },
  });

  assert.equal(
    text,
    'User has answered your questions: "你希望 agent 通过什么方式与 Jenkins 交互？"="1" "你需要 agent 执行哪些 Jenkins 操作？"="2+3" user notes: 先做 Windows + PS5 两个平台. You can now continue with the user\'s answers in mind.',
  );
});

run('extractAskUserQuestionResponsePayload reads structured answers from toolUseResult', () => {
  const response = extractAskUserQuestionResponsePayload({
    questions: sampleQuestions,
    answers: {
      '你希望 agent 通过什么方式与 Jenkins 交互？': '2',
    },
    annotations: {
      '你需要 agent 执行哪些 Jenkins 操作？': {
        notes: '先做最常用的一条链路',
      },
    },
  });

  assert.deepEqual(response, {
    answers: {
      '你希望 agent 通过什么方式与 Jenkins 交互？': '2',
    },
    annotations: {
      '你需要 agent 执行哪些 Jenkins 操作？': {
        notes: '先做最常用的一条链路',
      },
    },
  });
});

run('buildAskUserQuestionFollowUpPrompt formats option labels for fallback continuation', () => {
  const prompt = buildAskUserQuestionFollowUpPrompt(sampleQuestions, {
    answers: {
      '你希望 agent 通过什么方式与 Jenkins 交互？': '1',
      '你需要 agent 执行哪些 Jenkins 操作？': '2+3',
    },
    annotations: {
      '你需要 agent 执行哪些 Jenkins 操作？': {
        notes: '先做最常用的一条链路',
      },
    },
  });

  assert.equal(
    prompt,
    [
      'Continue the previous task using my answers to your clarification questions:',
      '- Integration: MCP Server',
      '- Operations: 获取日志, 参数化构建 | note: 先做最常用的一条链路',
      '',
      'Do not call AskUserQuestion again for these already-answered questions.',
    ].join('\n'),
  );
});
