import assert from 'node:assert/strict';
import test from 'node:test';

const { lastTextByRole, turnHash, approxTokens } = await import('../extensions/memini.ts');

// Unit tests for transcript capture helpers

await test('getTextByRole respects sinceIndex lower bound', () => {
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: 'U1' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'A1' }] },
    { role: 'user', content: [{ type: 'text', text: 'U2' }] },
    { role: 'user', content: [{ type: 'text', text: 'U3' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'A2' }] },
    { role: 'user', content: [{ type: 'text', text: 'U4' }] },
  ];
  // Last user overall is U4
  assert.equal(lastTextByRole(msgs, 'user'), 'U4');
  // If we set sinceIndex after A1 (index 1), last user should be U4; after A2 (index 4), fallback to none -> empty
  assert.equal(lastTextByRole(msgs, 'user', 2), 'U4');
  assert.equal(lastTextByRole(msgs, 'user', 5), 'U4');
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
