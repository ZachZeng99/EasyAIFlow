import assert from 'node:assert/strict';
import {
  extractBackgroundTaskNotificationContent,
  isBackgroundTaskNotificationContent,
} from '../electron/backgroundTaskNotification.ts';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('isBackgroundTaskNotificationContent matches Claude task notifications', () => {
  assert.equal(
    isBackgroundTaskNotificationContent(
      '<task-notification>\n<task-id>bpu4pygpy</task-id>\n<status>completed</status>\n</task-notification>',
    ),
    true,
  );
});

run('isBackgroundTaskNotificationContent ignores normal user prompts', () => {
  assert.equal(isBackgroundTaskNotificationContent('探索一下如何给ps5安装包体'), false);
});

run('extractBackgroundTaskNotificationContent reads queue-operation notification payloads', () => {
  assert.equal(
    extractBackgroundTaskNotificationContent({
      type: 'queue-operation',
      content:
        '<task-notification>\n<task-id>bpu4pygpy</task-id>\n<status>completed</status>\n</task-notification>',
    }),
    '<task-notification>\n<task-id>bpu4pygpy</task-id>\n<status>completed</status>\n</task-notification>',
  );
});

run('extractBackgroundTaskNotificationContent reads text blocks inside user payloads', () => {
  assert.equal(
    extractBackgroundTaskNotificationContent({
      type: 'user',
      message: {
        content: [
          {
            type: 'text',
            text:
              '<task-notification>\n<task-id>bpu4pygpy</task-id>\n<status>completed</status>\n</task-notification>',
          },
        ],
      },
    }),
    '<task-notification>\n<task-id>bpu4pygpy</task-id>\n<status>completed</status>\n</task-notification>',
  );
});
