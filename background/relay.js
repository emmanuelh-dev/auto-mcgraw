(() => {
  const { MessageType, assistants, settings, tabs, prompt, wait } = AutoMcGraw;

  const FOCUS_SETTLE_MS = 300;
  const LOG_PREFIX = "[Auto-McGraw]";

  let queue = Promise.resolve();

  async function bringToFront(tab, otherTab) {
    if (!tab || !otherTab || tab.windowId !== otherTab.windowId) return;
    await tabs.activate(tab.id);
    await wait.delay(FOCUS_SETTLE_MS);
  }

  async function deliver(tabId, message) {
    try {
      await tabs.send(tabId, message);
    } catch (error) {
      console.error(LOG_PREFIX, "Could not reach the McGraw Hill tab:", error);
    }
  }

  function reportError(tabId, requestId, error, fatal) {
    return deliver(tabId, {
      type: MessageType.ASSISTANT_ERROR,
      requestId,
      error,
      fatal,
    });
  }

  function contentScriptFiles(match) {
    const entry = chrome.runtime
      .getManifest()
      .content_scripts.find((script) => script.matches.includes(match));
    return entry ? entry.js : [];
  }

  async function ensureAssistantScript(tabId, assistant) {
    try {
      await tabs.send(tabId, { type: MessageType.PING }, { attempts: 1 });
      return;
    } catch {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: contentScriptFiles(assistant.match),
      });
    }
  }

  async function relayQuestion({ question, requestId }, sourceTab) {
    const values = await settings.load();
    const { aiModel, deepseekApiModel } = values;
    if (values[`${aiModel}Mode`] === "api") {
      try {
        const answer = await AutoMcGraw.deepseekApi.ask(prompt.build(question, true), deepseekApiModel, aiModel);
        await deliver(sourceTab.id, { type: MessageType.ASSISTANT_ANSWER, answer, requestId });
      } catch (error) {
        await reportError(sourceTab.id, requestId, error.message, true);
      }
      return;
    }
    const assistant = assistants.get(aiModel);
    if (assistant.id === "notebooklm" && !assistants.normalizeNotebookUrl(values.notebookUrl)) {
      await reportError(sourceTab.id, requestId, "Configure a valid NotebookLM notebook URL in settings first.", true);
      return;
    }
    const assistantTab = await tabs.findByMatch(
      assistant.matches || assistant.match,
      assistant.id === "notebooklm"
        ? (tab) => assistants.matchesNotebookUrl(tab.url, values.notebookUrl)
        : undefined
    );

    if (!assistantTab) {
      await reportError(
        sourceTab.id,
        requestId,
        assistant.id === "notebooklm"
          ? "Please open the configured NotebookLM notebook in another tab before using automation."
          : `Please open ${assistant.name} in another tab before using automation.`,
        true
      );
      return;
    }

    try {
      await bringToFront(assistantTab, sourceTab);
      await ensureAssistantScript(assistantTab.id, assistant);
      await tabs.send(assistantTab.id, {
        type: MessageType.PROMPT_ASSISTANT,
        prompt: prompt.build(question),
        requestId,
        replyTo: sourceTab.id,
      });
    } catch (error) {
      console.error(LOG_PREFIX, "Error sending question to assistant:", error);
      await reportError(
        sourceTab.id,
        requestId,
        `Error communicating with ${assistant.name}. Please make sure it's open in another tab, then try again.`,
        false
      );
    }
  }

  function enqueueQuestion(message, sourceTab) {
    queue = queue
      .then(() => relayQuestion(message, sourceTab))
      .catch((error) => console.error(LOG_PREFIX, error));
    return queue;
  }

  async function forwardAnswer({ answer, requestId, replyTo }, assistantTab) {
    const target = await tabs.get(replyTo);
    if (!target) return;

    await bringToFront(target, assistantTab);
    await deliver(target.id, {
      type: MessageType.ASSISTANT_ANSWER,
      answer,
      requestId,
    });
  }

  async function forwardError({ error, requestId, replyTo }, assistantTab) {
    const target = await tabs.get(replyTo);
    if (!target) return;

    await bringToFront(target, assistantTab);
    await reportError(target.id, requestId, error, false);
  }

  AutoMcGraw.relay = { enqueueQuestion, forwardAnswer, forwardError };
})();
