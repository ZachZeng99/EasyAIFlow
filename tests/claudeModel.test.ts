import assert from 'node:assert/strict';
import {
  normalizeClaudeModelSelection,
  resolveClaudeModelArg,
  shouldSwitchClaudeSessionModel,
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

run('resolveClaudeModelArg expands opus alias to the latest default Claude Opus model when env overrides are absent', () => {
  assert.equal(resolveClaudeModelArg('opus[1m]'), 'claude-opus-4-7[1m]');
});

run('resolveClaudeModelArg treats bare claude as the default opus alias', () => {
  assert.equal(resolveClaudeModelArg('claude'), 'claude-opus-4-7');
});

run('resolveClaudeModelArg keeps explicit model names unchanged', () => {
  assert.equal(resolveClaudeModelArg('kimi-k2.5', { _env: { ANTHROPIC_MODEL: 'other' } }), 'kimi-k2.5');
});

run('normalizeClaudeModelSelection maps native sonnet model names back to UI alias', () => {
  assert.equal(normalizeClaudeModelSelection('claude-sonnet-4-6'), 'sonnet');
});

run('normalizeClaudeModelSelection maps native opus model names back to UI alias', () => {
  assert.equal(normalizeClaudeModelSelection('claude-opus-4-7'), 'opus[1m]');
});

run('normalizeClaudeModelSelection maps bare claude back to the default UI alias', () => {
  assert.equal(normalizeClaudeModelSelection('claude'), 'opus[1m]');
});

run('shouldSwitchClaudeSessionModel only switches persisted sessions and ignores slash prompts', () => {
  assert.equal(
    shouldSwitchClaudeSessionModel({
      claudeSessionId: 'session-123',
      currentResolvedModel: 'claude-sonnet-4-6',
      requestedResolvedModel: 'claude-opus-4-7[1m]',
      prompt: 'continue this task',
    }),
    true,
  );
  assert.equal(
    shouldSwitchClaudeSessionModel({
      claudeSessionId: 'session-123',
      currentResolvedModel: 'claude-sonnet-4-6',
      requestedResolvedModel: 'claude-sonnet-4-6',
      prompt: 'continue this task',
    }),
    false,
  );
  assert.equal(
    shouldSwitchClaudeSessionModel({
      claudeSessionId: 'session-123',
      currentResolvedModel: 'claude-sonnet-4-6',
      requestedResolvedModel: 'claude-opus-4-7[1m]',
      prompt: '/clear',
    }),
    false,
  );
});
