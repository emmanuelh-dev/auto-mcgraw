(() => {
  const { settings, automation, toolbar, text, dom } = AutoMcGraw;

  const ANSWER_TYPES = [
    ["multiple_choice", ".answers-wrap.multiple-choice"],
    ["true_false", ".answers-wrap.boolean"],
    ["fill_in_the_blank", ".answers-wrap.input-response"],
  ];
  const MANUAL_ANSWER_HINT =
    "Please answer this question yourself and go to the next question. Automation will resume there.";

  let currentSettings = { ...settings.DEFAULTS };

  function detectType() {
    for (const [type, selector] of ANSWER_TYPES) {
      if (document.querySelector(selector)) return type;
    }
    return AutoMcGraw.eztoGrouping?.read() ? "matching" : "";
  }

  function isQuizPage() {
    return (
      Boolean(document.querySelector(".question")) && Boolean(detectType())
    );
  }

  function multipleChoiceLabels() {
    return Array.from(
      document.querySelectorAll(".answers--mc .answer__label--mc")
    ).map((label) => label.textContent.trim().replace(/^[a-z]\s+/, ""));
  }

  function readQuestionText(questionElement, type) {
    if (type !== "fill_in_the_blank") return text.readableText(questionElement);

    const clone = questionElement.cloneNode(true);
    clone.querySelectorAll('span[aria-hidden="true"]').forEach((span) => {
      if (span.textContent.includes("_")) span.textContent = "[BLANK]";
    });
    clone
      .querySelectorAll('span[style*="position: absolute"]')
      .forEach((span) => span.remove());
    return text.readableText(clone);
  }

  function parseQuestion() {
    const questionElement = document.querySelector(".question");
    const type = detectType();
    if (!questionElement || !type) return null;

    let options = type === "matching" ? AutoMcGraw.eztoGrouping.options() : [];
    if (type === "multiple_choice") {
      options = multipleChoiceLabels();
    } else if (type === "true_false") {
      options = ["True", "False"];
    }

    return {
      type,
      question: readQuestionText(questionElement, type),
      options,
      previousCorrection: null,
    };
  }

  function progressText() {
    return (
      document
        .querySelector(".footer__progress__heading")
        ?.textContent.trim() || ""
    );
  }

  function isLastQuestion() {
    const match = progressText().match(/(\d+)\s+of\s+(\d+)/);
    return Boolean(match) && Number(match[2]) > 0 && Number(match[1]) === Number(match[2]);
  }

  function signature() {
    const question =
      document.querySelector(".question")?.textContent.trim() || "";
    return `${progressText()}::${question}`;
  }

  function selectMultipleChoice(values) {
    const radios = document.querySelectorAll(
      '.answers--mc input[type="radio"]'
    );
    const [index] = text.resolveChoiceIndices(
      multipleChoiceLabels(),
      values,
      false
    );
    if (index === undefined || !radios[index]) return false;

    radios[index].click();
    return true;
  }

  function selectTrueFalse(values) {
    const buttons = Array.from(document.querySelectorAll(".answer--boolean"));
    const labels = buttons.map(
      (button) =>
        button
          .querySelector(".answer__button--boolean")
          ?.textContent.trim()
          .split(",")[0]
          .trim() || ""
    );
    const [index] = text.resolveChoiceIndices(labels, values, false);
    if (index === undefined) return false;

    buttons[index].click();
    return true;
  }

  function fillBlank(values) {
    const input = document.querySelector(".answer--input__input");
    if (!input || !values.length) return false;

    dom.setInputValue(input, values[0]);
    return true;
  }

  function applyAnswer(type, values, run) {
    if (type === "matching") return AutoMcGraw.eztoGrouping.apply(values, run);
    if (type === "multiple_choice") return selectMultipleChoice(values);
    if (type === "true_false") return selectTrueFalse(values);
    if (type === "fill_in_the_blank") return fillBlank(values);
    return false;
  }

  function findNextButton() {
    const button = document.querySelector(".footer__link--next:not([hidden])");
    if (
      !button ||
      button.disabled ||
      button.classList.contains("is-disabled")
    ) {
      return null;
    }
    return button;
  }

  function visibleButton(selector) {
    return Array.from(document.querySelectorAll(selector)).find(
      (button) => dom.isEnabled(button) && button.getClientRects().length > 0 &&
        !button.closest('[aria-hidden="true"]')
    );
  }

  async function submitQuiz(run) {
    const submit = Array.from(document.querySelectorAll("button, a")).find(
      (button) => button.textContent.trim() === "Submit" &&
        dom.isEnabled(button) && button.getClientRects().length > 0 &&
        !button.closest('[role="dialog"], ic-modal, [aria-hidden="true"]')
    );
    if (!submit) {
      run.stop("Submit button unavailable. Review the quiz.");
      return;
    }
    submit.click();
    const confirmButton = await run.waitFor(
      () => visibleButton(".modal--submit-activity__button--confirm"),
      { timeout: 15000 }
    );
    if (!confirmButton) {
      run.stop("Submission confirmation unavailable. Review the quiz.");
      return;
    }
    confirmButton.click();
    const exitButton = await run.waitFor(
      () => visibleButton('.dialog__wrapper[aria-describedby="post-submission-content"] .dialog__exit'),
      { timeout: 30000 }
    );
    if (!exitButton) {
      run.stop("Submission not confirmed. Review the quiz.");
      return;
    }
    await AutoMcGraw.assignmentQueue.returnToAssignments(exitButton);
  }

  async function step(run) {
    const question = parseQuestion();
    if (!question) {
      run.stop("No question found or question type not supported.");
      return;
    }

    const questionSignature = signature();
    const reply = await run.ask(question);
    if (signature() !== questionSignature) return;

    const values = text.flattenAnswerValues(reply?.answer);
    const isDone = () => signature() !== questionSignature;

    if (!await applyAnswer(question.type, values, run)) {
      await run.pauseForManualAnswer(
        "Couldn't match the AI's answer to this question's choices.",
        values,
        MANUAL_ANSWER_HINT,
        isDone
      );
      return;
    }

    if (currentSettings.pauseBeforeSubmit) {
      await run.waitForUser(isDone);
      return;
    }

    await run.delay(2000);
    const nextButton = findNextButton();
    if (!nextButton) {
      if (isLastQuestion()) await submitQuiz(run);
      else run.stop("Next button unavailable before the final question. Review the quiz.");
      return;
    }

    nextButton.click();
    await run.delay(1500);
  }

  const session = automation.create({ step, onStateChange: render });
  const bar = toolbar.create({ variant: "ezto", onToggle: toggle });

  function render() {
    AutoMcGraw.assignmentQueue.changed();
    bar.render({
      running: session.isRunning(),
      assistantId: currentSettings.aiModel,
      doubleCredit: false,
    });
  }

  function toggle() {
    if (session.isRunning()) {
      session.stop();
      return;
    }

    if (
      confirm(
        "Start quiz automation? The automation will stop automatically when the quiz ends.\n\nClick OK to begin, or Cancel to stop."
      )
    ) {
      session.start();
    }
  }

  async function init() {
    render();
    toolbar.keepMounted(bar.element, (element) => {
      const helpLink = document.querySelector(".header__help");
      if (helpLink && isQuizPage()) helpLink.before(element);
    });

    settings.subscribe((values) => {
      currentSettings = values;
      render();
    });
    currentSettings = await settings.load();
    render();
    await AutoMcGraw.assignmentQueue.attach(session, isQuizPage);
  }

  init().catch((error) => console.error("[Auto-McGraw]", error));
})();
