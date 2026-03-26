import assert from 'node:assert/strict';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiffContent } from '../src/components/DiffContent.tsx';
import type { DiffPayload } from '../src/data/types.ts';

(globalThis as typeof globalThis & { React?: typeof React }).React = React;

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('DiffContent keeps preview lines as plain context instead of diff deletions', () => {
  const payload: DiffPayload = {
    filePath: 'X:\\PBZ\\ProjectPBZ\\PS5_MemoryOptimization_AssetChanges.md',
    kind: 'preview',
    content: ['- bullet one', '- bullet two', '+ heading'].join('\n'),
  };

  const markup = renderToStaticMarkup(createElement(DiffContent, { payload }));

  assert.match(markup, /diff-line ctx">- bullet one/);
  assert.match(markup, /diff-line ctx">- bullet two/);
  assert.match(markup, /diff-line ctx">\+ heading/);
  assert.doesNotMatch(markup, /diff-line del">- bullet one/);
  assert.doesNotMatch(markup, /diff-line add">\+ heading/);
});

run('DiffContent still highlights real git diff markers for git payloads', () => {
  const payload: DiffPayload = {
    filePath: 'X:\\PBZ\\ProjectPBZ\\PS5_MemoryOptimization_AssetChanges.md',
    kind: 'git',
    content: ['@@ section', '- removed line', '+ added line'].join('\n'),
  };

  const markup = renderToStaticMarkup(createElement(DiffContent, { payload }));

  assert.match(markup, /diff-line hunk">@@ section/);
  assert.match(markup, /diff-line del">- removed line/);
  assert.match(markup, /diff-line add">\+ added line/);
});
