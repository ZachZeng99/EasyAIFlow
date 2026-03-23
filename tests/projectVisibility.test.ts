import assert from 'node:assert/strict';
import { filterVisibleProjects } from '../electron/projectVisibility.js';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('filterVisibleProjects drops closed projects from UI results', () => {
  const visible = filterVisibleProjects([
    { id: 'open', name: 'PBZ', rootPath: 'X:\\PBZ', isClosed: false, dreams: [] },
    { id: 'closed-a', name: 'EasyAIFlow', rootPath: 'X:\\AITool\\EasyAIFlow', isClosed: true, dreams: [] },
    { id: 'closed-b', name: 'GPUCapture', rootPath: 'X:\\GPUCapture', isClosed: true, dreams: [] },
  ]);

  assert.deepEqual(
    visible.map((project) => project.name),
    ['PBZ'],
  );
});
