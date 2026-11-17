import { describe, expect, it } from "vite-plus/test";

import { followDevboxWake } from "./devboxWake";

const box = (state: "starting" | "failed" | "running", lastError: string | null = null) => ({
  name: "05-witty-owl",
  state,
  lastError,
});

describe("followDevboxWake", () => {
  it("ignores a failure left from an earlier attempt, then fails once this wake fails", () => {
    const stale = followDevboxWake(false, box("failed", "old"));
    expect(stale).toEqual({ woke: false, failure: null });
    const starting = followDevboxWake(stale.woke, box("starting"));
    expect(starting).toEqual({ woke: true, failure: null });
    expect(
      followDevboxWake(starting.woke, box("failed", "terraform apply: exit status 1")),
    ).toEqual({
      woke: true,
      failure: "05-witty-owl did not start: terraform apply: exit status 1",
    });
  });
});
