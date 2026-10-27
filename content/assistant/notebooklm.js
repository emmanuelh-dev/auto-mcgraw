(() => {
  AutoMcGraw.assistantBridge.register("notebooklm", {
    inputSelectors: ['textarea.query-box-input[aria-label="Query box"]'],
    sendSelectors: ['.query-box button[aria-label="Submit"]'],
    userMessageSelector: ".from-user-message-card-content",
    getResponses: () => Array.from(document.querySelectorAll(".to-user-message-inner-content .message-text-content")),
    getMessageId: (node) => node.closest("chat-message")?.id || null,
    isBusy: () => Boolean(document.querySelector('button[aria-label="Stop generating"]')),
  });
})();
