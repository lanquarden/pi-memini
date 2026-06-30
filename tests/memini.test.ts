import assert from 'node:assert/strict';
import test from 'node:test';

// Run tests directly on TS via tsx loader
const { lastTextByRole, turnHash, approxTokens, stripRecallBlock, computeTranscriptSlice } = await import('../extensions/memini.ts');

await test('getTextByRole respects sinceIndex lower bound', () => {
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: 'U1' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'A1' }] },
    { role: 'user', content: [{ type: 'text', text: 'U2' }] },
    { role: 'user', content: [{ type: 'text', text: 'U3' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'A2' }] },
    { role: 'user', content: [{ type: 'text', text: 'U4' }] },
  ];
  assert.equal(lastTextByRole(msgs, 'user'), 'U4');
  assert.equal(lastTextByRole(msgs, 'user', 2), 'U4');
  assert.equal(lastTextByRole(msgs, 'user', 5), 'U4');
});

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

await test('turnHash combines user and assistant text deterministically', () => {
  const h1 = turnHash('user', 'assistant');
  const h2 = turnHash('user', 'assistant');
  const h3 = turnHash('userX', 'assistant');
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
});

await test('approxTokens rough estimate is monotonic and nonzero for nonempty', () => {
  assert.equal(approxTokens(''), 0);
  assert.ok(approxTokens('hello') >= 1);
  assert.ok(approxTokens('hello world') >= approxTokens('hello'));
});

await test('approxTokens basic behavior', () => {
  assert.equal(approxTokens(''), 0);
  assert.equal(approxTokens('one'), 2);
  assert.equal(approxTokens('two words'), 3);
});
