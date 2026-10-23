(() => {
  const { messaging, MessageType: T, wait } = AutoMcGraw;
  if (document.getElementById("auto-mcgraw-queue")) return;
  const host = document.createElement("aside");
  host.id = "auto-mcgraw-queue";
  host.style.cssText = "position:fixed;bottom:16px;right:16px;z-index:10000";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    :host{font:14px system-ui;color:#172b35}section{background:white;border:1px solid #557783;border-radius:8px;padding:14px;width:320px;box-shadow:0 3px 15px #0003}
    h2{font-size:16px;margin:0 0 8px}p{margin:8px 0}button{padding:7px;margin:3px;cursor:pointer}label{display:block;padding:4px}#items{max-height:180px;overflow:auto}button:disabled{cursor:default}
  </style><section><h2>Auto-McGraw · Cola de actividades</h2>
    <p>Expande los grupos que quieras incluir y pulsa Actualizar lista.</p>
    <button id="scan">Actualizar lista</button><div id="items"></div>
    <button id="start">Iniciar seleccionadas</button><button id="stop" disabled>Detener</button>
    <button id="verify" hidden>Comprobar finalización</button>
    <p id="status" role="status"></p></section>`;
  document.documentElement.appendChild(host);
  const get = (id) => root.getElementById(id);
  let queue = null;
  let items = [];
  let busy = false;
  let reviewedIndex = -1;

  function status(message) { get("status").textContent = message; }

  function scan() {
    if (queue) return;
    items = Array.from(document.querySelectorAll(".assignment-card")).filter((card) => card.getClientRects().length).map((card) => {
      const heading = card.querySelector('[id^="assignmentName-"]');
      const type = card.querySelector(".assignment-card__first-row-type")?.getAttribute("title") || "";
      const launch = card.querySelector('[data-automation-id^="launch-btn-"]');
      return { id: heading?.id.replace("assignmentName-", ""), title: heading?.textContent.trim(), type, enabled: launch && !launch.disabled };
    }).filter((item) => item.id && item.enabled && /^(smartbook|homework|quiz)$/i.test(item.type));
    get("items").replaceChildren();
    items.forEach((item) => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = item.id;
      input.checked = true;
      label.append(input, document.createTextNode(` ${item.title} (${item.type})`));
      get("items").appendChild(label);
    });
    status(`${items.length} actividades disponibles en los grupos expandidos.`);
  }

  function render() {
    get("start").disabled = Boolean(queue);
    get("stop").disabled = !queue;
    get("scan").disabled = Boolean(queue);
    get("items").querySelectorAll("input").forEach((input) => { input.disabled = Boolean(queue); });
    get("verify").hidden = !queue || !["review", "launching"].includes(queue.phase);
    if (!queue) return;
    const title = queue.items[queue.index]?.title || "";
    status(`${queue.index + 1}/${queue.items.length} · ${title} · ${queue.phase === "running" ? "Resolviendo" : queue.phase === "review" ? "Revisa la actividad y comprueba la finalización" : queue.childId !== null ? "Actividad abierta. Si el solucionador no inicia, revisa el formato o la pantalla de inicio." : "Esperando apertura de la actividad. Si no abre, pulsa Begin en Connect."}`);
  }

  async function openPanel(item) {
    const close = document.querySelector('[data-automation-id="right-panel-close-button"]');
    if (close) {
      close.click();
      const closed = await wait.waitFor(() => !document.querySelector('[data-automation-id="right-panel"]'), { timeout: 5000 });
      if (!closed) throw new Error("Cierra el panel de Connect y vuelve a intentarlo.");
    }
    const button = document.querySelector(`[data-automation-id="launch-btn-${item.id}"]`);
    if (!button || button.disabled) throw new Error("La actividad no está visible o disponible. Expande su grupo.");
    button.click();
    const panel = await wait.waitFor(() => {
      const element = document.querySelector('[data-automation-id="right-panel"]');
      const title = element?.querySelector('[data-automation-id="right-side-panel-header"]')?.textContent.trim();
      return title === item.title && element.querySelector(".attempt-detail") ? element : null;
    }, { timeout: 10000 });
    if (!panel) throw new Error("No se pudieron leer los detalles de la actividad.");
    return panel;
  }

  function same(current) {
    return queue?.id === current.id && queue.index === current.index;
  }

  async function verify() {
    const current = queue;
    if (!current) return;
    const panel = await openPanel(current.items[current.index]);
    if (!same(current)) return;
    const response = await messaging.send({ type: T.QUEUE_VERIFY, status: panel.querySelector(".attempt-detail")?.textContent || "" });
    if (!response?.ok) {
      status("Connect no confirma que terminó. Revisa o envía la actividad y pulsa Comprobar finalización.");
      return;
    }
    accept(response.queue);
  }

  async function process() {
    if (busy || !queue) return;
    busy = true;
    const current = queue;
    try {
      if (current.phase === "ready") {
        const panel = await openPanel(current.items[current.index]);
        if (!same(current)) return;
        const attemptStatus = panel.querySelector(".attempt-detail")?.textContent.trim() || "";
        if (/^(?:completed|submitted)(?:\s*[,.:]\s*.*)?$/i.test(attemptStatus)) {
          const verified = await messaging.send({ type: T.QUEUE_VERIFY, status: attemptStatus });
          if (verified?.ok) accept(verified.queue);
          else status("Connect no confirmó la finalización. Revisa la actividad.");
          return;
        }
        const begin = panel.querySelector('[data-automation-id="rhp-launch-assignment-button"]');
        if (!begin || begin.disabled || !/^(begin|resume|continue)$/i.test(begin.textContent.trim())) throw new Error("Esta actividad necesita revisión manual antes de abrirse.");
        const response = await messaging.send({ type: T.QUEUE_LAUNCH });
        if (response?.ok && same(current) && queue.phase === "launching") begin.click();
      } else if (current.phase === "review" && reviewedIndex !== current.index) {
        reviewedIndex = current.index;
        await verify();
      }
    } catch (error) {
      status(error.message);
    } finally {
      busy = false;
      if ((queue?.phase === "review" && reviewedIndex !== queue.index) || (queue?.phase === "ready" && queue.index !== current.index)) void process();
    }
  }

  function accept(value) {
    queue = value;
    if (queue?.phase === "done") {
      queue = null;
      render();
      status("Cola completada. Connect confirmó todas las actividades.");
      return;
    }
    render();
    void process();
  }

  messaging.handle(T.QUEUE_STATE, ({ queue: value }) => { accept(value); });
  get("scan").onclick = scan;
  get("start").onclick = async () => {
    const selected = new Set(Array.from(get("items").querySelectorAll("input:checked"), (input) => input.value));
    const chosen = items.filter((item) => selected.has(item.id));
    if (!chosen.length || !confirm(`¿Iniciar ${chosen.length} actividades con el asistente configurado? Los formatos no compatibles requieren revisión. Las tareas y quizzes pueden requerir envío manual.`)) return;
    get("start").disabled = true;
    try {
      const response = await messaging.send({ type: T.QUEUE_START, items: chosen });
      if (!response?.ok) throw new Error(response?.error || "No se pudo iniciar la cola.");
      reviewedIndex = -1;
      accept(response.queue);
    } catch (error) { render(); status(error.message); }
  };
  get("stop").onclick = async () => {
    const response = await messaging.send({ type: T.QUEUE_STOP });
    if (!response?.ok) return;
    queue = null;
    render();
    status("Cola detenida.");
  };
  get("verify").onclick = async () => {
    if (busy) return;
    busy = true;
    try { await verify(); } catch (error) { status(error.message); }
    finally { busy = false; if (queue?.phase === "ready") void process(); }
  };
  scan();
  messaging.send({ type: T.QUEUE_STATE }).then((response) => {
    if (response?.queue) accept(response.queue);
  }).catch((error) => status(error.message));
})();
