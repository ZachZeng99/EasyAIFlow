import assert from 'node:assert/strict';
import {
  normalizeClaudeModelSelection,
  resolveClaudeModelArg,
} from '../electron/claudeModel.js';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('resolveClaudeModelArg maps opus alias to env-configured backend model', () => {
  const resolved = resolveClaudeModelArg('opus[1m]', {
    _env: {
      ANTHROPIC_MODEL: 'kimi-k2.5',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'kimi-k2.5',
    },
  });

  assert.equal(resolved, 'kimi-k2.5[1m]');
});

run('resolveClaudeModelArg maps sonnet alias to env-configured backend model', () => {
  const resolved = resolveClaudeModelArg('sonnet[1m]', {
    _env: {
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-k2.5',
    },
  });

  assert.equal(resolved, 'kimi-k2.5');
});

run('resolveClaudeModelArg expands sonnet alias to a canonical Claude model when env overrides are absent', () => {
  assert.equal(resolveClaudeModelArg('sonnet[1m]'), 'claude-sonnet-4-6');
});

run('resolveClaudeModelArg keeps explicit model names unchanged', () => {
  assert.equal(resolveClaudeModelArg('kimi-k2.5', { _env: { ANTHROPIC_MODEL: 'other' } }), 'kimi-k2.5');
});

run('normalizeClaudeModelSelection maps native sonnet model names back to UI alias', () => {
  assert.equal(normalizeClaudeModelSelection('claude-sonnet-4-6'), 'sonnet');
});
