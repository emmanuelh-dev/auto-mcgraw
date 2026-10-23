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

function clientSetup() {
  const handlers = new Map();
  const sent = [];
  let claim;
  let starts = 0;
  let running = false;
  const context = {
    console,
    AutoMcGraw: {
      messaging: {
        handle: (type, handler) => handlers.set(type, handler),
        send: async (message) => {
          sent.push(message);
          if (message.type === 'CLAIM') return new Promise((resolve) => { claim = resolve; });
        },
      },
      MessageType: { QUEUE_CANCEL: 'CANCEL', QUEUE_CLAIM: 'CLAIM', QUEUE_STOPPED: 'STOPPED' },
      wait: { waitFor: async (ready) => ready() },
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
