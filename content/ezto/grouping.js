(() => {
  const { text, dom } = AutoMcGraw;
  const right = { key: "ArrowRight", code: "ArrowRight", keyCode: 39 };

  function read() {
    for (const frame of document.querySelectorAll("iframe")) {
      let root;
      try { root = frame.contentDocument; } catch { continue; }
      if (!root?.querySelector("#label-list")) continue;
      const labels = Array.from(root.querySelectorAll("#label-list [labelid]"));
      const groups = Array.from(root.querySelectorAll(".groups")).map((element) => ({
        name: element.querySelector("h3")?.textContent.replace(/\s*\(\d+\/\d+\)\s*$/, "").trim(),
        zone: element.querySelector(".drop-zone[dropzoneid]"),
      })).filter((group) => group.name && group.zone);
      if (labels.length && groups.length) return { root, labels, groups };
    }
    return null;
  }

  function labelText(label) {
    return (label.querySelector(".label-text") || label).textContent.replace(/\s+/g, " ").trim();
  }

  function options() {
    const activity = read();
    return activity && {
      prompts: activity.groups.map((group) => group.name),
      choices: activity.labels.map(labelText),
      multiple: true,
    };
  }

  function answerValues(raw) {
    if (Array.isArray(raw)) return raw.flatMap(answerValues);
    if (raw && typeof raw === "object") {
      const group = raw.prompt ?? raw.left ?? raw.source ?? raw.from ?? raw.key;
      const choice = raw.choice ?? raw.match ?? raw.right ?? raw.target ?? raw.to ?? raw.answer ?? raw.value;
      const entries = group !== undefined && choice !== undefined ? [[group, choice]] : Object.entries(raw);
      return entries.flatMap(([name, value]) => (Array.isArray(value) ? value : [value])
        .map((label) => `${name} -> ${label}`));
    }
    return text.flattenAnswerValues(raw);
  }

  async function apply(values, run) {
    const activity = read();
    if (!activity) return false;
    const { root, labels, groups } = activity;
    const pairs = answerValues(values).flatMap((value) => value.split(/\n|;/)).map((value) => value.trim()).filter(Boolean).map((value) => {
      const parts = value.split(/\s*(?:->|→)\s*/);
      if (parts.length === 4 && parts[0] === parts[2] && parts[1] === parts[3]) parts.splice(2);
      if (parts.length !== 2) return null;
      const group = groups.find((item) => text.isAnswerMatch(item.name, parts[0]));
      const label = labels.find((item) => text.isAnswerMatch(labelText(item), parts[1]));
      return group && label ? { group, label } : null;
    });
    if (pairs.length !== labels.length || pairs.some((pair) => !pair) ||
        new Set(pairs.map((pair) => pair.label)).size !== labels.length) return false;
    const placed = ({ group, label }) => Array.from((read()?.groups.find((item) => item.name === group.name)?.zone?.querySelectorAll("[labelid]")) || [])
      .some((item) => item.getAttribute("labelid") === label.getAttribute("labelid"));
    for (const pair of pairs) {
      if (placed(pair)) continue;
      const id = pair.label.getAttribute("labelid");
      const source = Array.from(root.querySelectorAll(".drop-zone [labelid]"))
        .find((item) => item.getAttribute("labelid") === id) || Array.from(root.querySelectorAll("#label-list [labelid]"))
          .find((item) => item.getAttribute("labelid") === id);
      if (!source) return false;
      source.focus();
      dom.pressKey(source, dom.KEYS.space);
      const lifted = () => Array.from(root.querySelectorAll(".label-lifted[labelid]"))
        .find((item) => item.getAttribute("labelid") === id);
      const moving = await run.waitFor(lifted, { timeout: 2500 });
      if (!moving) return false;
      moving.focus();
      let found = false;
      for (let attempt = 0; attempt <= groups.length; attempt += 1) {
        const previous = root.querySelector(".cdk-live-announcer-element")?.textContent.trim() || "";
        dom.pressKey(lifted() || moving, right);
        const announcement = await run.waitFor(() => {
          const current = root.querySelector(".cdk-live-announcer-element")?.textContent.trim() || "";
          return current && current !== previous && current;
        }, { timeout: 2500 });
        if (!announcement) break;
        if (announcement.startsWith(`${pair.group.name} ,`) || announcement.startsWith(`${pair.group.name},`)) {
          found = true;
          break;
        }
      }
      if (!found) {
        dom.pressKey(lifted() || moving, { key: "Escape", code: "Escape", keyCode: 27 });
        return false;
      }
      dom.pressKey(lifted() || moving, dom.KEYS.space);
      if (!await run.waitFor(() => placed(pair) && !lifted(), { timeout: 2500 })) return false;
    }
    return pairs.every(placed);
  }

  AutoMcGraw.eztoGrouping = { read, options, answerValues, apply };
})();
