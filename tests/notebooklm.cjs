const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const notebookUrl = 'https://notebook.google.com/notebook/9fa6d80b-ff54-4092-8add-93b5e06fdd23';
function load(context, file) {
  vm.runInNewContext(readFileSync(file, 'utf8'), context);
}
function setup(url = notebookUrl) {
  const sent = [];
  const context = { URL, console, AutoMcGraw: {}, chrome: { tabs: { query: async () => [
    { id: 2, url: notebookUrl.replace('9fa6d80b', 'aaaaaaaa'), lastAccessed: 100 },
    { id: 3, url: notebookUrl.replace('notebook.google', 'notebooklm.google'), lastAccessed: 1 },
  ], sendMessage: async (id, message) => sent.push({ id, ...message }) } } };
  load(context, 'shared/assistants.js');
  Object.assign(context.AutoMcGraw, {
    MessageType: { PING: 'ping', PROMPT_ASSISTANT: 'prompt', ASSISTANT_ERROR: 'error' },
    settings: { load: async () => ({ aiModel: 'notebooklm', notebookUrl: url }) },
    prompt: { build: () => 'test prompt' }, wait: { delay: async () => {} },
  });
  load(context, 'background/tabs.js');
  load(context, 'background/relay.js');
  return { context, sent, assistants: context.AutoMcGraw.assistants };
}
test('NotebookLM URL accepts aliases and removes tracking but rejects other routes and hosts', () => {
  const { assistants: a } = setup();
  assert.equal(a.normalizeNotebookUrl(notebookUrl + '?utm_source=test#chat'), notebookUrl);
  assert.equal(a.matchesNotebookUrl(notebookUrl.replace('notebook.google', 'notebooklm.google'), notebookUrl), true);
  for (const url of [notebookUrl + '/extra', notebookUrl.replace('https:', 'http:'), notebookUrl.replace('google.com', 'google.com.evil.test'), 'https://notebook.google.com/', notebookUrl.replace('https://', 'https://user@')]) {
    assert.equal(a.normalizeNotebookUrl(url), null);
  }
  assert.equal(a.matchesNotebookUrl(notebookUrl.replace('9fa6d80b', 'aaaaaaaa'), notebookUrl), false);
});
test('relay sends only to the configured notebook even when another notebook was accessed later', async () => {
  const { context, sent } = setup();
  await context.AutoMcGraw.relay.enqueueQuestion({ question: {}, requestId: 'r' }, { id: 1 });
  assert.equal(sent.find(message => message.type === 'prompt').id, 3);
  assert.equal(sent.find(message => message.type === 'prompt').replyTo, 1);
});
test('missing notebook configuration stops before sending a prompt', async () => {
  const { context, sent } = setup('');
  await context.AutoMcGraw.relay.enqueueQuestion({ question: {}, requestId: 'r' }, { id: 1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'error');
  assert.equal(sent[0].fatal, true);
});
test('NotebookLM adapter registers response and generation selectors and both manifest hosts', () => {
  let adapter;
  const response = { id: 'response' };
  const context = { AutoMcGraw: { assistantBridge: { register: (id, value) => {
    assert.equal(id, 'notebooklm'); adapter = value;
  } } }, document: {
    querySelectorAll: selector => selector === '.to-user-message-inner-content .message-text-content' ? [response] : [],
    querySelector: selector => selector === 'button[aria-label="Stop generating"]' ? {} : null,
  } };
  load(context, 'content/assistant/notebooklm.js');
  assert.equal(adapter.getResponses()[0], response);
  assert.equal(adapter.isBusy(), true);
  context.document.querySelector = () => null;
  assert.equal(adapter.isBusy(), false);
  const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
  const entry = manifest.content_scripts.find(script => script.js.includes('content/assistant/notebooklm.js'));
  for (const host of setup().assistants.get('notebooklm').matches) {
    assert.ok(entry.matches.includes(host));
    assert.ok(manifest.host_permissions.includes(host));
  }
});
