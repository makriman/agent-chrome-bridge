const SOURCE = "codex-chrome-bridge";

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function safeFrameUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch (_) {
    return "";
  }
}

function visibleRect(element) {
  if (!element || typeof element.getBoundingClientRect !== "function") return null;
  const style = getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.pointerEvents === "none" ||
    Number(style.opacity) === 0
  ) {
    return null;
  }
  const rect = element.getBoundingClientRect();
  if (rect.width < 3 || rect.height < 3) return null;
  if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return null;
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height
  };
}

function elementText(element) {
  const tag = element.tagName.toLowerCase();
  const type = (element.getAttribute("type") || "").toLowerCase();
  const isSensitiveInput = tag === "input" && ["password", "email", "tel"].includes(type);
  return normalizeText(
    element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      (isSensitiveInput ? "" : element.getAttribute("placeholder")) ||
      (isSensitiveInput ? "" : element.getAttribute("value")) ||
      element.innerText ||
      element.textContent
  );
}

function interactives() {
  return Array.from(
    document.querySelectorAll(
      [
        "button",
        "a[href]",
        "input",
        "textarea",
        "select",
        "label",
        "[role='button']",
        "[role='link']",
        "[role='checkbox']",
        "[tabindex]:not([tabindex='-1'])"
      ].join(",")
    )
  );
}

function elementRole(element) {
  const explicit = element.getAttribute("role");
  if (explicit) return explicit;
  const tag = element.tagName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "input") return element.getAttribute("type") || "input";
  if (tag === "textarea") return "textarea";
  if (tag === "select") return "select";
  return tag;
}

function elementEntry(element) {
  const rect = visibleRect(element);
  if (!rect) return null;
  const text = elementText(element);
  return {
    text,
    role: elementRole(element),
    tag: element.tagName.toLowerCase(),
    rect,
    frameUrl: safeFrameUrl(location.href)
  };
}

function inspectLocal(limit = 80) {
  return interactives()
    .map(elementEntry)
    .filter(Boolean)
    .filter((entry) => entry.text || ["checkbox", "radio"].includes(entry.role))
    .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
    .slice(0, limit);
}

function findLocal(spec) {
  if (spec.selector) {
    try {
      const selected = Array.from(document.querySelectorAll(spec.selector))
        .map(elementEntry)
        .filter(Boolean)
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
      return selected[spec.index || 0] || null;
    } catch (_) {
      return null;
    }
  }
  const queryText = normalizeText(spec.text).toLowerCase();
  const exact = Boolean(spec.exact);
  const role = normalizeText(spec.role).toLowerCase();
  const candidates = inspectLocal(200).filter((entry) => {
    if (role && entry.role.toLowerCase() !== role) return false;
    if (!queryText) return true;
    const text = entry.text.toLowerCase();
    return exact ? text === queryText : text.includes(queryText);
  });
  return candidates[spec.index || 0] || null;
}

function findFrameForSource(sourceWindow) {
  return Array.from(document.querySelectorAll("iframe")).find((frame) => frame.contentWindow === sourceWindow) || null;
}

function translateFromFrame(target, frameElement) {
  if (!target || !frameElement) return target;
  const frameRect = frameElement.getBoundingClientRect();
  return {
    ...target,
    rect: {
      left: frameRect.left + target.rect.left,
      top: frameRect.top + target.rect.top,
      right: frameRect.left + target.rect.right,
      bottom: frameRect.top + target.rect.bottom,
      width: target.rect.width,
      height: target.rect.height
    }
  };
}

function askFrames(request) {
  const results = [];
  const requestId = request.requestId;

  return new Promise((resolve) => {
    function onMessage(event) {
      const data = event.data;
      if (!data || data.source !== SOURCE || data.requestId !== requestId || data.type !== "frame-result") {
        return;
      }
      const frame = findFrameForSource(event.source);
      const items = Array.isArray(data.items) ? data.items : data.item ? [data.item] : [];
      for (const item of items) {
        results.push(translateFromFrame(item, frame));
      }
    }

    window.addEventListener("message", onMessage);
    for (const frame of Array.from(document.querySelectorAll("iframe"))) {
      try {
        frame.contentWindow.postMessage(request, "*");
      } catch (_) {
        // Ignore frames Chrome will not message.
      }
    }

    setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve(results.filter(Boolean));
    }, request.waitMs || 350);
  });
}

async function inspectGlobal(limit = 120) {
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const local = inspectLocal(limit);
  const frameItems = await askFrames({ source: SOURCE, type: "inspect", requestId, limit, waitMs: 350 });
  return [...local, ...frameItems]
    .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
    .slice(0, limit);
}

async function findGlobal(spec) {
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const local = findLocal(spec);
  const frameItems = await askFrames({ source: SOURCE, type: "find", requestId, spec, waitMs: 350 });
  const items = [local, ...frameItems].filter(Boolean);
  return items.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)[0] || null;
}

window.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.source !== SOURCE) return;
  if (data.type === "inspect") {
    event.source.postMessage(
      { source: SOURCE, type: "frame-result", requestId: data.requestId, items: inspectLocal(data.limit) },
      "*"
    );
  }
  if (data.type === "find") {
    event.source.postMessage(
      { source: SOURCE, type: "frame-result", requestId: data.requestId, item: findLocal(data.spec) },
      "*"
    );
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.source !== SOURCE) return false;
  if (message.type === "ping") {
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === "inspect") {
    inspectGlobal(message.limit).then((items) => sendResponse({ ok: true, items }));
    return true;
  }
  if (message.type === "find") {
    findGlobal(message.spec).then((target) => sendResponse({ ok: true, target }));
    return true;
  }
  return false;
});
