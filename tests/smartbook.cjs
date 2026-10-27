const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('SmartBook clicks confidence and Next even with the legacy pause enabled', async () => {
  let step;
  const actions = [];
  let moved = false;
  const container = { querySelector: () => null };
  const document = {
    querySelector(selector) {
      if (selector.includes('confidence-buttons--high_confidence')) {
        return { click: () => actions.push('High') };
      }
      if (selector === '.next-button') return { click: () => { actions.push('Next'); moved = true; } };
      return null;
    },
  };
  vm.runInNewContext(fs.readFileSync('content/smartbook/main.js', 'utf8'), {
    document, console,
    AutoMcGraw: {
      settings: { DEFAULTS: { pauseBeforeSubmit: true }, subscribe() {}, load: async () => ({ pauseBeforeSubmit: true }) },
      automation: { create: (options) => { step = options.step; return { isRunning: () => false }; } },
      toolbar: { create: () => ({ render() {} }), keepMounted() {} },
      questions: {
        findContainer: () => container, isAnswerable: () => true,
        signature: () => moved ? 'next question' : 'question', parse: () => ({}), extractCorrection: () => null,
      },
      answers: { apply: async () => ({ applied: true, lines: [] }) },
      doubleCredit: { claim: async () => null },
      assignmentQueue: { changed() {}, attach() {} },
    },
  });
  await step({
    ask: async () => ({ answer: 'answer' }), checkpoint() {}, delay: async () => actions.push('fixed delay'),
    waitFor: async (predicate) => predicate(),
    waitForUser: async () => actions.push('pause'),
  });
  assert.deepEqual(actions, ['High', 'Next']);
});
