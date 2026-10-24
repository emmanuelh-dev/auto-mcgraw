importScripts(
  "../shared/namespace.js",
  "../shared/assistants.js",
  "../shared/settings.js",
  "../shared/messaging.js",
  "../shared/wait.js",
  "tabs.js",
  "prompt.js",
  "deepseek-api.js",
  "relay.js",
  "double-credit.js",
  "queue.js"
);

(() => {
  const { MessageType, messaging, relay, doubleCredit } = AutoMcGraw;

  chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

  const SETTINGS_WINDOW = { width: 440, height: 720 };

  function logError(error) {
    console.error("[Auto-McGraw]", error);
  }

  function inBackground(task) {
    task.catch(logError);
  }

  messaging.handle(MessageType.API_CONFIG, async (message, sender) => {
    if (sender.frameId !== 0 || !/^https:\/\/newconnect\.mheducation\.com\/student\/class\/section\/\d+(?:[/?#]|$)/.test(sender.url || "")) return { ok: false };
    const values = await AutoMcGraw.settings.load();
    const provider = message.provider || values.aiModel;
    if (!["deepseek", "chatgpt", "gemini"].includes(provider)) return { ok: false };
    const keyName = `${provider}ApiKey`;
    if (message.mode !== undefined) {
      if (!["browser", "api"].includes(message.mode)) return { ok: false };
      if (message.key) {
        await chrome.storage.local.set({ [keyName]: message.key.trim() });
      }
      await AutoMcGraw.settings.save({ ...(message.mode === "api" ? { aiModel: provider } : {}), [`${provider}Mode`]: message.mode });
    }
    const current = await AutoMcGraw.settings.load();
    const credentials = await chrome.storage.local.get(keyName);
    return { ok: true, provider: current.aiModel, mode: current[`${current.aiModel}Mode`], hasKey: Boolean(credentials[`${current.aiModel}ApiKey`]) };
  });

  messaging.handle(MessageType.ASK_QUESTION, (message, sender) => {
    if (!sender.tab) {
      return { ok: false, error: "Questions must come from a tab." };
    }
    inBackground(relay.enqueueQuestion(message, sender.tab));
  });

  messaging.handle(MessageType.ASSISTANT_ANSWER, (message, sender) => {
    inBackground(relay.forwardAnswer(message, sender.tab));
  });

  messaging.handle(MessageType.ASSISTANT_ERROR, (message, sender) => {
    inBackground(relay.forwardError(message, sender.tab));
  });

  messaging.handle(MessageType.OPEN_SETTINGS, async () => {
    await chrome.windows.create({
      url: chrome.runtime.getURL("popup/settings.html"),
      type: "popup",
      ...SETTINGS_WINDOW,
    });
  });

  messaging.handle(MessageType.OPEN_DUPLICATE, (message, sender) =>
    doubleCredit.open(message, sender.tab)
  );

  messaging.handle(MessageType.CLAIM_DUPLICATE, (message, sender) =>
    doubleCredit.claim(sender.tab)
  );

  messaging.handle(MessageType.DUPLICATE_FINISHED, (message, sender) => {
    inBackground(doubleCredit.finish(message, sender.tab));
  });

  messaging.handle(MessageType.CANCEL_DUPLICATE, () => doubleCredit.cancel());

  chrome.tabs.onRemoved.addListener((tabId) => {
    inBackground(doubleCredit.handleTabRemoved(tabId));
  });
})();
