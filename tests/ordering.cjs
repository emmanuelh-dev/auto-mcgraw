const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function setup(move = true, native = false) {
  const events = [];
  let dragged;
  const items = ['norming', 'forming', 'storming', 'performing'].map(value => ({
    querySelector: () => ({ textContent: value,
      cloneNode() { return { textContent: value, querySelectorAll: () => [] }; },
    }),
    focus() {},
    ownerDocument: { defaultView: { KeyboardEvent: class {
      constructor(type, options) { Object.assign(this, options, { type }); }
    } } },
    dispatchEvent(event) {
      events.push(event);
      if (event.type === 'dragstart') dragged = this;
      if (move && event.type === 'drop') {
        const target = items.indexOf(this);
        items.splice(items.indexOf(dragged), 1);
        items.splice(target, 0, dragged);
      }
      if (event.type !== 'keydown') return;
      if (event.code === 'Space') this.picked = !this.picked;
      if (move && this.picked && event.code === 'ArrowUp') {
        const index = items.indexOf(this);
        if (index > 0) [items[index - 1], items[index]] = [items[index], items[index - 1]];
      }
    },
  }));
  if (native) items.forEach(item => {
    item.draggable = true;
    item.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 80 });
    Object.assign(item.ownerDocument.defaultView, {
      DataTransfer: class {},
      DragEvent: class {
        constructor(type, options) { Object.assign(this, options, { type }); }
      },
    });
  });
  const container = {
    querySelector: selector => selector === '.awd-probe-type-sortable' ? {} : null,
    querySelectorAll: selector => selector.endsWith('.content')
      ? items.map(item => item.querySelector()) : items,
  };
  const context = vm.createContext({ AutoMcGraw: {
    dom: {}, matching: {},
    wait: { delay: async () => {}, waitFor: async getter => getter() },
  } });
  for (const file of ['content/mhe/text.js', 'content/smartbook/questions.js',
    'content/smartbook/answers.js', 'background/prompt.js']) {
    vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  }
  return { api: context.AutoMcGraw, container, items, events };
}
const desired = ['forming', 'storming', 'norming', 'performing'];

test('ordering reads visible labels and requests a complete ordered array', () => {
  const { api, container } = setup();
  assert.equal(api.questions.detectType(container), 'ordering');
  const options = api.questions.readChoices(container, 'ordering');
  assert.deepEqual(Array.from(options), ['norming', 'forming', 'storming', 'performing']);
  assert.match(api.prompt.build({ type: 'ordering', question: 'Order', options }), /each option exactly once/);
});

test('ordering applies keyboard moves and verifies final order', async () => {
  const { api, container, items } = setup();
  assert.equal((await api.answers.apply(container, desired)).applied, true);
  assert.deepEqual(items.map(item => item.querySelector().textContent), desired);
});

test('ordering rejects incomplete, repeated and unknown choices before moving', async () => {
  for (const answer of [desired.slice(1), [...desired.slice(0, 3), 'forming'],
    [...desired.slice(0, 3), 'unknown']]) {
    const { api, container, events } = setup();
    assert.equal((await api.answers.apply(container, answer)).applied, false);
    assert.equal(events.length, 0);
  }
});

test('ordering reports failure when the page ignores keyboard movement', async () => {
  const { api, container } = setup(false);
  assert.equal((await api.answers.apply(container, desired)).applied, false);
});

test('ordering accepts an already correct order without events', async () => {
  const { api, container, events } = setup();
  assert.equal((await api.answers.apply(container,
    ['norming', 'forming', 'storming', 'performing'])).applied, true);
  assert.equal(events.length, 0);
});

test('draggable ordering uses native drag events and verifies placement', async () => {
  const { api, container, items, events } = setup(true, true);
  assert.equal((await api.answers.apply(container, desired)).applied, true);
  assert.deepEqual(items.map(item => item.querySelector().textContent), desired);
  assert.deepEqual(events.slice(0, 5).map(event => event.type),
    ['dragstart', 'dragenter', 'dragover', 'drop', 'dragend']);
  assert.equal(events.some(event => event.type === 'keydown'), false);
});

test('ignored native drag does not report success and always ends the drag', async () => {
  const { api, container, events } = setup(false, true);
  assert.equal((await api.answers.apply(container, desired)).applied, false);
  assert.equal(events.at(-1).type, 'dragend');
});
