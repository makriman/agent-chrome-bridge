const SOURCE = "codex-chrome-bridge";

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function smallHash(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
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

function sensitiveAttributes(element) {
  const haystack = [
    element.getAttribute("type"),
    element.getAttribute("name"),
    element.getAttribute("id"),
    element.getAttribute("autocomplete"),
    element.getAttribute("aria-label"),
    element.getAttribute("placeholder")
  ]
    .join(" ")
    .toLowerCase();
  return /(password|passwd|secret|token|api[-_ ]?key|otp|2fa|mfa|email|e-mail|phone|tel|card|cc-|credit|cvv|cvc|ssn)/i.test(haystack);
}

function elementText(element) {
  const tag = element.tagName.toLowerCase();
  const sensitive = tag === "input" && sensitiveAttributes(element);
  return normalizeText(
    element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      (sensitive ? "" : element.getAttribute("placeholder")) ||
      (sensitive ? "" : element.getAttribute("value")) ||
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
        "[contenteditable='true']",
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
  if (element.isContentEditable) return "textbox";
  return tag;
}

function cssPart(element) {
  const tag = element.tagName.toLowerCase();
  const id = element.id && !sensitiveAttributes(element) ? `#${CSS.escape(element.id)}` : "";
  if (id) return `${tag}${id}`;
  const classes = Array.from(element.classList || [])
    .filter((name) => !/token|secret|session|auth/i.test(name))
    .slice(0, 3)
    .map((name) => `.${CSS.escape(name)}`)
    .join("");
  const siblings = Array.from(element.parentElement ? element.parentElement.children : []);
  const sameTagIndex = siblings.filter((sibling) => sibling.tagName === element.tagName).indexOf(element) + 1;
  return `${tag}${classes}:nth-of-type(${Math.max(1, sameTagIndex)})`;
}

function cssPath(element) {
  const parts = [];
  let current = element;
  while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
    parts.unshift(cssPart(current));
    current = current.parentElement;
  }
  return parts.slice(-6).join(" > ");
}

function elementRef(element) {
  const role = elementRole(element);
  const text = elementText(element).slice(0, 80);
  const path = cssPath(element);
  return `ref_${smallHash(`${safeFrameUrl(location.href)}|${role}|${text}|${path}`)}`;
}

function elementEntry(element) {
  const rect = visibleRect(element);
  if (!rect) return null;
  const text = elementText(element);
  const role = elementRole(element);
  return {
    ref: elementRef(element),
    text,
    role,
    tag: element.tagName.toLowerCase(),
    rect,
    selectorHint: cssPath(element),
    frameUrl: safeFrameUrl(location.href),
    redactions: sensitiveAttributes(element) ? [{ field: "value", reason: "sensitive field omitted" }] : []
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

function findElementLocal(spec) {
  if (spec.ref) {
    return interactives().find((element) => elementRef(element) === spec.ref) || null;
  }
  if (spec.selector) {
    try {
      const selected = Array.from(document.querySelectorAll(spec.selector))
        .filter((element) => visibleRect(element))
        .sort((a, b) => {
          const aRect = a.getBoundingClientRect();
          const bRect = b.getBoundingClientRect();
          return aRect.top - bRect.top || aRect.left - bRect.left;
        });
      return selected[spec.index || 0] || null;
    } catch (_) {
      return null;
    }
  }
  const queryText = normalizeText(spec.text).toLowerCase();
  const exact = Boolean(spec.exact);
  const role = normalizeText(spec.role).toLowerCase();
  const candidates = interactives()
    .filter((element) => {
      const entry = elementEntry(element);
      if (!entry) return false;
      if (role && entry.role.toLowerCase() !== role) return false;
      if (!queryText) return true;
      const text = entry.text.toLowerCase();
      return exact ? text === queryText : text.includes(queryText);
    })
    .sort((a, b) => {
      const aRect = a.getBoundingClientRect();
      const bRect = b.getBoundingClientRect();
      return aRect.top - bRect.top || aRect.left - bRect.left;
    });
  return candidates[spec.index || 0] || null;
}

function findLocal(spec) {
  const element = findElementLocal(spec || {});
  return element ? elementEntry(element) : null;
}

function setElementValueLocal(spec, text) {
  const element = findElementLocal(spec || {});
  if (!element) return { ok: false, error: "No element found for ref." };
  const value = String(text || "");
  element.focus();
  if (element.isContentEditable) {
    element.textContent = value;
  } else if ("value" in element) {
    element.value = value;
  } else {
    return { ok: false, error: "Target is not fillable." };
  }
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, target: elementEntry(element) };
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
      if (data.setResult) {
        results.push({ ...data.setResult, target: translateFromFrame(data.setResult.target, frame) });
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

function viewport() {
  return {
    width: innerWidth,
    height: innerHeight,
    deviceScaleFactor: devicePixelRatio || 1
  };
}

async function inspectGlobal(limit = 120) {
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const local = inspectLocal(limit);
  const frameItems = await askFrames({ source: SOURCE, type: "inspect", requestId, limit, waitMs: 350 });
  const items = [...local, ...frameItems]
    .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
    .slice(0, limit);
  const redactions = items.flatMap((item) => item.redactions || []);
  return { items, viewport: viewport(), redactions };
}

async function findGlobal(spec) {
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const local = findLocal(spec);
  const frameItems = await askFrames({ source: SOURCE, type: "find", requestId, spec, waitMs: 350 });
  const items = [local, ...frameItems].filter(Boolean);
  return items.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)[0] || null;
}

async function setValueGlobal(spec, text) {
  const local = setElementValueLocal(spec, text);
  if (local.ok) return local;
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const frameItems = await askFrames({ source: SOURCE, type: "setValue", requestId, spec, text, waitMs: 350 });
  const success = frameItems.find((item) => item.ok);
  return success || local;
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
  if (data.type === "setValue") {
    event.source.postMessage(
      {
        source: SOURCE,
        type: "frame-result",
        requestId: data.requestId,
        setResult: setElementValueLocal(data.spec, data.text)
      },
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
    inspectGlobal(message.limit).then((result) => sendResponse({ ok: true, ...result }));
    return true;
  }
  if (message.type === "find") {
    findGlobal(message.spec).then((target) => sendResponse({ ok: true, target }));
    return true;
  }
  if (message.type === "setValue") {
    setValueGlobal(message.spec, message.text).then((result) => sendResponse(result));
    return true;
  }
  return false;
});
