const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

function setup({ key = 'test-key', status = 200, content = '{"answer":["A -> B"],"explanation":"Match."}', finish = 'stop', network = false, gemini = false } = {}) {
  const calls = [];
  const context = {
    AutoMcGraw: {}, AbortSignal,
    chrome: { storage: { local: { get: async name => ({ [name]: key }) } } },
    fetch: async (...args) => {
      calls.push(args);
      if (network) throw new Error('secret server detail');
      return { ok: status === 200, status, json: async () => gemini ? ({ candidates: [{ finishReason: finish === "stop" ? "STOP" : finish, content: { parts: [{ text: content }] } }] }) : ({ choices: [{ finish_reason: finish, message: { content } }] }) };
    },
  };
  vm.runInNewContext(readFileSync('background/deepseek-api.js', 'utf8'), context);
  return { ask: context.AutoMcGraw.deepseekApi.ask, calls };
}

test('sends JSON request with local key and preserves matching answer', async () => {
  const { ask, calls } = setup();
  assert.deepEqual(JSON.parse(JSON.stringify(await ask('JSON question', 'deepseek-flash'))).answer, ['A -> B']);
  assert.equal(calls[0][0], 'https://api.deepseek.com/chat/completions');
  assert.equal(calls[0][1].headers.Authorization, 'Bearer test-key');
  const body = JSON.parse(calls[0][1].body);
  assert.equal(body.model, 'deepseek-flash');
  assert.equal(body.response_format.type, 'json_object');
});
test('missing key prevents requests', async () => {
  const { ask, calls } = setup({ key: '' });
  await assert.rejects(ask('question', 'deepseek-flash'), /Save a DeepSeek API key/);
  assert.equal(calls.length, 0);
});
for (const status of [401, 402, 429, 500]) {
  test(`reports HTTP ${status} without exposing credentials`, async () => {
    const { ask } = setup({ status });
    await assert.rejects(ask('question', 'deepseek-v4-pro'), error => !error.message.includes('test-key') && /DeepSeek/.test(error.message));
  });
}
for (const options of [{ content: 'invalid' }, { content: '{"answer":[]}' }, { content: '{"answer":null}' }, { finish: 'length' }]) {
  test(`rejects unusable answer ${JSON.stringify(options)}`, async () => {
    await assert.rejects(setup(options).ask('question', 'deepseek-flash'), /incomplete or invalid/);
  });
}
test('network errors are sanitized', async () => {
  await assert.rejects(setup({ network: true }).ask('question', 'deepseek-flash'), /could not be reached or timed out/);
});

test('API relay delivers the existing answer envelope without opening a chat tab', async () => {
  const sent = [];
  const context = {
    AutoMcGraw: {
      MessageType: { ASSISTANT_ANSWER: 'answer', ASSISTANT_ERROR: 'error' },
      settings: { load: async () => ({ aiModel: 'deepseek', deepseekMode: 'api', deepseekApiModel: 'deepseek-flash' }) },
      assistants: { get() { throw new Error('Browser route must not run'); } },
      tabs: { send: async (...args) => sent.push(args) },
      prompt: { build: (question, jsonOnly) => { assert.equal(jsonOnly, true); return question; } },
      deepseekApi: { ask: async () => ({ answer: 'A', explanation: 'Reason.' }) },
    }, console,
  };
  vm.runInNewContext(readFileSync('background/relay.js', 'utf8'), context);
  await context.AutoMcGraw.relay.enqueueQuestion({ question: 'Q', requestId: 'r1' }, { id: 42 });
  assert.equal(sent[0][0], 42);
  assert.equal(sent[0][1].requestId, 'r1');
  assert.equal(sent[0][1].answer.answer, 'A');
  context.AutoMcGraw.deepseekApi.ask = async () => { throw new Error('Balance insufficient'); };
  await context.AutoMcGraw.relay.enqueueQuestion({ question: 'Q', requestId: 'r2' }, { id: 42 });
  assert.equal(sent[1][1].type, 'error');
  assert.equal(sent[1][1].fatal, true);
});

for (const provider of ['chatgpt', 'gemini']) {
  test(`${provider} uses its own endpoint, authentication and JSON response`, async () => {
    const { ask, calls } = setup({ gemini: provider === 'gemini' });
    const reply = await ask('JSON matching question', undefined, provider);
    assert.equal(reply.answer[0], 'A -> B');
    const [url, request] = calls[0];
    const body = JSON.parse(request.body);
    if (provider === 'gemini') {
      assert.match(url, /^https:\/\/generativelanguage.googleapis.com\//);
      assert.equal(request.headers['x-goog-api-key'], 'test-key');
      assert.equal(request.headers.Authorization, undefined);
      assert.equal(body.generationConfig.responseMimeType, 'application/json');
      assert.equal(body.contents[0].parts[0].text, 'JSON matching question');
    } else {
      assert.equal(url, 'https://api.openai.com/v1/chat/completions');
      assert.equal(request.headers.Authorization, 'Bearer test-key');
      assert.equal(body.model, 'gpt-4.1-mini');
      assert.equal(body.thinking, undefined);
    }
  });
  test(`${provider} rejects missing key before network request`, async () => {
    const { ask, calls } = setup({ key: '' });
    await assert.rejects(ask('question', undefined, provider), /API key first/);
    assert.equal(calls.length, 0);
  });
}
test('Gemini rejects truncated output', async () => {
  await assert.rejects(setup({ gemini: true, finish: 'MAX_TOKENS' }).ask('question', undefined, 'gemini'), /incomplete or invalid/);
});
