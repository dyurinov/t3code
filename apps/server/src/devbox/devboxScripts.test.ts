import { describe, expect, it } from "vitest";

import {
  parseCoderList,
  parsePairingToken,
  slugifyDevboxName,
  uniqueDevboxName,
} from "./devboxScripts.ts";

describe("devbox names", () => {
  it.each([
    ["Fix the inbox crash!", undefined, "fix-the-inbox-crash"],
    ["Fix the inbox crash!", "dyurinov", "dyurinov-fix-the-inbox-crash"],
    ["  --- ", "dyurinov", "dyurinov-box"],
    ["Ünïcode & spaces__here", undefined, "n-code-spaces-here"],
    [
      "a very long task description that goes on and on",
      "dyurinov",
      "dyurinov-a-very-long-task-descri",
    ],
  ])("%j with prefix %j is %j", (input, prefix, expected) => {
    const name = slugifyDevboxName(input, prefix);
    expect(name).toBe(expected);
    expect(name.length).toBeLessThanOrEqual(32);
    expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/u);
  });

  it("adds a number when Coder already has the name, staying within 32 characters", () => {
    expect(uniqueDevboxName("fix-crash", new Set())).toBe("fix-crash");
    expect(uniqueDevboxName("fix-crash", new Set(["fix-crash", "fix-crash-2"]))).toBe(
      "fix-crash-3",
    );
    const long = "dyurinov-a-very-long-task-descri";
    expect(uniqueDevboxName(long, new Set([long]))).toBe("dyurinov-a-very-long-task-desc-2");
  });
});

describe("parseCoderList", () => {
  it("reads workspaces even when parameters contain raw control characters", () => {
    const stdout = `[{"name":"dyurinov-1","latest_build":{"status":"running","deadline":"2026-11-14T19:00:00Z","resources":[{"x":"line one\nline\ttwo"}]}},{"name":"dyurinov-2","latest_build":{"status":"stopped"}}]`;
    expect(
      parseCoderList(stdout).map((workspace) => [
        workspace.name,
        workspace.latest_build.status,
        workspace.latest_build.deadline ?? null,
      ]),
    ).toEqual([
      ["dyurinov-1", "running", "2026-11-14T19:00:00Z"],
      ["dyurinov-2", "stopped", null],
    ]);
  });
});

describe("parsePairingToken", () => {
  it("finds the token line among the QR code and URLs", () => {
    const stdout =
      "█▀▀▀▀▀█\nPairing URL: http://127.0.0.1:3773/pair#abc\nApp link: t3://x\nToken: abc123-XYZ\n";
    expect(parsePairingToken(stdout)).toBe("abc123-XYZ");
    expect(parsePairingToken("no token here")).toBeUndefined();
  });
});
