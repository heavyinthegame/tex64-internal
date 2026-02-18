const createMiscHandlers = (deps) => {
  const {
    envService,
    ensureUserSettings,
    workspace,
    sendToRenderer,
    blocksStore,
    apiUsageService,
  } = deps;
  const { requestGemini } = require("../services/agent-llm.cjs");

  const extractInlineText = (raw, prefix) => {
    if (typeof raw !== "string") {
      return null;
    }
    let text = raw.trim();
    if (!text) {
      return null;
    }
    if (text.startsWith("```")) {
      const fence = text.match(/^```[a-zA-Z]*\n([\s\S]*?)```/);
      if (fence && fence[1]) {
        text = fence[1].trim();
      }
    }
    text = text.replace(/<CURSOR>/g, "");
    const newlineIndex = text.indexOf("\n");
    if (newlineIndex >= 0) {
      text = text.slice(0, newlineIndex).trimEnd();
    }
    if (typeof prefix === "string" && text.startsWith(prefix)) {
      text = text.slice(prefix.length);
    }
    return text.trimEnd() || null;
  };

  const handleEnvCheck = async (command) => {
    const result = await envService.checkCommand(command);
    sendToRenderer("env:checkResult", { command, available: result });
  };

  const handleEnvInstall = async (target) => {
    sendToRenderer("env:installStart", { target });
    const result = await envService.installEnvironment(target);
    sendToRenderer("env:installResult", { target, ...result });
    // Re-check relevant commands after install attempt
    if (target === "basictex") {
      const lualatex = await envService.checkCommand("lualatex");
      const latexmk = await envService.checkCommand("latexmk");
      sendToRenderer("env:checkResult", { command: "lualatex", available: lualatex });
      sendToRenderer("env:checkResult", { command: "latexmk", available: latexmk });
    } else if (target === "latexmk") {
      const available = await envService.checkCommand("latexmk");
      sendToRenderer("env:checkResult", { command: "latexmk", available });
    }
  };

  const handleBlocksSave = async (entry) => {
    const rootPath = workspace.getRootPath();
    if (!rootPath) {
      return;
    }
    let blocks = [];
    try {
      blocks = await blocksStore.load(rootPath);
    } catch {
      blocks = [];
    }
    if (entry && typeof entry === "object") {
      blocks.push(entry);
    }
    await blocksStore.save(rootPath, blocks);
  };

  const handleApiUsageGet = async () => {
    if (!apiUsageService) {
      return;
    }
    const snapshot = await apiUsageService.getSnapshot();
    sendToRenderer("api:usage", { snapshot });
  };

  const handleApiUsageReset = async () => {
    if (!apiUsageService) {
      return;
    }
    const snapshot = await apiUsageService.reset();
    sendToRenderer("api:usage", { snapshot });
  };

  const handleApiGhostCompletion = async (payload) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const requestId =
      typeof payload.requestId === "string" ? payload.requestId : null;
    if (!requestId) {
      return;
    }
    const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
    const prefix = typeof payload.prefix === "string" ? payload.prefix : "";
    const timeoutMs =
      typeof payload.timeoutMs === "number" && Number.isFinite(payload.timeoutMs)
        ? payload.timeoutMs
        : 3500;
    const maxOutputTokens =
      typeof payload.maxOutputTokens === "number" &&
      Number.isFinite(payload.maxOutputTokens)
        ? payload.maxOutputTokens
        : 40;
    const temperature =
      typeof payload.temperature === "number" && Number.isFinite(payload.temperature)
        ? payload.temperature
        : 0.2;
    const topP =
      typeof payload.topP === "number" && Number.isFinite(payload.topP) ? payload.topP : 0.9;
    const topK =
      typeof payload.topK === "number" && Number.isFinite(payload.topK) ? payload.topK : 40;

    if (!prompt.trim()) {
      sendToRenderer("api:completionResult", {
        requestId,
        ok: false,
        error: "empty prompt",
      });
      return;
    }

    const proxyUrl =
      typeof process.env.TEX64_AI_PROXY_URL === "string"
        ? process.env.TEX64_AI_PROXY_URL.trim()
        : "";
    const resolvedProxy =
      proxyUrl || "https://tex64.vercel.app/api/ai-chat";

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Math.max(800, timeoutMs));
    try {
      const response = await requestGemini({
        proxyUrl: resolvedProxy,
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
        systemInstruction: {
          parts: [
            {
              text: [
                "You are a high-precision LaTeX inline copilot.",
                "Return ONLY the continuation text to insert at <CURSOR>.",
                "Do not repeat the prefix already typed by the user.",
                "Prefer useful, immediately actionable continuation over generic phrases.",
                "Keep LaTeX syntax coherent and compile-safe.",
                "Stay concise (typically one line). If confidence is low, return empty.",
              ].join(" "),
            },
          ],
        },
        generationConfig: {
          maxOutputTokens,
          temperature,
          topP,
          topK,
          stopSequences: ["\n"],
        },
        signal: controller.signal,
      });
      const parts = response?.candidates?.[0]?.content?.parts ?? [];
      const rawText = parts
        .map((part) => part?.text)
        .filter((text) => typeof text === "string")
        .join("");
      const text = extractInlineText(rawText, prefix);

      let usageSnapshot = null;
      if (apiUsageService && response?.usageMetadata) {
        const usage = response.usageMetadata;
        const promptTokens =
          usage.promptTokenCount ??
          usage.promptTokens ??
          usage.inputTokenCount ??
          usage.input_tokens;
        const outputTokens =
          usage.candidatesTokenCount ??
          usage.outputTokenCount ??
          usage.outputTokens ??
          usage.output_tokens;
        const totalTokens =
          usage.totalTokenCount ??
          usage.totalTokens ??
          (Number.isFinite(promptTokens) && Number.isFinite(outputTokens)
            ? promptTokens + outputTokens
            : undefined);
        usageSnapshot = await apiUsageService.recordUsage({
          model: response?.modelVersion ?? response?.model ?? "gemini",
          promptTokens,
          outputTokens,
          totalTokens,
          source: "inline",
        });
        if (usageSnapshot) {
          sendToRenderer("api:usage", { snapshot: usageSnapshot });
        }
      }

      sendToRenderer("api:completionResult", {
        requestId,
        ok: true,
        text,
        usageSnapshot: usageSnapshot ?? undefined,
      });
    } catch (error) {
      sendToRenderer("api:completionResult", {
        requestId,
        ok: false,
        error: error?.message ?? "api error",
      });
    } finally {
      clearTimeout(timeoutId);
    }
  };

  return {
    handleEnvCheck,
    handleEnvInstall,
    handleBlocksSave,
    handleApiUsageGet,
    handleApiUsageReset,
    handleApiGhostCompletion,
  };
};

module.exports = { createMiscHandlers };
