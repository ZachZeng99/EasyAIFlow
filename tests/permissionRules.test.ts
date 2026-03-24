import assert from 'node:assert/strict';
import { buildPermissionRulesForPath } from '../electron/permissionRules.js';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('buildPermissionRulesForPath uses home-relative patterns when target is under home', () => {
  const rules = buildPermissionRulesForPath(
    'C:\\Users\\L\\.claude\\knowledge\\agc-transient-heaps-analysis.md',
    'C:\\Users\\L',
  );

  assert.deepEqual(rules, ['Edit(~/.claude/knowledge/**)', 'Write(~/.claude/knowledge/**)']);
});

run('buildPermissionRulesForPath falls back to absolute patterns outside home', () => {
  const rules = buildPermissionRulesForPath(
    'X:\\PBZ\\ProjectPBZ\\.claude\\skills\\memreport-analyze\\knowledge\\agc-transient-heaps-analysis.md',
    'C:\\Users\\L',
  );

  assert.deepEqual(
    rules,
    [
      'Edit(//X:/PBZ/ProjectPBZ/.claude/skills/memreport-analyze/knowledge/**)',
      'Write(//X:/PBZ/ProjectPBZ/.claude/skills/memreport-analyze/knowledge/**)',
    ],
  );
});
