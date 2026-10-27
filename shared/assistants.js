(() => {
  const ASSISTANTS = Object.freeze([
    Object.freeze({
      id: "chatgpt",
      name: "ChatGPT",
      match: "https://chatgpt.com/*",
    }),
    Object.freeze({
      id: "gemini",
      name: "Gemini",
      match: "https://gemini.google.com/*",
    }),
    Object.freeze({
      id: "deepseek",
      name: "DeepSeek",
      match: "https://chat.deepseek.com/*",
    }),
    Object.freeze({
      id: "notebooklm",
      name: "NotebookLM",
      match: "https://notebook.google.com/*",
      matches: Object.freeze(["https://notebook.google.com/*", "https://notebooklm.google.com/*"]),
    }),
  ]);

  const DEFAULT_ID = "chatgpt";

  function get(id) {
    return (
      ASSISTANTS.find((assistant) => assistant.id === id) ||
      ASSISTANTS.find((assistant) => assistant.id === DEFAULT_ID)
    );
  }

  function normalizeNotebookUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.port ||
          !["notebook.google.com", "notebooklm.google.com"].includes(url.hostname) ||
          !/^\/notebook\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/?$/i.test(url.pathname)) return null;
      return `https://notebook.google.com${url.pathname.replace(/\/$/, "")}`;
    } catch {
      return null;
    }
  }

  function matchesNotebookUrl(candidate, configured) {
    const expected = normalizeNotebookUrl(configured);
    return Boolean(expected && normalizeNotebookUrl(candidate) === expected);
  }

  AutoMcGraw.assistants = { DEFAULT_ID, list: ASSISTANTS, get, normalizeNotebookUrl, matchesNotebookUrl };
})();
