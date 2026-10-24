const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function setup({ progress = '20 of 20', confirmation = true, pause = false, submitted = true } = {}) {
  let step;
  let stage = 'question';
  const actions = [];
  const button = (name, click) => ({
    textContent: name, disabled: false,
    getClientRects: () => [1], closest: () => null,
    click: () => { actions.push(name); click?.(); },
  });
  const submit = button('Submit', () => { stage = 'confirm'; });
  const confirm = button('confirm', () => { stage = 'submitted'; });
  const exit = button('Exit now');
  const document = {
    querySelector(selector) {
      if (selector === '.question') return { textContent: 'Question' };
      if (selector === '.answers-wrap.multiple-choice') return {};
      if (selector === '.footer__progress__heading') return { textContent: progress };
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '.answers--mc .answer__label--mc') return [{ textContent: 'choice' }];
      if (selector.includes('input[type="radio"]')) return [button('answer')];
      if (selector === 'button, a') return [submit];
      if (selector === '.modal--submit-activity__button--confirm') return stage === 'confirm' && confirmation ? [confirm] : [];
      if (selector.includes('post-submission-content')) return stage === 'submitted' && submitted ? [exit] : [];
      return [];
    },
  };
  const session = { isRunning: () => false };
  vm.runInNewContext(fs.readFileSync('content/ezto/main.js', 'utf8'), {
    document, console,
    AutoMcGraw: {
      settings: { DEFAULTS: { pauseBeforeSubmit: pause }, subscribe() {}, load: async () => ({ pauseBeforeSubmit: pause }) },
      automation: { create: (options) => { step = options.step; return session; } },
      toolbar: { create: () => ({ render() {} }), keepMounted() {} },
      text: { readableText: () => 'Question', flattenAnswerValues: () => ['choice'], resolveChoiceIndices: () => [0] },
      dom: { isEnabled: (element) => !element.disabled },
      assignmentQueue: { changed() {}, attach() {}, returnToAssignments: async (element) => element.click() },
    },
  });
  return { actions, step: () => step({
    ask: async () => ({ answer: 'choice' }), delay: async () => {},
    waitFor: async (get) => get(), waitForUser: async () => actions.push('pause'),
    stop: (reason) => actions.push(reason),
  }) };
}

test('last quiz question submits, confirms and exits after submission', async () => {
  const fixture = setup();
  await fixture.step();
  assert.deepEqual(fixture.actions, ['answer', 'Submit', 'confirm', 'Exit now']);
});

test('missing Next on an intermediate question does not submit', async () => {
  const fixture = setup({ progress: '19 of 20' });
  await fixture.step();
  assert.equal(fixture.actions.includes('Submit'), false);
});

for (const options of [{ confirmation: false }, { submitted: false }]) {
  test(`submission waits for required transition ${JSON.stringify(options)}`, async () => {
    const fixture = setup(options);
    await fixture.step();
    assert.equal(fixture.actions.includes('Exit now'), false);
    assert.match(fixture.actions.at(-1), /Review the quiz/);
  });
}

test('pause setting prevents automatic submission', async () => {
  const fixture = setup({ pause: true });
  await fixture.step();
  assert.deepEqual(fixture.actions, ['answer', 'pause']);
});
