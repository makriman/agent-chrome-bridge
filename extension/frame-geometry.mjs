function canonicalUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href;
  } catch (_) {
    return "";
  }
}

function isBlank(value) {
  return !value || value === "about:blank";
}

function urlsMatch(left, right) {
  const a = canonicalUrl(left);
  const b = canonicalUrl(right);
  return Boolean(a && b && a === b);
}

// Match child browsing contexts to iframe elements the parent content script
// measured. Same-URL siblings are paired in frameId order with DOM order.
export function assignFrameOffsets(frames, childFramesById) {
  const byId = new Map(frames.map((frame) => [frame.frameId, frame]));
  const rectByFrame = new Map();
  const groups = new Map();

  for (const frame of frames) {
    const parentId = frame.parentFrameId;
    if (parentId === undefined || parentId === null || parentId < 0) continue;
    if (!groups.has(parentId)) groups.set(parentId, []);
    groups.get(parentId).push(frame);
  }

  for (const [parentId, children] of groups) {
    const boxes = childFramesById.get(parentId) || [];
    const used = new Set();
    const sorted = [...children].sort((a, b) => a.frameId - b.frameId);
    for (const child of sorted) {
      const childUrl = child.url || "";
      const childBlank = isBlank(childUrl);
      const matchIndex = boxes.findIndex((box, index) => {
        if (used.has(index)) return false;
        const src = box && box.src ? box.src : "";
        if (childBlank && isBlank(src)) return true;
        return !childBlank && urlsMatch(src, childUrl);
      });
      if (matchIndex >= 0) {
        used.add(matchIndex);
        rectByFrame.set(child.frameId, boxes[matchIndex].rect || null);
      } else {
        rectByFrame.set(child.frameId, null);
      }
    }
  }

  const offsets = new Map();

  function walk(frameId, stack) {
    if (offsets.has(frameId)) return offsets.get(frameId);
    if (stack.has(frameId)) return { x: 0, y: 0 };
    const frame = byId.get(frameId);
    if (!frame || frame.parentFrameId === undefined || frame.parentFrameId === null || frame.parentFrameId < 0) {
      const zero = { x: 0, y: 0 };
      offsets.set(frameId, zero);
      return zero;
    }
    stack.add(frameId);
    const parent = walk(frame.parentFrameId, stack);
    stack.delete(frameId);
    const rect = rectByFrame.get(frameId);
    const next = rect
      ? { x: parent.x + Number(rect.left || 0), y: parent.y + Number(rect.top || 0) }
      : { x: parent.x, y: parent.y };
    offsets.set(frameId, next);
    return next;
  }

  for (const frame of frames) walk(frame.frameId, new Set());
  return offsets;
}

export function translateRect(rect, offset) {
  if (!rect) return rect;
  const x = offset ? Number(offset.x || 0) : 0;
  const y = offset ? Number(offset.y || 0) : 0;
  return {
    left: rect.left + x,
    top: rect.top + y,
    right: rect.right + x,
    bottom: rect.bottom + y,
    width: rect.width,
    height: rect.height
  };
}

export function placeItems(frames, reports) {
  const childFramesById = new Map(reports.map((report) => [report.frameId, report.childFrames || []]));
  const offsets = assignFrameOffsets(frames, childFramesById);
  const items = [];
  for (const report of reports) {
    const offset = offsets.get(report.frameId) || { x: 0, y: 0 };
    for (const item of report.items || []) {
      if (!item || !item.rect) continue;
      items.push({ ...item, rect: translateRect(item.rect, offset) });
    }
  }
  items.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  return items;
}
