const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('grouping prompt requests one mapping per choice when groups are fewer', () => {
  const context = vm.createContext({ AutoMcGraw: {} });
  vm.runInContext(fs.readFileSync('background/prompt.js', 'utf8'), context);
  const options = {
    prompts: Array.from({ length: 6 }, (_, i) => `Group ${i + 1}`),
    choices: Array.from({ length: 10 }, (_, i) => `Label ${i + 1}`),
    multiple: true,
  };
  const prompt = context.AutoMcGraw.prompt.build({ type: 'matching', question: 'Group labels', options });
  assert.match(prompt, /6 groups and 10 choices/);
  assert.match(prompt, /array of exactly 10 strings/);
  assert.match(prompt, /not one per group/);
  assert.match(prompt, /without the list numbers/);
  assert.match(prompt, /exactly one arrow/);
  for (const label of options.choices) assert.ok(prompt.includes(label));
});

function setup(extraChoices = []) {
  const items = [];
  const prompts = ['Self-serving bias', 'Fundamental attribution error'];
  const choices = ['Successes internal, failures external', 'Overestimates intrinsic factors', ...extraChoices];
  const events = [];
  const rows = prompts.map((prompt, index) => {
    const slots = Array.from({ length: choices.length }, (_, slot) => ({
      matches: () => false,
      querySelector: () => items.find(item => item.row === index && item.slot === slot) || null,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 20, height: 20 }),
      dispatchEvent(event) {
        events.push(event.type);
        if (event.type === 'drop') {
          const previous = this.querySelector();
          if (previous) previous.row = -1;
          const item = items.find(item => item.dragging);
          item.row = index;
          item.slot = slot;
        }
      },
    }));
    return {
      querySelectorAll(selector) {
        return selector.includes('data-drop-target') ? slots : items.filter(item => item.row === index);
      },
      querySelector(selector) {
        if (selector.startsWith('.match-prompt')) return { textContent: prompt };
        return selector.includes('.draggableItem') ? items.find(item => item.row === index) || null : null;
      },
    };
  });
  choices.forEach(value => items.push({
    row: -1, dragging: false,
    matches: selector => selector.includes('.draggableItem'),
    querySelector: selector => selector === '.dragItemContent' ? { textContent: value } : null,
    dispatchEvent(event) {
      events.push(event.type);
      if (event.type === 'dragstart') this.dragging = true;
      if (event.type === 'dragend') this.dragging = false;
    },
  }));
  const root = { querySelectorAll(selector) {
    if (selector.includes('.match-row')) return rows;
    if (!selector.includes('.draggableItem')) return [];
    return selector.includes('.choices-container') ? items.filter(item => item.row === -1) : items;
  } };
  const context = {
    AutoMcGraw: {
      text: {
        normalizeChoiceText: value => String(value).trim(),
        isAnswerMatch: (a, b) => a.toLowerCase() === b.toLowerCase(),
        dedupeAnswers: values => [...new Set(values)],
        stripWrappingQuotes: value => value,
        parseArrayString: () => null,
        LIST_MARKER: /^[-*]\s+/,
      },
      wait: { delay: async () => {} },
      dom: { KEYS: { space: ' ', enter: 'Enter' }, pressKey: () => assert.fail('Native drag must not use legacy keyboard path') },
    },
    DataTransfer: class {},
    DragEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    console,
  };
  vm.runInNewContext(fs.readFileSync('content/smartbook/matching.js', 'utf8'), context);
  return { matching: context.AutoMcGraw.matching, container: { querySelector: () => root }, prompts, choices, items, events };
}

for (const format of ['pairs', 'object', 'entries']) {
  test(`native matching applies ${format} answers and verifies placement`, async () => {
    const q = setup();
    const raw = format === 'pairs' ? q.prompts.map((p, i) => `${p} -> ${q.choices[i]}`)
      : format === 'object' ? Object.fromEntries(q.prompts.map((p, i) => [p, q.choices[i]]))
      : q.prompts.map((prompt, i) => ({ prompt, choice: q.choices[i] }));
    assert.equal(await q.matching.apply(q.container, raw), true);
    assert.deepEqual(q.items.map(item => item.row), [0, 1]);
    assert.equal(q.events.filter(type => type === 'drop').length, 2);
  });
}
test('incomplete matching answer does not move any choices', async () => {
  const q = setup();
  assert.equal(await q.matching.apply(q.container, [`${q.prompts[0]} -> ${q.choices[0]}`]), false);
  assert.equal(q.events.length, 0);
});

test('grouping places every choice including multiple choices in the same row', async () => {
  const q = setup(['Third choice', 'Fourth choice']);
  const raw = q.choices.map((choice, i) => `${q.prompts[i % 2]} -> ${choice}`);
  assert.equal(await q.matching.apply(q.container, raw), true);
  assert.deepEqual(q.items.map(item => item.row), [0, 1, 0, 1]);
});
test('grouping rejects one answer per category when choices remain', async () => {
  const q = setup(['Third choice']);
  assert.equal(await q.matching.apply(q.container,
    q.prompts.map((p, i) => `${p} -> ${q.choices[i]}`)), false);
  assert.equal(q.events.length, 0);
});

test('grouping preserves occupied slots and resumes partially placed answers', async () => {
  const q = setup(['India', 'Italy', 'Spain', 'China']);
  q.items[0].row = 0;
  q.items[0].slot = 0;
  q.items[4].row = 1;
  q.items[4].slot = 0;
  const expected = [0, 0, 1, 1, 1, 1];
  const raw = q.choices.map((choice, i) => `${q.prompts[expected[i]]} -> ${choice}`);
  assert.equal(await q.matching.apply(q.container, raw), true);
  assert.deepEqual(q.items.map(item => item.row), expected);
  assert.equal(q.events.filter(type => type === 'drop').length, 4);
});

test('grouping expands comma-separated choices while preserving a choice containing commas', async () => {
  const q = setup(['India', 'Italy', 'Spain', 'China']);
  const raw = [
    `${q.prompts[0]} -> ${q.choices[0]}`,
    `${q.prompts[0]} -> ${q.choices[1]}`,
    `${q.prompts[1]} -> India,Italy,Spain,China`,
  ];
  assert.equal(await q.matching.apply(q.container, raw), true);
  assert.deepEqual(q.items.map(item => item.row), [0, 0, 1, 1, 1, 1]);
});

test('grouping rejects an unresolved comma-separated choice before moving items', async () => {
  const q = setup(['India', 'Italy']);
  const raw = [
    `${q.prompts[0]} -> ${q.choices[0]}`,
    `${q.prompts[0]} -> ${q.choices[1]}`,
    `${q.prompts[1]} -> India,Unknown`,
  ];
  assert.equal(await q.matching.apply(q.container, raw), false);
  assert.equal(q.events.length, 0);
});
