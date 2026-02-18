import type { ChatMessage } from "./ai-chat-state.js";

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const renderMarkdownHtml = (text: string): string => {
  const blocks: string[] = [];
  const parts = text.split(/(```[\s\S]*?```)/g);

  for (const part of parts) {
    if (part.startsWith("```")) {
      const match = part.match(/^```(\w*)\n?([\s\S]*?)```$/);
      if (match) {
        const lang = escapeHtml(match[1] || "text");
        const code = escapeHtml(match[2].trimEnd());
        blocks.push(
          `<div class="ai-code-block"><div class="ai-code-header"><span class="ai-code-lang">${lang}</span><button class="ai-code-copy" type="button" data-copy>copy</button></div><pre><code>${code}</code></pre></div>`
        );
      } else {
        blocks.push(`<pre><code>${escapeHtml(part)}</code></pre>`);
      }
    } else {
      let html = escapeHtml(part);
      html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
      html = html.replace(/`([^`]+)`/g, '<code class="ai-inline-code">$1</code>');

      html = html.replace(/((?:^|\n)[-*] .+(?:\n[-*] .+)*)/g, (match) => {
        const items = match.trim().split(/\n/).map((line) => `<li>${line.replace(/^[-*] /, "")}</li>`).join("");
        return `<ul class="ai-md-list">${items}</ul>`;
      });
      html = html.replace(/((?:^|\n)\d+\. .+(?:\n\d+\. .+)*)/g, (match) => {
        const items = match.trim().split(/\n/).map((line) => `<li>${line.replace(/^\d+\. /, "")}</li>`).join("");
        return `<ol class="ai-md-list">${items}</ol>`;
      });

      html = html.replace(/\n\n+/g, "</p><p>");
      html = html.replace(/\n/g, "<br>");
      html = html.replace(/<p><\/p>/g, "");
      if (html.trim()) blocks.push(`<p>${html}</p>`);
    }
  }
  return blocks.join("");
};

const attachCopyHandlers = (container: Element) => {
  container.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const code = btn.closest(".ai-code-block")?.querySelector("code")?.textContent ?? "";
      navigator.clipboard.writeText(code).then(() => {
        btn.textContent = "copied";
        setTimeout(() => { btn.textContent = "copy"; }, 1500);
      });
    });
  });
};

export const createMessageElement = (message: ChatMessage) => {
  const wrapper = document.createElement("div");
  wrapper.className = "ai-message";

  if (message.role === "user") {
    wrapper.classList.add("is-user");
    const content = document.createElement("div");
    content.className = "ai-message-content";
    content.textContent = message.text;
    wrapper.appendChild(content);
  } else if (message.role === "assistant") {
    wrapper.classList.add("is-assistant");
    const indicator = document.createElement("div");
    indicator.className = "ai-message-indicator";
    indicator.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2l2.09 6.26L20.18 10l-6.09 1.74L12 18l-2.09-6.26L3.82 10l6.09-1.74z"/></svg>';
    const body = document.createElement("div");
    body.className = "ai-message-body";
    const content = document.createElement("div");
    content.className = "ai-message-content";
    content.innerHTML = renderMarkdownHtml(message.text);
    attachCopyHandlers(content);
    body.appendChild(content);
    wrapper.appendChild(indicator);
    wrapper.appendChild(body);
  } else if (message.role === "system") {
    wrapper.classList.add("is-system");
    const content = document.createElement("div");
    content.className = "ai-message-content";
    content.textContent = message.text;
    wrapper.appendChild(content);
  }
  return wrapper;
};

export const updateMessageElement = (wrapper: HTMLElement | null, text: string) => {
  if (!wrapper) return;
  const content = wrapper.querySelector(".ai-message-content");
  if (!content) return;
  if (wrapper.classList.contains("is-assistant")) {
    content.innerHTML = renderMarkdownHtml(text);
    attachCopyHandlers(content);
  } else {
    content.textContent = text;
  }
};
