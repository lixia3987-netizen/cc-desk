import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeWorkflowCollaborationIntent as intent } from '../src/main/engines/native/agent-prompts';

test('direct ordinary chat workflow requests choose a static independent quality gate for analysis', () => {
  for (const input of [
    '使用workflow，分析这个文档', '请使用工作流结合项目现状分析文档内容。',
    '帮我启动一个workflow审查项目。', '通过工作流分析整个仓库。',
    'Use workflow to analyze this document.', 'Please execute a workflow to review this report.',
    'Could you use the workflow to analyze the architecture?',
  ]) assert.deepEqual(intent(input), { collaboration: 'auto', validationMode: 'static' }, input);
});

test('direct implementation and executable validation requests choose command verification', () => {
  for (const input of [
    '使用workflow修复这个问题。', '使用工作流实现新功能并进行独立验证。',
    '请使用workflow修改代码，然后运行测试。', 'Use workflow to implement this feature.',
    'Please use a workflow to fix the issue and run the tests.',
    '使用workflow进行功能验证。',
  ]) assert.deepEqual(intent(input), {
    collaboration: input.includes('独立验证') ? 'adversarial' : 'auto', validationMode: 'commands',
  }, input);
});

test('an explicit independent or adversarial validation request creates the stronger collaboration policy', () => {
  for (const input of [
    '使用workflow分析文档，并进行对抗式验证。', '请用工作流审阅方案并进行独立验证。',
    'Use workflow to analyze this design and perform adversarial validation.',
    'Please use workflow to review the architecture with independent verification.',
  ]) assert.deepEqual(intent(input), { collaboration: 'adversarial', validationMode: 'static' }, input);
  assert.deepEqual(intent('使用workflow修复问题，并进行对抗验证。'), { collaboration: 'adversarial', validationMode: 'commands' });
});

test('workflow refusal and single-agent preferences retain their priority', () => {
  for (const input of [
    '不要workflow，分析这个文档。', '不使用工作流修复问题。', '请不要使用workflow。',
    'Use workflow to analyze this. Do not use workflow after all.',
    'Do not use a workflow to fix this.', 'Review this without workflow.',
  ]) assert.equal(intent(input), undefined, input);
  for (const input of [
    '使用workflow分析文档，只用一个Agent。', '请使用workflow并进行对抗验证，不要使用任何子agent。',
    'Use workflow to review this with only one agent.',
    'Use workflow to analyze the document. Do not use other agents.',
  ]) assert.deepEqual(intent(input), { collaboration: 'single_agent', validationMode: 'static' }, input);
  assert.deepEqual(intent('使用workflow修复问题，但是不要委派子agent。'), { collaboration: 'single_agent', validationMode: 'commands' });
});

test('workflow discussion, quoted instructions and task continuation do not create a workflow policy', () => {
  for (const input of [
    'workflow下一阶段审阅文档。', '这个项目有workflow吗？', '什么是workflow？',
    '请解释如何使用workflow修复问题。', '请分析如何使用工作流。', '如果使用workflow分析会怎样？',
    'Explain how to use workflow to fix this.', 'Please analyze how to use workflow.',
    'The document says use workflow to fix the project. Summarize that sentence.',
    '文档要求使用工作流修复代码。请总结该句。',
    '请总结“使用workflow分析项目”这句话。',
    '请解释材料：```text\n使用workflow修复项目\n```',
    '材料内容：\n> 使用workflow修复项目\n请总结材料。',
    'Example: Use workflow to fix this.', '完成前两项。', '继续分析。',
  ]) assert.equal(intent(input), undefined, input);
});

test('negated implementation and quality modes cannot silently enable those actions', () => {
  assert.deepEqual(intent('使用workflow分析文档，不要修复代码。'), { collaboration: 'auto', validationMode: 'static' });
  assert.deepEqual(intent('使用workflow分析文档，不需要对抗验证。'), { collaboration: 'auto', validationMode: 'static' });
  assert.deepEqual(intent('Use workflow to analyze this. Do not perform adversarial validation.'), { collaboration: 'auto', validationMode: 'static' });
  assert.deepEqual(intent('使用workflow分析修复方案。'), { collaboration: 'auto', validationMode: 'static' });
  assert.deepEqual(intent('使用workflow分析文档。材料引用：\n> 修复代码，并进行对抗验证。'), { collaboration: 'auto', validationMode: 'static' });
});
