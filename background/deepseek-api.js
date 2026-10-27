(() => {
  async function ask(prompt, model, provider = "deepseek") {
    const names = { deepseek: "DeepSeek", chatgpt: "OpenAI", gemini: "Gemini" };
    if (!names[provider]) throw new Error("Unsupported API provider.");
    const name = names[provider];
    const keyName = `${provider}ApiKey`;
    const { [keyName]: deepseekApiKey } = await chrome.storage.local.get(keyName);
    if (!deepseekApiKey) throw new Error(`Save a ${name} API key first.`);
    if (provider === "deepseek" && !["deepseek-flash", "deepseek-v4-pro"].includes(model)) {
      throw new Error("Select a supported DeepSeek API model in Settings.");
    }

    const gemini = provider === "gemini";
    const instruction = 'Return only a JSON object with "answer" and "explanation" keys. Example: {"answer":"choice text","explanation":"One sentence."}';
    const endpoint = gemini
      ? "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
      : provider === "chatgpt" ? "https://api.openai.com/v1/chat/completions" : "https://api.deepseek.com/chat/completions";
    const body = gemini ? {
      systemInstruction: { parts: [{ text: instruction }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 8192 },
    } : {
      model: provider === "chatgpt" ? "gpt-4.1-mini" : model,
      messages: [{ role: "system", content: instruction }, { role: "user", content: prompt }],
      response_format: { type: "json_object" },
      ...(provider === "deepseek" ? { thinking: { type: "enabled" }, reasoning_effort: "high" } : {}),
      max_tokens: 4096,
    };
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          ...(gemini ? { "x-goog-api-key": deepseekApiKey } : { Authorization: `Bearer ${deepseekApiKey}` }),
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(90000),
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error(`${name} API could not be reached or timed out. Try again.`);
    }
    if (!response.ok) {
      const errors = {
        401: `${name} rejected the API key. Replace it.`,
        402: `Your ${name} API balance is insufficient.`,
        429: `${name} API rate limit reached. Try again later.`,
      };
      throw new Error(errors[response.status] || `${name} API returned HTTP ${response.status}. Try again later.`);
    }

    try {
      const result = await response.json();
      const choice = gemini ? result.candidates?.[0] : result.choices?.[0];
      if ((gemini ? choice?.finishReason : choice?.finish_reason) !== (gemini ? "STOP" : "stop")) throw new Error();
      const content = gemini ? choice.content.parts.filter(part => !part.thought).map(part => part.text || "").join("") : choice.message.content;
      const parsed = JSON.parse(content);
      const answer = parsed?.answer;
      if (answer == null || (typeof answer === "string" && !answer.trim()) ||
          (Array.isArray(answer) && !answer.length)) throw new Error();
      return parsed;
    } catch {
      throw new Error(`${name} API returned an incomplete or invalid answer. Try again.`);
    }
  }

  AutoMcGraw.deepseekApi = { ask };
})();
