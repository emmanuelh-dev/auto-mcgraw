(() => {
  const { messaging, MessageType: T, wait } = AutoMcGraw;
  let active = false;
  let session = null;
  let cancelled = false;
  let returnedButton = null;

  messaging.handle(T.QUEUE_CANCEL, () => {
    cancelled = true;
    active = false;
    session?.stop();
  });

  async function attach(candidate, isReady) {
    session = candidate;
    const introButton = () => typeof document === "undefined" ? null : document.querySelector('button.intro__footer__start[aria-label="Continue"]:not([disabled]), button[data-automation-id="welcome--start_button"]:not([disabled])');
    if (!await wait.waitFor(() => cancelled || introButton() || isReady(), { timeout: Infinity, interval: 500 }) || cancelled) return;
    const response = await messaging.send({ type: T.QUEUE_CLAIM });
    if (!response?.claimed || cancelled) {
      if (!cancelled) console.warn("[Auto-McGraw] Intro button was not clicked:", JSON.stringify(response));
      return;
    }
    const intro = introButton();
    if (intro) {
      intro.click();
      const ready = await wait.waitFor(() => !introButton() && isReady(), { timeout: 30000, interval: 500 });
      if (cancelled) return;
      if (!ready) { active = false; await messaging.send({ type: T.QUEUE_STOPPED }); return; }
    }
    active = true;
    session.start();
  }

  function changed() {
    if (!active || session?.isRunning()) return;
    active = false;
    messaging.send({ type: T.QUEUE_STOPPED }).catch(console.error);
  }

  async function returnToAssignments(button) {
    if (!session || cancelled || !button || button.disabled || returnedButton === button) return false;
    returnedButton = button;
    const wasActive = active;
    active = false;
    session.stop();
    button.click();
    if (wasActive) await messaging.send({ type: T.QUEUE_STOPPED });
    return true;
  }

  AutoMcGraw.assignmentQueue = { attach, changed, returnToAssignments };
})();
