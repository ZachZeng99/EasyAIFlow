import assert from 'node:assert/strict';
import { isBackgroundTaskNotificationContent } from '../electron/backgroundTaskNotification.ts';

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
