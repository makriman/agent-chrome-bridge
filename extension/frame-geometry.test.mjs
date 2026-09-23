import assert from "node:assert/strict";
import test from "node:test";
import { assignFrameOffsets, placeItems } from "./frame-geometry.mjs";

test("nested iframe offsets accumulate to the top viewport", () => {
  const frames = [
    { frameId: 0, parentFrameId: -1, url: "https://shop.example/apps" },
    { frameId: 2, parentFrameId: 0, url: "https://admin.example/embed" },
    { frameId: 7, parentFrameId: 2, url: "https://pay.example/button" }
  ];
  const reports = [
    {
      frameId: 0,
      items: [{ text: "Apps", rect: { left: 1, top: 2, right: 11, bottom: 12, width: 10, height: 10 } }],
      childFrames: [{ src: "https://admin.example/embed", rect: { left: 10, top: 20, right: 110, bottom: 220, width: 100, height: 200 } }]
    },
    {
      frameId: 2,
      items: [{ text: "Embed", rect: { left: 3, top: 4, right: 13, bottom: 14, width: 10, height: 10 } }],
      childFrames: [{ src: "https://pay.example/button", rect: { left: 5, top: 6, right: 25, bottom: 26, width: 20, height: 20 } }]
    },
    {
      frameId: 7,
      items: [{ text: "Pay", rect: { left: 1, top: 1, right: 9, bottom: 9, width: 8, height: 8 } }],
      childFrames: []
    }
  ];
  const offsets = assignFrameOffsets(frames, new Map(reports.map((report) => [report.frameId, report.childFrames])));
  assert.deepEqual(offsets.get(0), { x: 0, y: 0 });
  assert.deepEqual(offsets.get(2), { x: 10, y: 20 });
  assert.deepEqual(offsets.get(7), { x: 15, y: 26 });

  const items = placeItems(frames, reports);
  assert.deepEqual(items.map((item) => [item.text, item.rect.left, item.rect.top]), [
    ["Apps", 1, 2],
    ["Embed", 13, 24],
    ["Pay", 16, 27]
  ]);
});

test("same-url sibling iframes are paired in frame order", () => {
  const frames = [
    { frameId: 0, parentFrameId: -1, url: "https://shop.example/" },
    { frameId: 4, parentFrameId: 0, url: "https://cdn.example/widget" },
    { frameId: 9, parentFrameId: 0, url: "https://cdn.example/widget" }
  ];
  const offsets = assignFrameOffsets(frames, new Map([
    [0, [
      { src: "https://cdn.example/widget#a", rect: { left: 0, top: 0, width: 10, height: 10 } },
      { src: "https://cdn.example/widget#b", rect: { left: 30, top: 40, width: 10, height: 10 } }
    ]]
  ]));
  assert.deepEqual(offsets.get(4), { x: 0, y: 0 });
  assert.deepEqual(offsets.get(9), { x: 30, y: 40 });
});

test("about:blank frames match empty iframe src in DOM order", () => {
  const frames = [
    { frameId: 0, parentFrameId: -1, url: "https://shop.example/" },
    { frameId: 3, parentFrameId: 0, url: "about:blank" }
  ];
  const offsets = assignFrameOffsets(frames, new Map([
    [0, [{ src: "about:blank", rect: { left: 8, top: 9, width: 10, height: 10 } }]]
  ]));
  assert.deepEqual(offsets.get(3), { x: 8, y: 9 });
});
