import { describe, expect, it } from "@effect/vitest";

import {
  nextDevboxNumber,
  parseCoderList,
  parsePairingToken,
  randomDevboxName,
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

  it("puts the creation number first after the prefix, zero-padded", () => {
    expect(slugifyDevboxName("shiny pine", undefined, 3)).toBe("03-shiny-pine");
    expect(slugifyDevboxName("shiny pine", "dyurinov", 12)).toBe("dyurinov-12-shiny-pine");
    expect(slugifyDevboxName("a very long task description", "dyurinov", 7)).toBe(
      "dyurinov-07-a-very-long-task-des",
    );
    expect(randomDevboxName(undefined, new Set(), () => 0, 1)).toMatch(/^01-[a-z]+-[a-z]+$/u);
  });

  it("numbers past the stored counter and every numbered box, ignoring older names", () => {
    expect(nextDevboxNumber(undefined, [], undefined)).toBe(1);
    expect(nextDevboxNumber(undefined, ["shiny-pine", "dyurinov-1"], undefined)).toBe(1);
    expect(nextDevboxNumber(4, ["02-calm-lake"], undefined)).toBe(4);
    expect(nextDevboxNumber(2, ["09-calm-lake", "shiny-pine"], undefined)).toBe(10);
    expect(nextDevboxNumber(undefined, ["dyurinov-05-calm-lake"], "dyurinov")).toBe(6);
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

describe("randomDevboxName", () => {
  it("is two words, and avoids names Coder already has", () => {
    let seed = 0;
    const sequence = () => (seed++ % 2 === 0 ? 0 : 0.999);
    const first = randomDevboxName(undefined, new Set(), sequence);
    expect(first).toMatch(/^[a-z]+-[a-z]+$/u);
    seed = 0;
    const second = randomDevboxName(undefined, new Set([first]), sequence);
    expect(second).not.toBe(first);
    expect(randomDevboxName("dyurinov", new Set(), () => 0)).toMatch(/^dyurinov-[a-z]+-[a-z]+$/u);
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
