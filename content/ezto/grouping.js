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

  async function apply(values, run) {
    const activity = read();
    if (!activity) return false;
    const { root, labels, groups } = activity;
    const pairs = values.flatMap((value) => value.split(/\n/)).map((value) => {
      const parts = value.split(/\s*(?:->|→)\s*/);
      if (parts.length !== 2) return null;
      const group = groups.find((item) => text.isAnswerMatch(item.name, parts[0]));
      const label = labels.find((item) => text.isAnswerMatch(labelText(item), parts[1]));
      return group && label ? { group, label } : null;
    });
    if (pairs.length !== labels.length || pairs.some((pair) => !pair) ||
        new Set(pairs.map((pair) => pair.label)).size !== labels.length) return false;
    const placed = ({ group, label }) => Array.from(group.zone.querySelectorAll("[labelid]"))
      .some((item) => item.getAttribute("labelid") === label.getAttribute("labelid"));
    for (const pair of pairs) {
      if (placed(pair)) continue;
      const id = pair.label.getAttribute("labelid");
      const source = Array.from(root.querySelectorAll(".drop-zone [labelid]"))
        .find((item) => item.getAttribute("labelid") === id) || pair.label;
      source.focus();
      dom.pressKey(source, dom.KEYS.space);
      await run.delay(150);
      let found = false;
      for (let attempt = 0; attempt <= groups.length; attempt += 1) {
        dom.pressKey(root.activeElement, right);
        await run.delay(200);
        const announcement = root.querySelector(".cdk-live-announcer-element")?.textContent.trim() || "";
        if (announcement.startsWith(`${pair.group.name} ,`) || announcement.startsWith(`${pair.group.name},`)) {
          found = true;
          break;
        }
      }
      if (!found) {
        dom.pressKey(root.activeElement, { key: "Escape", code: "Escape", keyCode: 27 });
        return false;
      }
      dom.pressKey(root.activeElement, dom.KEYS.space);
      if (!await run.waitFor(() => placed(pair), { timeout: 2500 })) return false;
    }
    return pairs.every(placed);
  }

  AutoMcGraw.eztoGrouping = { read, options, apply };
})();
