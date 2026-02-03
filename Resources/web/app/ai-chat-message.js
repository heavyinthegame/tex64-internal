export const createMessageElement = (message) => {
    const wrapper = document.createElement("div");
    wrapper.className = "ai-message";
    if (message.role === "user") {
        wrapper.classList.add("is-user");
    }
    else if (message.role === "assistant") {
        wrapper.classList.add("is-assistant");
    }
    else if (message.role === "system") {
        wrapper.classList.add("is-system");
    }
    const content = document.createElement("div");
    content.className = "ai-message-content";
    if (message.role === "assistant") {
        const avatar = document.createElement("div");
        avatar.className = "ai-message-avatar";
        avatar.innerHTML =
            '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M8 15h8M9 9h.01M15 9h.01"></path></svg>';
        const body = document.createElement("div");
        body.className = "ai-message-body";
        const name = document.createElement("div");
        name.className = "ai-message-name";
        name.textContent = "Assistant";
        body.appendChild(name);
        body.appendChild(content);
        wrapper.appendChild(avatar);
        wrapper.appendChild(body);
    }
    else {
        wrapper.appendChild(content);
    }
    updateMessageElement(wrapper, message.text);
    return wrapper;
};
export const updateMessageElement = (wrapper, text) => {
    if (!wrapper) {
        return;
    }
    const content = wrapper.querySelector(".ai-message-content");
    if (!content) {
        return;
    }
    content.textContent = text;
};
