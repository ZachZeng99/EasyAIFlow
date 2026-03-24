import assert from 'node:assert/strict';
import {
  formatImportedAskUserQuestionAnswer,
  formatImportedAskUserQuestionPrompt,
} from '../electron/importedAskUserQuestion.ts';

const run = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
};

run('formatImportedAskUserQuestionPrompt renders the interactive question details', () => {
  const display = formatImportedAskUserQuestionPrompt({
    questions: [
      {
        header: '优化目标',
        question: '这个纹理优化计划的首要目标是什么？',
        options: [
          { label: '降低 PS5 峰值内存', description: '先把内存打回预算内' },
          { label: '两者都要', description: '先灭火再建制度' },
        ],
      },
    ],
  });

  assert.equal(display?.title, '优化目标');
  assert.match(display?.content ?? '', /这个纹理优化计划的首要目标是什么？/);
  assert.match(display?.content ?? '', /1\. 降低 PS5 峰值内存 - 先把内存打回预算内/);
  assert.match(display?.content ?? '', /2\. 两者都要 - 先灭火再建制度/);
});

run('formatImportedAskUserQuestionAnswer uses structured answers and annotations', () => {
  const display = formatImportedAskUserQuestionAnswer({
    questions: [
      {
        header: '场景分类',
        question: '你希望按什么维度区分场景预算？',
        options: [
          { label: '按场景类型' },
          { label: '按内存压力等级' },
          { label: '浮动预算+固定上限' },
          { label: '固定项+浮动项分离' },
        ],
      },
    ],
    answers: {
      '你希望按什么维度区分场景预算？': '3+4',
    },
    annotations: {
      '你希望按什么维度区分场景预算？': {
        notes: '3+4',
      },
    },
  });

  assert.equal(display?.title, '场景分类');
  assert.equal(display?.hasExplicitAnswer, true);
  assert.match(display?.content ?? '', /回答：浮动预算\+固定上限, 固定项\+浮动项分离/);
  assert.match(display?.content ?? '', /备注：3\+4/);
});

run('formatImportedAskUserQuestionAnswer falls back when the answer payload is missing', () => {
  const display = formatImportedAskUserQuestionAnswer({
    questions: [
      {
        header: 'Feature 取舍',
        question: '哪些 feature 可以动？',
        options: [{ label: '由你分析建议' }],
      },
    ],
    answers: {},
  });

  assert.equal(display?.hasExplicitAnswer, false);
  assert.match(display?.content ?? '', /原始记录未保留答案详情/);
});

run('formatImportedAskUserQuestionAnswer parses legacy inline answer text', () => {
  const display = formatImportedAskUserQuestionAnswer(
    {
      questions: [
        {
          header: '优化目标',
          question: '这个纹理优化计划的首要目标是什么？',
          options: [
            { label: '降低 PS5 峰值内存' },
            { label: '全平台纹理质量/内存平衡' },
            { label: '两者都要' },
          ],
        },
      ],
      answers: {},
    },
    'User has answered your questions: "这个纹理优化计划的首要目标是什么？"="3" user notes: 先灭火再建制度. You can now continue with the user\'s answers in mind.',
  );

  assert.equal(display?.hasExplicitAnswer, true);
  assert.match(display?.content ?? '', /回答：两者都要/);
  assert.match(display?.content ?? '', /备注：先灭火再建制度/);
});
