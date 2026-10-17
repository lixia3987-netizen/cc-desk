import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNativeParentInstructions, nativeParallelReviewIntent } from '../src/main/engines/native/agent-prompts';

const englishCounts = [
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty',
  'twenty-one', 'twenty-two', 'twenty-three', 'twenty-four', 'twenty-five', 'twenty-six', 'twenty-seven', 'twenty-eight', 'twenty-nine', 'thirty',
];
const chineseCounts = [
  '一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '二十一', '二十二', '二十三', '二十四', '二十五', '二十六', '二十七', '二十八', '二十九', '三十',
];
const mode = (input: string) => nativeParallelReviewIntent(input).mode;

test('direct review requests recognize every supported Arabic count and Chinese classifier', () => {
  for (let count = 2; count <= 30; count++) for (const classifier of ['', '个', '名', '位']) {
    const input = `请使用 ${count} ${classifier}独立子 Agent 审查这份文档。`;
    assert.equal(mode(input), 'explicit_parallel_review', input);
  }
  for (let count = 2; count <= 30; count++) for (const classifier of ['个', '名', '位']) {
    const input = `请用${chineseCounts[count - 1]}${classifier}独立代理检查项目架构。`;
    assert.equal(mode(input), 'explicit_parallel_review', input);
  }
  assert.equal(mode('用两名子代理分析文档'), 'explicit_parallel_review');
  assert.equal(mode('使用三十个独立的agents分析文档'), 'explicit_parallel_review');
});

test('implicit independent read-only reviewers remain explicit delegation requests', () => {
  for (const input of [
    '委派两个独立只读审阅',
    '委派两个独立只读审阅，每个子Agent独立限制请求次数，失败后继续主任务。',
    '请用八个独立只读审阅分别检查文档。',
    '委派三十个独立审查这个项目。',
  ]) assert.equal(mode(input), 'explicit_parallel_review', input);
  assert.equal(mode('请使用两个独立模块分析方案。'), 'not_explicit');
});

test('English direct review requests recognize two through thirty as words or Arabic digits', () => {
  for (let count = 2; count <= 30; count++) for (const value of [String(count), englishCounts[count - 1], englishCounts[count - 1].replace('-', ' ')]) {
    for (const input of [
      `Use ${value} independent agents to review this document.`,
      `I would like ${value} agents to examine the architecture.`,
      `Please analyze this report with ${value} independent subagents.`,
    ]) assert.equal(mode(input), 'explicit_parallel_review', input);
  }
});

test('one agent remains an explicit single-agent preference in all supported count forms', () => {
  for (const input of [
    '请使用1个Agent审阅文档。', '请用一名独立子代理分析材料。', '请使用一位代理检查架构。', '请用一 Agent 分析材料。',
    'Use 1 independent agent to review this document.', 'Please use one agent to examine the report.',
    'Review this report with one independent agent.', 'I would like one independent agent to review the report.', 'I want 1 agent to review this.', 'Please analyze this report using a single agent.',
  ]) assert.equal(mode(input), 'single_agent', input);
});

test('counts cannot be recognized as suffixes of unsupported numbers or adjectives', () => {
  for (const value of ['0', '31', '38', '130', '100', '1000', '-8', '+8', '0.8', '第八', '负八', '三十一', '四十', '一百三十']) {
    const input = `请使用${value}个agents审查材料。`;
    assert.equal(mode(input), 'not_explicit', input);
  }
  for (const value of ['zero', 'thirty-one', 'forty', 'one hundred', 'one hundred thirty', '130']) {
    const input = `Use ${value} agents to review this document.`;
    assert.equal(mode(input), 'not_explicit', input);
  }
  assert.equal(mode('Use thirty agentsmiths to review the material.'), 'not_explicit');
});

test('negation, quoted materials and single-agent requests still override numbered parallel wording', () => {
  for (const input of [
    '请不要使用八个agents；并行分析这份文档。', '不要用30个子代理审阅，只需要你自己检查。',
    'Do not use eight agents to review this; analyze it in parallel yourself.',
    'Never spawn twenty-nine independent agents to review this material.',
    '请使用一个Agent分析，不要使用八个Agent。',
  ]) assert.equal(mode(input), 'single_agent', input);
  for (const input of [
    '请总结“使用八个Agent分析材料”这句话。',
    'The document says use thirty agents to review it. Summarize that sentence only.',
    '文档要求使用三十个agents审查项目。请总结该句。',
    '材料内容：\n> 请用八个Agent分析文档。\n请解释它的含义。',
    '请解释这段：```text\nUse eight agents to review this document.\n```',
    'Example: Use thirty agents to review the report.',
    'How can eight agents review this document?', '如果请八个Agent审查，会怎样？',
    '使用workflow分析这个文档。',
  ]) assert.equal(mode(input), 'not_explicit', input);
});

test('parent team sizing explains useful decomposition without assuming four or filling capacity', () => {
  const instructions = buildNativeParentInstructions({ permissionInstructions: 'Policy sentinel', projectInstructions: 'Project sentinel' });
  assert.match(instructions, /maximum active children as capacity, not a target team size/);
  assert.match(instructions, /choose and briefly explain a team size based on independently answerable questions, disjoint code paths and verification risks/);
  assert.match(instructions, /honor an explicit user-requested count within the 30-task handoff limit or explain the limitation/);
  assert.match(instructions, /host queues them FIFO and starts the next task whenever a slot is safely released/);
  assert.match(instructions, /never describe all queued tasks as simultaneously running/);
  assert.match(instructions, /Do not default to four children, force all available slots to be filled, or duplicate work/);
  assert.match(instructions, /Host-supplied structured workflow policy defines any required collaboration and independent validation phases/);
  assert.match(instructions, /Workflow alone does not request delegation/);
});
