(() => {
  const { messaging, MessageType: T } = AutoMcGraw;
  const KEY = "assignmentQueue";
  const ownerURL = /^https:\/\/newconnect\.mheducation\.com\/student\/class\/section\/\d+(?:[/?#]|$)/;
  const activityURL = /^https:\/\/(?:learning\.mheducation\.com\/static\/awd\/|ezto\.mheducation\.com\/)/;
  let pending = Promise.resolve();

  async function read() {
    return (await chrome.storage.session.get(KEY))[KEY] || null;
  }

  async function send(tabId, message) {
    try { await chrome.tabs.sendMessage(tabId, message); } catch {}
  }

  async function save(queue) {
    await chrome.storage.session.set({ [KEY]: queue });
    if (queue) await send(queue.ownerId, { type: T.QUEUE_STATE, queue });
  }

  function serial(task) {
    const result = pending.then(task);
    pending = result.catch((error) => console.error("[Auto-McGraw queue]", error));
    return result;
  }

  function handle(type, handler) {
    messaging.handle(type, (message, sender) => serial(() => handler(message, sender)));
  }

  function owned(queue, sender) {
    return queue && sender.frameId === 0 && queue.ownerId === sender.tab?.id && ownerURL.test(sender.url || sender.tab?.url || "");
  }

  handle(T.QUEUE_START, async ({ items }, sender) => {
    if (sender.frameId !== 0 || !ownerURL.test(sender.url || "")) return { ok: false };
    const existing = await read();
    if (existing) return { ok: false, error: "Stop the existing queue first." };
    if (!Array.isArray(items) || !items.length || items.length > 500 || items.some((item) => !/^\d+~\d+$/.test(item.id) || typeof item.title !== "string")) return { ok: false };
    const queue = { id: crypto.randomUUID(), ownerId: sender.tab.id, items: items.map(({ id, title }) => ({ id, title })), index: 0, phase: "ready", childId: null };
    await save(queue);
    return { ok: true, queue };
  });

  handle(T.QUEUE_STATE, async (_, sender) => {
    const queue = await read();
    return { ok: true, queue: owned(queue, sender) ? queue : null };
  });

  handle(T.QUEUE_LAUNCH, async (_, sender) => {
    const queue = await read();
    if (!owned(queue, sender) || queue.phase !== "ready") return { ok: false };
    queue.phase = "launching";
    await save(queue);
    return { ok: true };
  });

  chrome.tabs.onCreated.addListener((tab) => serial(async () => {
    const queue = await read();
    if (queue?.phase !== "launching" || tab.openerTabId !== queue.ownerId || queue.childId !== null) return;
    queue.childId = tab.id;
    await save(queue);
  }));

  handle(T.QUEUE_CLAIM, async (_, sender) => {
    const queue = await read();
    const rejected = (reason) => ({ ok: true, claimed: false, reason, phase: queue?.phase || null, expectedTab: queue?.childId ?? null, actualTab: sender.tab?.id ?? null });
    if (!queue) return rejected("No active assignment queue");
    if (sender.frameId !== 0 || !activityURL.test(sender.url || "")) return rejected("Unsupported activity URL or frame");
    if (queue.phase === "launching" && queue.childId === null &&
        (sender.tab?.id === queue.ownerId || sender.tab?.openerTabId === queue.ownerId)) {
      queue.childId = sender.tab.id;
    }
    if (queue.childId !== sender.tab?.id) return rejected("Activity tab does not match the tab registered by the queue");
    const resumed = queue.phase === "running" && sender.documentId && sender.documentId !== queue.documentId;
    if (queue.phase !== "launching" && !resumed) return rejected("Queue is not launching or this document already claimed it");
    queue.phase = "running";
    queue.documentId = sender.documentId || null;
    await save(queue);
    return { ok: true, claimed: true };
  });

  handle(T.QUEUE_STOPPED, async (_, sender) => {
    const queue = await read();
    if (!queue || queue.childId !== sender.tab?.id || sender.frameId !== 0 || queue.phase !== "running") return { ok: false };
    queue.phase = "review";
    await save(queue);
    await chrome.tabs.update(queue.ownerId, { active: true });
    return { ok: true };
  });

  handle(T.QUEUE_VERIFY, async ({ status }, sender) => {
    const queue = await read();
    if (!owned(queue, sender) || !["ready", "review", "launching"].includes(queue.phase)) return { ok: false };
    if (!/^(?:completed|submitted)(?:\s*[,.:]\s*.*)?$/i.test(status?.trim() || "") || /\b(?:not|incomplete|unsubmitted)\b/i.test(status)) return { ok: false, error: "Connect has not confirmed completion. Review the activity, then check again." };
    if (queue.childId !== null) await send(queue.childId, { type: T.QUEUE_CANCEL });
    queue.index += 1;
    queue.childId = null;
    queue.documentId = null;
    queue.phase = queue.index === queue.items.length ? "done" : "ready";
    await save(queue);
    if (queue.phase === "done") await chrome.storage.session.remove(KEY);
    return { ok: true, queue };
  });

  handle(T.QUEUE_STOP, async (_, sender) => {
    const queue = await read();
    if (!owned(queue, sender)) return { ok: false };
    await chrome.storage.session.remove(KEY);
    if (queue.childId !== null) await send(queue.childId, { type: T.QUEUE_CANCEL });
    return { ok: true };
  });

  chrome.tabs.onRemoved.addListener((id) => serial(async () => {
    const queue = await read();
    if (!queue) return;
    if (id === queue.ownerId) {
      await chrome.storage.session.remove(KEY);
      if (queue.childId !== null) await send(queue.childId, { type: T.QUEUE_CANCEL });
    } else if (id === queue.childId) {
      queue.phase = "review";
      await save(queue);
    }
  }));
})();
