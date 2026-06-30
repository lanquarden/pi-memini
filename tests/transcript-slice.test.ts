import assert from 'node:assert/strict';
import test from 'node:test';

const { stripRecallBlock, computeTranscriptSlice } = await import('../extensions/memini.ts');

await test('computeTranscriptSlice slices only current-run user messages', () => {
  const rb = 'Relevant long-term memory from memini\n- (semantic) x\n\n---\n\n';
  const messages = [
    { role: 'user', content: [{ type: 'text', text: rb + 'U1' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'A1' }] },
    { role: 'user', content: [{ type: 'text', text: rb + 'U2' }] },
    { role: 'user', content: [{ type: 'text', text: 'U3' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'A2' }] },
    { role: 'user', content: [{ type: 'text', text: rb + 'U4' }] },
    { role: 'user', content: [{ type: 'text', text: 'U5' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'A3' }] },
  ];
  // sinceAssistantIdx right after A2 (index 4) => include U4, U5 only
  const { users, assistant, lastAssistantIdx } = computeTranscriptSlice(messages as any[], rb.trim(), 5);
  assert.deepEqual(users, ['U4', 'U5']);
  assert.equal(assistant, 'A3');
  assert.equal(lastAssistantIdx, 7);
});

await test('stripRecallBlock removes injected banner variants', () => {
  const rb = 'Relevant long-term memory from memini\n- line1';
  const variants = [
    `${rb}\n\n---\n\nHello`,
    `${rb}\n---\n\nHello`,
    `${rb}\n\nHello`,
    `${rb}\nHello`,
    `${rb}Hello`,
  ];
  for (const v of variants) {
    assert.equal(stripRecallBlock(v, rb), 'Hello');
  }
});
