import { describe, expect, it } from "vite-plus/test";

import { parsePendingDevboxSends } from "./devboxPendingSends";

describe("parsePendingDevboxSends", () => {
  it("keeps well-formed sends and drops anything else", () => {
    const send = { draftId: "d1", title: "Take over", text: "hi", createdAt: "2026-11-23" };
    const orphan = { ...send, draftId: null };
    expect(
      parsePendingDevboxSends(JSON.stringify([send, orphan, { draftId: 3 }, null, "x"])),
    ).toEqual([send, orphan]);
    expect(parsePendingDevboxSends("{not json")).toEqual([]);
    expect(parsePendingDevboxSends(JSON.stringify({ draftId: "d1" }))).toEqual([]);
    expect(parsePendingDevboxSends(null)).toEqual([]);
  });
});
