(() => {
  if (globalThis.__agentChromeBridgeContent) return;
  globalThis.__agentChromeBridgeContent = true;

  const SOURCE = "codex-chrome-bridge";

  // Same rules as extension/extension-sender.mjs. Inlined because this file is
  // injected as a classic script and cannot import modules.
  function isTrustedExtensionSender(sender, extensionId) {
    if (!sender || !extensionId || sender.id !== extensionId) return false;
    const extensionOrigin = `chrome-extension://${extensionId}`;
    if (typeof sender.origin === "string" && sender.origin && sender.origin !== extensionOrigin) return false;
    if (typeof sender.url === "string" && sender.url && !sender.url.startsWith(`${extensionOrigin}/`)) return false;
    return true;
  }

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

  function childFrameEntries() {
    return Array.from(document.querySelectorAll("iframe")).map((frame) => {
      const rect = frame.getBoundingClientRect();
      const rawSrc = frame.getAttribute("src");
      let src = "about:blank";
      if (rawSrc) {
        try {
          src = new URL(rawSrc, location.href).href;
        } catch (_) {
          src = rawSrc;
        }
      }
      return {
        src,
        rect: {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height
        }
      };
    });
  }

  function viewport() {
    return {
      width: innerWidth,
      height: innerHeight,
      deviceScaleFactor: devicePixelRatio || 1
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isTrustedExtensionSender(sender, chrome.runtime.id)) return false;
    if (!message || message.source !== SOURCE) return false;
    if (message.type === "ping") {
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === "inspect") {
      const items = inspectLocal(message.limit);
      sendResponse({
        ok: true,
        items,
        viewport: viewport(),
        redactions: items.flatMap((item) => item.redactions || []),
        childFrames: childFrameEntries(),
        frameUrl: safeFrameUrl(location.href)
      });
      return false;
    }
    if (message.type === "find") {
      sendResponse({
        ok: true,
        target: findLocal(message.spec),
        childFrames: childFrameEntries(),
        frameUrl: safeFrameUrl(location.href)
      });
      return false;
    }
    if (message.type === "setValue") {
      sendResponse({
        ok: true,
        result: setElementValueLocal(message.spec, message.text),
        frameUrl: safeFrameUrl(location.href)
      });
      return false;
    }
    return false;
  });
})();
