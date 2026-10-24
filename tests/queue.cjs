const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { webcrypto } = require('node:crypto');

function setup() {
  const handlers = new Map();
  const events = {};
  const sent = [];
  let stored = {};
  const context = {
    console, crypto: webcrypto,
    AutoMcGraw: { messaging: { handle: (type, handler) => handlers.set(type, handler) }, MessageType: Object.fromEntries(['START','STATE','LAUNCH','CLAIM','STOPPED','VERIFY','STOP','CANCEL'].map((key) => [`QUEUE_${key}`, key])) },
    chrome: {
      storage: { session: {
        get: async () => structuredClone(stored),
        set: async (value) => { stored = structuredClone(value); },
        remove: async (key) => { delete stored[key]; },
      } },
      tabs: {
        sendMessage: async (id, message) => sent.push({ id, message }),
        update: async () => {},
        onCreated: { addListener: (fn) => { events.created = fn; } },
        onRemoved: { addListener: (fn) => { events.removed = fn; } },
      },
    },
  };
  vm.runInNewContext(fs.readFileSync('background/queue.js', 'utf8'), context);
  const owner = { frameId: 0, url: 'https://newconnect.mheducation.com/student/class/section/157709363', tab: { id: 1 } };
  const child = { frameId: 0, url: 'https://learning.mheducation.com/static/awd/index.html', tab: { id: 2 } };
  const call = (type, message = {}, sender = owner) => handlers.get(type)(message, sender);
  const start = () => call('START', { items: [{ id: '157709363~1', title: 'SmartBook' }, { id: '157709363~2', title: 'Quiz' }] });
  const state = () => stored.assignmentQueue;
  return { call, start, state, events, owner, child, sent };
}

test('only owner can launch or stop; children must be opened by owner and claim once', async () => {
  const q = setup();
  await q.start();
  assert.equal((await q.call('LAUNCH', {}, q.child)).ok, false);
  await q.call('LAUNCH');
  await q.events.created({ id: 3, openerTabId: 99 });
  assert.equal((await q.call('CLAIM', {}, q.child)).claimed, false);
  await q.events.created({ id: 2, openerTabId: 1 });
  assert.equal((await q.call('CLAIM', {}, { ...q.child, frameId: 1 })).claimed, false);
  assert.equal((await q.call('CLAIM', {}, { ...q.child, url: 'https://example.com/' })).claimed, false);
  assert.equal((await q.call('CLAIM', {}, q.child)).claimed, true);
  assert.equal((await q.call('CLAIM', {}, q.child)).claimed, false);
  assert.equal((await q.call('STOP', {}, q.child)).ok, false);
});

test('queue supports same-tab launches and reused activity tabs across verified handoffs', async () => {
  for (const tab of [{ id: 1 }, { id: 2, openerTabId: 1 }]) {
    const q = setup();
    const activity = { ...q.child, tab };
    await q.start();
    assert.equal((await q.call('CLAIM', {}, activity)).claimed, false);
    for (const status of ['Completed', 'Submitted']) {
      await q.call('LAUNCH');
      assert.equal((await q.call('CLAIM', {}, { ...activity, frameId: 1 })).claimed, false);
      assert.equal((await q.call('CLAIM', {}, { ...activity, url: 'https://example.com/' })).claimed, false);
      assert.equal(q.state().childId, null);
      assert.equal((await q.call('CLAIM', {}, activity)).claimed, true);
      assert.equal(q.state().childId, tab.id);
      assert.equal((await q.call('CLAIM', {}, activity)).claimed, false);
      await q.call('STOPPED', {}, activity);
      assert.equal((await q.call('VERIFY', { status })).ok, true);
    }
    assert.equal(q.state(), undefined);
  }
});

test('reloading the active activity can claim again but the same document cannot', async () => {
  const q = setup();
  await q.start(); await q.call('LAUNCH');
  await q.events.created({ id: 2, openerTabId: 1 });
  const first = { ...q.child, documentId: 'first-document' };
  const reloaded = { ...q.child, documentId: 'reloaded-document' };
  assert.equal((await q.call('CLAIM', {}, first)).claimed, true);
  assert.equal((await q.call('CLAIM', {}, first)).claimed, false);
  assert.equal((await q.call('CLAIM', {}, { ...reloaded, tab: { id: 99 } })).claimed, false);
  assert.equal((await q.call('CLAIM', {}, reloaded)).claimed, true);
  assert.equal((await q.call('CLAIM', {}, reloaded)).claimed, false);
  await q.call('STOPPED', {}, reloaded);
  assert.equal((await q.call('CLAIM', {}, { ...q.child, documentId: 'third-document' })).claimed, false);
});

test('claim rejection identifies absent queue and mismatched activity tab', async () => {
  const q = setup();
  assert.equal((await q.call('CLAIM', {}, q.child)).reason, 'No active assignment queue');
  await q.start(); await q.call('LAUNCH');
  const rejected = await q.call('CLAIM', {}, q.child);
  assert.equal(rejected.claimed, false);
  assert.equal(rejected.phase, 'launching');
  assert.equal(rejected.expectedTab, null);
  assert.equal(rejected.actualTab, 2);
  assert.match(rejected.reason, /does not match/);
});

test('solver stop or missing next never completes an activity; status must confirm', async () => {
  const q = setup();
  await q.start(); await q.call('LAUNCH');
  await q.events.created({ id: 2, openerTabId: 1 });
  await q.call('CLAIM', {}, q.child);
  await q.call('STOPPED', { reason: 'No next button' }, q.child);
  assert.equal(q.state().phase, 'review');
  for (const status of ['', 'Not started yet, 1 Attempt remaining', 'Not completed', 'Incomplete', 'Unsubmitted', 'No next button', 'Completed questions but not submitted', 'Completed 3 of 10 questions']) {
    assert.equal((await q.call('VERIFY', { status })).ok, false, status);
    assert.equal(q.state().index, 0);
  }
  assert.equal((await q.call('VERIFY', { status: 'Completed' }, q.child)).ok, false);
  assert.equal((await q.call('VERIFY', { status: 'Completed' })).ok, true);
  assert.equal(q.state().index, 1);
  assert.equal(q.state().phase, 'ready');
  assert.equal(q.state().childId, null);
});

test('stop clears pending work and cancels active solver without closing tabs', async () => {
  const q = setup();
  await q.start(); await q.call('LAUNCH');
  await q.events.created({ id: 2, openerTabId: 1 });
  await q.call('CLAIM', {}, q.child);
  await q.call('STOP');
  assert.equal(q.state(), undefined);
  assert.ok(q.sent.some(({ id, message }) => id === 2 && message.type === 'CANCEL'));
  assert.equal((await q.call('CLAIM', {}, q.child)).claimed, false);
});

test('closing activity pauses and closing class cancels', async () => {
  const q = setup();
  await q.start(); await q.call('LAUNCH');
  await q.events.created({ id: 2, openerTabId: 1 });
  await q.events.removed(2);
  assert.equal(q.state().phase, 'review');
  await q.events.removed(1);
  assert.equal(q.state(), undefined);
});

test('invalid and overlapping queues are rejected', async () => {
  const q = setup();
  assert.equal((await q.call('START', { items: [] })).ok, false);
  assert.equal((await q.call('START', { items: [{ id: 'invalid', title: 'x' }] })).ok, false);
  await q.start();
  assert.equal((await q.start()).ok, false);
});

test('complete queue clears storage only after each separate verified handoff', async () => {
  const q = setup();
  await q.start();
  for (const title of ['Completed', 'Submitted']) {
    await q.call('LAUNCH');
    await q.events.created({ id: 2, openerTabId: 1 });
    await q.call('CLAIM', {}, q.child);
    assert.equal((await q.call('VERIFY', { status: title })).ok, false);
    await q.call('STOPPED', {}, q.child);
    assert.equal((await q.call('VERIFY', { status: title })).ok, true);
  }
  assert.equal(q.state(), undefined);
});

function clientSetup(document, waitFor = async (ready) => ready()) {
  const handlers = new Map();
  const sent = [];
  let claim;
  let starts = 0;
  let running = false;
  const context = {
    console, document,
    AutoMcGraw: {
      messaging: {
        handle: (type, handler) => handlers.set(type, handler),
        send: async (message) => {
          sent.push(message);
          if (message.type === 'CLAIM') return new Promise((resolve) => { claim = resolve; });
        },
      },
      MessageType: { QUEUE_CANCEL: 'CANCEL', QUEUE_CLAIM: 'CLAIM', QUEUE_STOPPED: 'STOPPED' },
      wait: { waitFor },
    },
  };
  vm.runInNewContext(fs.readFileSync('content/mhe/queue.js', 'utf8'), context);
  const client = context.AutoMcGraw.assignmentQueue;
  const session = {
    start() { starts += 1; running = true; client.changed(); },
    stop() { running = false; client.changed(); },
    isRunning: () => running,
  };
  return { client, session, handlers, sent, resolve: (value) => claim(value), starts: () => starts };
}

test('cancel during claim prevents a delayed response from starting solver', async () => {
  const q = clientSetup();
  const attaching = q.client.attach(q.session, () => true);
  await new Promise(setImmediate);
  q.handlers.get('CANCEL')();
  q.resolve({ claimed: true });
  await attaching;
  assert.equal(q.starts(), 0);
});

test('unsupported activity never claims; normal stop notifies owner once', async () => {
  const unsupported = clientSetup();
  await unsupported.client.attach(unsupported.session, () => false);
  assert.equal(unsupported.sent.length, 0);
  const q = clientSetup();
  const attaching = q.client.attach(q.session, () => true);
  await new Promise(setImmediate);
  q.resolve({ claimed: true }); await attaching;
  assert.equal(q.starts(), 1);
  q.session.stop(); q.client.changed();
  assert.equal(q.sent.filter((message) => message.type === 'STOPPED').length, 1);
});

test('summary returns to assignments once, stops solver and requests verification', async () => {
  const q = clientSetup();
  let clicks = 0;
  const button = { click: () => { clicks += 1; }, disabled: false };
  assert.equal(await q.client.returnToAssignments(button), false);
  const attaching = q.client.attach(q.session, () => true);
  await new Promise(setImmediate);
  q.resolve({ claimed: true });
  await attaching;
  assert.equal(await q.client.returnToAssignments({ ...button, disabled: true }), false);
  assert.equal(await q.client.returnToAssignments(button), true);
  assert.equal(q.session.isRunning(), false);
  assert.equal(clicks, 1);
  assert.equal(q.sent.filter(message => message.type === 'STOPPED').length, 1);
  assert.equal(await q.client.returnToAssignments(button), false);
  assert.equal(clicks, 1);
});

test('intro Continue is clicked only after queue claim and solver waits for its dismissal', async () => {
  let intro = true;
  let clicks = 0;
  const q = clientSetup({ querySelector: () => intro ? { click() { clicks += 1; intro = false; } } : null });
  const attaching = q.client.attach(q.session, () => !intro);
  await new Promise(setImmediate);
  assert.equal(clicks, 0);
  assert.equal(q.starts(), 0);
  q.resolve({ claimed: true });
  await attaching;
  assert.equal(clicks, 1);
  assert.equal(q.starts(), 1);
});

test('Start Questions is an alternative intro button, even when the page header is ready', async () => {
  let intro = true;
  let clicks = 0;
  const q = clientSetup({ querySelector: selector =>
    intro && selector.includes('button[data-automation-id="welcome--start_button"]:not([disabled])')
      ? { click() { clicks += 1; intro = false; } }
      : null,
  });
  const attaching = q.client.attach(q.session, () => true);
  await new Promise(setImmediate);
  assert.equal(clicks, 0);
  q.resolve({ claimed: true });
  await attaching;
  assert.equal(clicks, 1);
  assert.equal(q.starts(), 1);
});

test('rendering during intro transition does not report the queue as stopped', async () => {
  let intro = true;
  const q = clientSetup({ querySelector: () => intro ? {
    click() {
      q.client.changed();
      intro = false;
    },
  } : null });
  const attaching = q.client.attach(q.session, () => !intro);
  await new Promise(setImmediate);
  q.resolve({ claimed: true });
  await attaching;
  assert.equal(q.starts(), 1);
  assert.equal(q.sent.filter(message => message.type === 'STOPPED').length, 0);
  q.session.stop();
  assert.equal(q.sent.filter(message => message.type === 'STOPPED').length, 1);
});

test('late intro remains eligible after the initial page load', async () => {
  let intro = false;
  let release;
  let clicks = 0;
  const q = clientSetup({ querySelector: () => intro ? {
    click() { clicks += 1; intro = false; },
  } : null }, async (ready, options) => {
    if (ready()) return true;
    assert.equal(options.timeout, Infinity);
    return new Promise(resolve => { release = () => resolve(ready()); });
  });
  const attaching = q.client.attach(q.session, () => clicks > 0);
  intro = true;
  release();
  await new Promise(setImmediate);
  q.resolve({ claimed: true });
  await attaching;
  assert.equal(clicks, 1);
  assert.equal(q.starts(), 1);
});

test('direct SmartBook session returns from summary without an active queue', async () => {
  const q = clientSetup({ querySelector: () => null });
  const attaching = q.client.attach(q.session, () => true);
  await new Promise(setImmediate);
  q.resolve({ claimed: false });
  await attaching;
  q.session.start();
  let clicks = 0;
  const button = { click() { clicks++; } };
  assert.equal(await q.client.returnToAssignments(button), true);
  assert.equal(await q.client.returnToAssignments(button), false);
  assert.equal(clicks, 1);
  assert.equal(q.session.isRunning(), false);
  assert.equal(q.sent.filter(message => message.type === 'STOPPED').length, 0);
});
