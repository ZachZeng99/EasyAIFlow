import assert from 'node:assert/strict';
import { deriveImportedSessionSummary } from '../electron/importedSessionSummary.js';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('deriveImportedSessionSummary uses API error text as title when no assistant reply exists', () => {
  const summary = deriveImportedSessionSummary({
    firstUserText: '"X:\\MEM\\PS5-Development-159945.memreport" 总结一下这个报告',
    lastErrorText: 'Invalid API key',
    interrupted: true,
    nativeSessionId: 'session-1',
  });

  assert.equal(summary.title, 'Invalid API key');
  assert.equal(summary.preview, '"X:\\MEM\\PS5-Development-159945.memreport" 总结一下这个报告');
});

run('deriveImportedSessionSummary keeps the original prompt title when an assistant reply exists', () => {
  const summary = deriveImportedSessionSummary({
    firstUserText: '"X:\\MEM\\PS5-Development-159945.memreport" 总结一下这个报告',
    lastAssistantText: '## Shaders LLM 739 MB 深度分析',
    nativeSessionId: 'session-2',
  });

  assert.equal(summary.title, '"X:\\MEM\\PS5-Development-159945.memreport"');
  assert.equal(summary.preview, '## Shaders LLM 739 MB 深度分析');
});
