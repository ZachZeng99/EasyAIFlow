import assert from 'node:assert/strict';
import {
  buildClaudeAskUserQuestionToolResultLine,
  buildClaudeControlResponseLine,
  buildClaudeUserMessageLine,
  parseClaudeAskUserQuestionControlRequest,
  parseClaudePermissionControlRequest,
} from '../electron/claudeControlMessages.js';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('buildClaudeUserMessageLine emits a stream-json user message', () => {
  const line = buildClaudeUserMessageLine('Create probe.txt');

  assert.deepEqual(JSON.parse(line), {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'Create probe.txt' }],
    },
  });
});

run('parseClaudePermissionControlRequest extracts a write permission prompt', () => {
  const request = parseClaudePermissionControlRequest({
    type: 'control_request',
    request_id: 'req_123',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Write',
      input: {
        file_path: 'C:\\Users\\L\\.claude\\projects\\X--PBZ-ProjectPBZ\\memory\\feedback.md',
        content: 'readability note',
      },
      decision_reason: 'Path is treated as sensitive.',
      tool_use_id: 'toolu_123',
    },
  });

  assert.deepEqual(request, {
    requestId: 'req_123',
    toolUseId: 'toolu_123',
    toolName: 'Write',
    targetPath: 'C:\\Users\\L\\.claude\\projects\\X--PBZ-ProjectPBZ\\memory\\feedback.md',
    command: undefined,
    description: undefined,
    decisionReason: 'Path is treated as sensitive.',
    sensitive: true,
    rawInput: {
      file_path: 'C:\\Users\\L\\.claude\\projects\\X--PBZ-ProjectPBZ\\memory\\feedback.md',
      content: 'readability note',
    },
  });
});

run('parseClaudePermissionControlRequest ignores AskUserQuestion requests', () => {
  const request = parseClaudePermissionControlRequest({
    type: 'control_request',
    request_id: 'req_ask_user',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: '你的 Jenkins 环境是怎样的？',
            header: 'Jenkins env',
          },
        ],
      },
      tool_use_id: 'toolu_ask_user',
    },
  });

  assert.equal(request, null);
});

run('parseClaudeAskUserQuestionControlRequest extracts interactive question payloads', () => {
  const request = parseClaudeAskUserQuestionControlRequest({
    type: 'control_request',
    request_id: 'req_ask_user',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: '你的 Jenkins 环境是怎样的？',
            header: 'Jenkins env',
            options: [
              { label: '内网 Jenkins', description: '本机可以访问其 HTTP API' },
              { label: '云端 Jenkins', description: '需要通过 VPN 或公网访问' },
            ],
            multiSelect: false,
          },
        ],
      },
      tool_use_id: 'toolu_ask_user',
    },
  });

  assert.deepEqual(request, {
    requestId: 'req_ask_user',
    toolUseId: 'toolu_ask_user',
    toolName: 'AskUserQuestion',
    questions: [
      {
        question: '你的 Jenkins 环境是怎样的？',
        header: 'Jenkins env',
        options: [
          { label: '内网 Jenkins', description: '本机可以访问其 HTTP API' },
          { label: '云端 Jenkins', description: '需要通过 VPN 或公网访问' },
        ],
        multiSelect: false,
      },
    ],
    rawInput: {
      questions: [
        {
          question: '你的 Jenkins 环境是怎样的？',
          header: 'Jenkins env',
          options: [
            { label: '内网 Jenkins', description: '本机可以访问其 HTTP API' },
            { label: '云端 Jenkins', description: '需要通过 VPN 或公网访问' },
          ],
          multiSelect: false,
        },
      ],
    },
  });
});

run('buildClaudeControlResponseLine allows a pending tool request with updated input', () => {
  const line = buildClaudeControlResponseLine(
    {
      requestId: 'req_123',
      toolUseId: 'toolu_123',
      toolName: 'Write',
      targetPath: 'C:\\tmp\\foo.txt',
      command: undefined,
      description: undefined,
      decisionReason: 'Needs approval',
      sensitive: false,
      rawInput: {
        file_path: 'C:\\tmp\\foo.txt',
        content: 'hello',
      },
    },
    'allow',
  );

  assert.deepEqual(JSON.parse(line), {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'req_123',
      response: {
        behavior: 'allow',
        updatedInput: {
          file_path: 'C:\\tmp\\foo.txt',
          content: 'hello',
        },
      },
    },
  });
});

run('buildClaudeControlResponseLine denies a pending tool request with a message', () => {
  const line = buildClaudeControlResponseLine(
    {
      requestId: 'req_123',
      toolUseId: 'toolu_123',
      toolName: 'Write',
      targetPath: 'C:\\tmp\\foo.txt',
      command: undefined,
      description: undefined,
      decisionReason: 'Needs approval',
      sensitive: false,
      rawInput: {
        file_path: 'C:\\tmp\\foo.txt',
        content: 'hello',
      },
    },
    'deny',
  );

  assert.deepEqual(JSON.parse(line), {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'req_123',
      response: {
        behavior: 'deny',
        message: 'User denied this action in EasyAIFlow.',
      },
    },
  });
});

run('buildClaudeAskUserQuestionToolResultLine emits a tool_result user message', () => {
  const line = buildClaudeAskUserQuestionToolResultLine({
    toolUseId: 'toolu_ask_user',
    questions: [
      {
        question: '你的 Jenkins 环境是怎样的？',
        header: 'Jenkins env',
        options: [
          { label: '内网 Jenkins', description: '本机可以访问其 HTTP API' },
          { label: '云端 Jenkins', description: '需要通过 VPN 或公网访问' },
        ],
        multiSelect: false,
      },
    ],
    response: {
      answers: {
        '你的 Jenkins 环境是怎样的？': '2',
      },
      annotations: {
        '你的 Jenkins 环境是怎样的？': {
          notes: '目前需要走 VPN',
        },
      },
    },
  });

  assert.deepEqual(JSON.parse(line), {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          content:
            'User has answered your questions: "你的 Jenkins 环境是怎样的？"="2" user notes: 目前需要走 VPN. You can now continue with the user\'s answers in mind.',
          tool_use_id: 'toolu_ask_user',
        },
      ],
    },
    toolUseResult: {
      questions: [
        {
          question: '你的 Jenkins 环境是怎样的？',
          header: 'Jenkins env',
          options: [
            { label: '内网 Jenkins', description: '本机可以访问其 HTTP API' },
            { label: '云端 Jenkins', description: '需要通过 VPN 或公网访问' },
          ],
          multiSelect: false,
        },
      ],
      answers: {
        '你的 Jenkins 环境是怎样的？': '2',
      },
      annotations: {
        '你的 Jenkins 环境是怎样的？': {
          notes: '目前需要走 VPN',
        },
      },
    },
  });
});
