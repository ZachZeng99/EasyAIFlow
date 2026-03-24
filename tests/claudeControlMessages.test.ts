import assert from 'node:assert/strict';
import {
  buildClaudeControlResponseLine,
  buildClaudeUserMessageLine,
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
