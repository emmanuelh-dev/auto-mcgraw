(() => {
  const { text, dom, matching, questions, wait } = AutoMcGraw;

  const UNMATCHED_HEADING =
    "Couldn't match the AI's answer to this question's choices.";

  function choiceInputs(container) {
    return Array.from(
      container.querySelectorAll('input[type="radio"], input[type="checkbox"]')
    )
      .map((input) => {
        const label = input.closest("label")?.querySelector(".choiceText");
        return { input, text: label ? text.readableText(label) : "" };
      })
      .filter((choice) => choice.text);
  }

  function fillBlanks(container, values) {
    const inputs = Array.from(container.querySelectorAll("input.fitb-input"));

    let entries = values;
    if (entries.length === 1 && inputs.length > 1) {
      const parts = entries[0].split(/\s*[;,]\s*/).filter(Boolean);
      if (parts.length === inputs.length) entries = parts;
    }

    let filled = 0;
    inputs.forEach((input, index) => {
      if (entries[index] === undefined) return;
      dom.setInputValue(input, entries[index]);
      filled += 1;
    });
    return filled > 0;
  }

  function selectChoices(container, values) {
    const choices = choiceInputs(container);
    const allowMultiple = choices.some(
      (choice) => choice.input.type === "checkbox"
    );
    const indices = text.resolveChoiceIndices(
      choices.map((choice) => choice.text),
      values,
      allowMultiple
    );

    indices.forEach((index) => {
      const { input } = choices[index];
      if (!input.checked) input.click();
    });
    return indices.length > 0;
  }

  function selectText(container, values) {
    const choices = questions.selectTextChoices(container);
    const indices = text.resolveChoiceIndices(
      choices.map((choice) => choice.textContent.trim()),
      values,
      true
    );

    indices.forEach((index) => choices[index].click());
    return indices.length > 0;
  }

  function normalizeAnswers(raw, type, container) {
    if (type === "matching") return matching.describe(container, raw);

    const values = text.flattenAnswerValues(raw);
    if (!values.length) return [];

    const isMultiAnswer = type === "multiple_select" || type === "select_text";
    if (isMultiAnswer && values.length === 1) {
      const named = text.extractChoicesFromCombined(
        values[0],
        questions.readChoices(container, type)
      );
      if (named.length) return text.dedupeAnswers(named);

      const split = text.splitCompoundAnswer(values[0]);
      if (split.length > 1) return text.dedupeAnswers(split);
    }

    return text.dedupeAnswers(values);
  }

  async function orderChoices(container, raw) {
    const selector = ".sortable-component .responses-container .choice-item";
    const items = () => Array.from(container.querySelectorAll(selector));
    const label = (item) => text.normalizeChoiceText(
      text.readableText(item.querySelector(".content"))
    );
    const current = items().map(label);
    const desired = text.flattenAnswerValues(raw).map(text.normalizeChoiceText);
    if (!current.length || desired.length !== current.length ||
        new Set(desired).size !== current.length ||
        desired.some((value) => !current.includes(value))) return false;

    function press(item, key, code, keyCode) {
      const KeyboardEvent = item.ownerDocument.defaultView.KeyboardEvent;
      for (const type of ["keydown", "keyup"]) {
        item.dispatchEvent(new KeyboardEvent(type, {
          key, code, keyCode, which: keyCode, bubbles: true, cancelable: true,
        }));
      }
    }

    for (let target = 0; target < desired.length; target += 1) {
      const index = items().findIndex((item) => label(item) === desired[target]);
      if (index === target) continue;
      const item = items()[index];
      const view = item.ownerDocument.defaultView;
      if (item.draggable && view.DataTransfer && view.DragEvent) {
        const destination = items()[target];
        const rect = destination.getBoundingClientRect();
        const dataTransfer = new view.DataTransfer();
        const dispatch = (element, type) => element.dispatchEvent(
          new view.DragEvent(type, {
            bubbles: true, cancelable: true, dataTransfer,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + Math.min(5, rect.height / 4),
          })
        );
        try {
          dispatch(item, "dragstart");
          await wait.delay(80);
          dispatch(destination, "dragenter");
          dispatch(destination, "dragover");
          await wait.delay(80);
          dispatch(destination, "drop");
        } finally {
          dispatch(item, "dragend");
        }
        const moved = await wait.waitFor(
          () => label(items()[target]) === desired[target],
          { timeout: 1500, interval: 50 }
        );
        if (!moved) return false;
        continue;
      }
      item.focus();
      press(item, " ", "Space", 32);
      await wait.delay(80);
      for (let position = index; position > target; position -= 1) {
        press(item, "ArrowUp", "ArrowUp", 38);
        await wait.delay(80);
      }
      press(item, " ", "Space", 32);
      const moved = await wait.waitFor(
        () => label(items()[target]) === desired[target],
        { timeout: 1500, interval: 50 }
      );
      if (!moved) return false;
    }
    return items().every((item, index) => label(item) === desired[index]);
  }

  async function apply(container, raw) {
    const type = questions.detectType(container);
    const lines = normalizeAnswers(raw, type, container);

    if (type === "matching") {
      return {
        applied: await matching.apply(container, raw),
        lines,
        heading:
          "Matching question: the matches couldn't be placed automatically.",
      };
    }

    if (type === "ordering") {
      return {
        applied: await orderChoices(container, raw),
        lines,
        heading: "Ordering question: the choices couldn't be reordered automatically.",
      };
    }

    if (!type) {
      return {
        applied: false,
        lines,
        heading: "This question type isn't supported yet.",
      };
    }

    let applied;
    if (type === "fill_in_the_blank") {
      applied = fillBlanks(container, lines);
    } else if (type === "select_text") {
      applied = selectText(container, lines);
    } else {
      applied = selectChoices(container, lines);
    }

    return { applied, lines, heading: UNMATCHED_HEADING };
  }

  AutoMcGraw.answers = { apply };
})();
