const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function setup({ progress = '20 of 20', confirmation = true, pause = false, submitted = true, worksheet = false, next = false, changesQuestion = true, loadingPolls = 0 } = {}) {
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
  const nextButton = button('Next', () => { if (changesQuestion) stage = 'next'; });
  nextButton.classList = { contains: () => false };
  const hiddenNext = { ...nextButton, getClientRects: () => [], click: () => actions.push('hidden Next') };
  const document = {
    querySelector(selector) {
      if (selector === '.question, .worksheet__main' && loadingPolls > 0) { loadingPolls--; return null; }
      if (selector === '.question, .worksheet__main') return { textContent: stage === 'next' ? 'Next question' : 'Question' };
      if (selector === '.answers-wrap.multiple-choice') return worksheet ? null : {};
      if (selector === '.footer__progress__heading') return { textContent: progress };
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '.footer__link--next:not([hidden])') return next ? [hiddenNext, nextButton] : [];
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
      eztoGrouping: { answerValues: () => ['Group -> choice'], read: () => worksheet, options: () => ({ prompts: ['Group'], choices: ['choice'], multiple: true }), apply: async () => { actions.push('group'); return true; } },
      dom: { isEnabled: (element) => !element.disabled },
      assignmentQueue: { changed() {}, attach() {}, returnToAssignments: async (element) => element.click() },
    },
  });
  return { actions, step: () => step({
    ask: async () => ({ answer: 'choice' }), delay: async () => {},
    waitFor: async (get) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const value = get();
        if (value) return value;
      }
      return null;
    }, waitForUser: async () => actions.push('pause'),
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

test('Next uses the visible button and verifies the question changed', async () => {
  const fixture = setup({ progress: '6 of 25', worksheet: true, next: true });
  await fixture.step();
  assert.deepEqual(fixture.actions, ['group', 'Next']);
});

test('ignored Next stops instead of answering the same question again', async () => {
  const fixture = setup({ progress: '6 of 25', next: true, changesQuestion: false });
  await fixture.step();
  assert.deepEqual(fixture.actions, ['answer', 'Next', 'Next did not change the question. Review the quiz.']);
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

test('worksheet grouping advances automatically even when pause before submit is enabled', async () => {
  const fixture = setup({ worksheet: true, pause: true, progress: '6 of 25', next: true });
  await fixture.step();
  assert.deepEqual(fixture.actions, ['group', 'Next']);
});

test('iframe grouping accepts semicolon mappings and verifies keyboard placement', async () => {
  const labels = ['First label', 'Second label'].map((textContent, id) => ({
    textContent, getAttribute: () => String(id),
    querySelector: () => null, focus() { root.activeElement = this; },
  }));
  let announcement = 'Ready';
  let pending;
  let clone;
  const placed = [];
  const zone = { querySelectorAll: () => placed };
  const root = {
    querySelector: (selector) => selector === '#label-list' ? {} : { textContent: announcement },
    querySelectorAll: (selector) => selector === '#label-list [labelid]' ? labels : selector === '.groups'
      ? [{ querySelector: (selector) => selector === 'h3' ? { textContent: 'Group (1/1)' } : zone }]
      : selector === '.label-lifted[labelid]' ? (clone ? [clone] : []) : placed,
  };
  const context = vm.createContext({ document: { querySelectorAll: () => [{ contentDocument: root }] },
    AutoMcGraw: { text: { isAnswerMatch: (a, b) => a === b, flattenAnswerValues: (value) => [String(value)] }, dom: {
      KEYS: { space: { key: ' ' } }, pressKey(element, key) {
        if (key.key === ' ') {
          if (element.lifted) {
            placed.push(labels[element.id]);
            announcement = 'Dropped';
            clone = null;
          } else {
            pending = () => {
              clone = { id: labels.indexOf(element), lifted: true,
                getAttribute: () => element.getAttribute('labelid'),
                focus() { root.activeElement = this; } };
              announcement = 'Lifted';
            };
          }
        } else if (key.key === 'ArrowRight') {
          assert.equal(element, clone);
          assert.equal(root.activeElement, clone);
          pending = () => { announcement = 'Group , selected'; };
        }
      },
    } },
  });
  vm.runInContext(fs.readFileSync('content/ezto/grouping.js', 'utf8'), context);
  const run = { delay: async () => {}, waitFor: async (get) => {
    const immediate = get();
    if (immediate) return immediate;
    pending?.();
    pending = null;
    return get();
  } };
  const apply = context.AutoMcGraw.eztoGrouping.apply;
  assert.equal(await apply(['Group -> First label; Group -> Second label;'], run), true);
  assert.deepEqual(placed, labels);
  for (const answer of [
    { Group: ['First label', 'Second label'] },
    { 'Group -> First label': 'Group -> First label', 'Group -> Second label': 'Group -> Second label' },
    [{ prompt: 'Group', choice: 'First label' }, { prompt: 'Group', choice: 'Second label' }],
    [{ Group: 'First label' }, { Group: 'Second label' }],
  ]) {
    placed.length = 0;
    assert.equal(await apply(answer, run), true);
    assert.deepEqual(placed, labels);
  }
  placed.length = 0;
  assert.equal(await apply(['Group -> First label; Group -> Unknown'], run), false);
  assert.equal(placed.length, 0);
  assert.equal(await apply(['Group -> First label -> Other -> First label; Group -> Second label'], run), false);
  assert.equal(placed.length, 0);
});

test('waits for a delayed question before answering and advancing', async () => {
  const fixture = setup({ loadingPolls: 3, next: true, progress: '6 of 25' });
  await fixture.step();
  assert.deepEqual(fixture.actions, ['answer', 'Next']);
});
