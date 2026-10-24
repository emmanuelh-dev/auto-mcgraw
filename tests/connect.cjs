const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('Connect expands collapsed groups after return, verifies completion and launches the next queued activity', async () => {
  const controls = new Map();
  const events = [];
  let expanded = false;
  let panelId = null;
  let queue = { id: 'queue', index: 0, phase: 'review', childId: 2, items: [
    { id: 'first', title: 'Ch 1 Quiz' }, { id: 'second', title: 'Ch 2 Quiz' },
  ] };
  const control = (id) => {
    if (!controls.has(id)) controls.set(id, { querySelectorAll: () => [] });
    return controls.get(id);
  };
  const folder = {
    getAttribute: (name) => name === 'aria-expanded' ? String(expanded) : 'region',
    click: () => { expanded = true; events.push('expand'); },
  };
  const launch = (id) => ({
    getAttribute: () => null, querySelector: () => null,
    click: () => { panelId = id; events.push(`panel:${id}`); },
  });
  const panel = () => ({ querySelector: (selector) => {
    if (selector.includes('right-side-panel-header')) return { textContent: queue.items[queue.index].title };
    if (selector === '.attempt-detail') return { textContent: panelId === 'first' ? 'Submitted' : 'Not started' };
    if (selector.includes('rhp-launch-assignment-button')) return { textContent: 'Begin', click: () => events.push('begin') };
    return null;
  } });
  const document = {
    getElementById: (id) => id === 'region' ? { classList: { contains: (name) => name === 'show' && expanded } } : null,
    createElement: () => ({ style: {}, attachShadow: () => ({ getElementById: control }) }),
    documentElement: { appendChild() {} },
    querySelectorAll: () => [folder],
    querySelector: (selector) => {
      if (selector.includes('assignment-folder-list')) return folder;
      if (selector.includes('right-panel-close-button')) return panelId ? { click: () => { panelId = null; } } : null;
      if (selector === '[data-automation-id="right-panel"]') return panelId ? panel() : null;
      if (selector.includes('launch-btn-')) return expanded ? launch(selector.includes('first') ? 'first' : 'second') : null;
      return null;
    },
  };
  const types = Object.fromEntries(['API_CONFIG', 'QUEUE_STATE', 'QUEUE_VERIFY', 'QUEUE_LAUNCH'].map(key => [key, key]));
  vm.runInNewContext(fs.readFileSync('content/connect/main.js', 'utf8'), {
    document, AutoMcGraw: {
      MessageType: types, wait: { waitFor: async (predicate) => predicate() },
      messaging: { handle() {}, send: async ({ type }) => {
        if (type === types.API_CONFIG) return {};
        if (type === types.QUEUE_VERIFY) {
          events.push('verify');
          queue = { ...queue, index: 1, phase: 'ready', childId: null };
        }
        if (type === types.QUEUE_LAUNCH) {
          events.push('launch');
          queue.phase = 'launching';
        }
        return { ok: true, queue };
      } },
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['expand', 'panel:first', 'verify', 'panel:second', 'launch', 'begin']);
});
