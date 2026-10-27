(() => {
  AutoMcGraw.assistantBridge.register("notebooklm", {
    inputSelectors: ['textarea.query-box-input'],
    sendSelectors: ['.query-box .submit-button button'],
    userMessageSelector: ".from-user-message-card-content",
    getResponses: () => Array.from(document.querySelectorAll(".to-user-message-inner-content .message-text-content")),
    getMessageId: (node) => node.closest("chat-message")?.id || null,
    isBusy: () => Boolean(document.querySelector('textarea.query-box-input:disabled, button[aria-label="Stop generating"]')),
  });
})();
