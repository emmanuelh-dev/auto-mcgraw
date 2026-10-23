(() => {
  const { messaging, MessageType: T, wait } = AutoMcGraw;
  let active = false;
  let session = null;
  let cancelled = false;

  messaging.handle(T.QUEUE_CANCEL, () => {
    cancelled = true;
    active = false;
    session?.stop();
  });

  async function attach(candidate, isReady) {
    session = candidate;
    if (!await wait.waitFor(isReady, { timeout: 30000, interval: 500 })) return;
    const response = await messaging.send({ type: T.QUEUE_CLAIM });
    if (!response?.claimed || cancelled) return;
    active = true;
    session.start();
  }

  function changed() {
    if (!active || session?.isRunning()) return;
    active = false;
    messaging.send({ type: T.QUEUE_STOPPED }).catch(console.error);
  }

  AutoMcGraw.assignmentQueue = { attach, changed };
})();
