// @effect-diagnostics nodeBuiltinImport:off - Installer fixtures execute the shipped shell script against a fake curl and an isolated home.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";

import {
  devboxSpans,
  goneFromCoder,
  hoursWithin,
  nextDevboxNumber,
  shownDevboxState,
  parseCoderList,
  parsePairingToken,
  randomDevboxName,
  slugifyDevboxName,
  uniqueDevboxName,
  INSTALL_T3_SCRIPT,
  SIBLING_SCRIPT,
} from "./devboxScripts.ts";

function installerFixture() {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3 install "));
  const bin = NodePath.join(home, "bin");
  const version = "0.1.10-nightly.20261116.42";
  const archive = `t3-${version}-linux-x64.tar.gz`;
  NodeFS.mkdirSync(bin);
  NodeFS.writeFileSync(
    NodePath.join(bin, "sha256sum"),
    '#!/usr/bin/env python3\nimport hashlib, pathlib, sys\nprint(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest() + "  " + sys.argv[1])\n',
    { mode: 0o755 },
  );
  const payload = NodePath.join(home, "payload");
  NodeFS.mkdirSync(payload);
  NodeFS.writeFileSync(NodePath.join(payload, "t3"), "#!/bin/sh\necho t3-fixture\n", {
    mode: 0o755,
  });
  NodeChildProcess.execFileSync("tar", [
    "-czf",
    NodePath.join(home, archive),
    "-C",
    home,
    "payload",
  ]);
  NodeFS.writeFileSync(
    NodePath.join(home, "SHA256SUMS"),
    `${NodeCrypto.createHash("sha256")
      .update(NodeFS.readFileSync(NodePath.join(home, archive)))
      .digest("hex")}  ${archive}\n`,
  );
  NodeFS.writeFileSync(
    NodePath.join(home, "release.json"),
    JSON.stringify({
      tag_name: `v${version}`,
      assets: [
        { name: "SHA256SUMS", id: 11 },
        { name: archive, id: 12 },
      ],
    }),
  );
  NodeFS.writeFileSync(
    NodePath.join(bin, "curl"),
    `#!/usr/bin/env python3
import json, os, pathlib, sys
args = sys.argv[1:]
url = args[-1]
root = pathlib.Path(os.environ["INSTALL_FIXTURE"])
with (root / "requests").open("a") as f: f.write(url + "\\n")
output = next((args[i+1] for i,a in enumerate(args) if a in ["-o", "--output"]), None)
status = "200"
if os.environ.get("FAIL_DOWNLOAD") or "github.com/pingdotgg" in url:
    status = "403"
    body = json.dumps({"message":"Formal has no current http-github sign-in. Link it at https://catalog.formal.ai/catalog/resource/resource_fixture"}).encode()
elif "/releases/assets/" in url:
    if "application/octet-stream" not in " ".join(args): raise SystemExit("Missing asset Accept header")
    body = (root / ("SHA256SUMS" if url.endswith("/11") else "${archive}")).read_bytes()
else:
    release = json.loads((root / "release.json").read_text())
    body = json.dumps([release] if "?per_page" in url else release).encode()
if output: pathlib.Path(output).write_bytes(body)
elif status != "403" or not any(a.startswith("-f") for a in args): sys.stdout.buffer.write(body)
if "--write-out" in args or "-w" in args: print(status, end="")
if status == "403" and any(a.startswith("-f") for a in args): raise SystemExit(22)
`,
    { mode: 0o755 },
  );
  return {
    home,
    version,
    run(requested = "latest-nightly", fail = false) {
      return NodeChildProcess.spawnSync("sh", ["-s", "--", requested, "fixture-box"], {
        input: INSTALL_T3_SCRIPT,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
          INSTALL_FIXTURE: home,
          ...(fail ? { FAIL_DOWNLOAD: "1" } : {}),
        },
      });
    },
    [Symbol.dispose]() {
      NodeFS.rmSync(home, { recursive: true, force: true });
    },
  };
}

describe("T3 release installation", () => {
  it.each(["latest-nightly", "pinned"])(
    "installs %s entirely through the GitHub API",
    (requested) => {
      using fixture = installerFixture();
      const result = fixture.run(requested === "pinned" ? fixture.version : requested);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(
        NodeFS.readFileSync(
          NodePath.join(fixture.home, ".t3/runtime/current/.install-complete"),
          "utf8",
        ).trim(),
      ).toBe(fixture.version);
      expect(NodeFS.readFileSync(NodePath.join(fixture.home, "requests"), "utf8")).not.toContain(
        "https://github.com/",
      );
    },
  );

  it("reports the proxy sign-in message without feeding the failed response to Python", () => {
    using fixture = installerFixture();
    const result = fixture.run("latest-nightly", true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("https://catalog.formal.ai/catalog/resource/resource_fixture");
    expect(result.stderr).not.toContain("Traceback");
  });
});

describe("sibling links", () => {
  it("restarts a sibling's tunnel only when its port changes, and prints a link token", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3 sibling "));
    const bin = NodePath.join(home, "bin");
    NodeFS.mkdirSync(NodePath.join(home, ".t3/runtime/current"), { recursive: true });
    NodeFS.mkdirSync(bin);
    NodeFS.writeFileSync(
      NodePath.join(bin, "systemctl"),
      `#!/bin/sh\necho "$*" >>"${home}/systemctl.log"\n`,
      { mode: 0o755 },
    );
    NodeFS.writeFileSync(
      NodePath.join(home, ".t3/runtime/current/t3"),
      "#!/bin/sh\necho token-1\n",
      {
        mode: 0o755,
      },
    );
    const run = (port: number) => {
      NodeFS.rmSync(NodePath.join(home, "systemctl.log"), { force: true });
      const result = NodeChildProcess.spawnSync("sh", ["-s", "--", "07-owl", String(port)], {
        input: SIBLING_SCRIPT,
        encoding: "utf8",
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
      });
      expect(result.status).toBe(0);
      return {
        token: result.stdout.trim().split("\n").at(-1),
        systemctl: NodeFS.readFileSync(NodePath.join(home, "systemctl.log"), "utf8"),
      };
    };
    try {
      const first = run(13802);
      expect(first.token).toBe("token-1");
      expect(first.systemctl).toContain("restart t3-peer-07-owl.socket");
      expect(
        NodeFS.readFileSync(
          NodePath.join(home, ".config/systemd/user/t3-peer-07-owl-tunnel.service"),
          "utf8",
        ),
      ).toContain("port-forward 07-owl --tcp 127.0.0.1:23802:3773");

      expect(run(13802).systemctl).not.toMatch(/restart|stop/u);
      expect(run(13805).systemctl).toContain("restart t3-peer-07-owl.socket");
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });
});

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

describe("devboxSpans", () => {
  const at = (hour: number) => `2026-11-15T${String(hour).padStart(2, "0")}:00:00Z`;
  const build = (
    build_number: number,
    transition: string,
    created: number,
    completed: number | null,
    status = "succeeded",
  ) => ({
    build_number,
    transition,
    created_at: at(created),
    job: { status, completed_at: completed === null ? null : at(completed) },
  });
  const hour = (value: number) => Date.parse(at(value));

  it("runs from each start until its stop finishes, ignoring failed builds", () => {
    const spans = devboxSpans(
      [
        build(4, "start", 10, null, "running"),
        build(3, "stop", 6, 7),
        build(2, "start", 3, 4, "failed"),
        build(1, "start", 1, 2),
      ],
      hour(12),
    );
    expect(spans.awake).toEqual([
      [hour(1), hour(7)],
      [hour(10), hour(12)],
    ]);
    expect(spans.existed).toEqual([hour(1), hour(12)]);
    expect(hoursWithin(spans.awake, hour(5), hour(11))).toBe(3);
  });

  it("ends a deleted box's life when its delete finishes", () => {
    const spans = devboxSpans([build(2, "delete", 5, 6), build(1, "start", 1, 2)], hour(12));
    expect(spans.awake).toEqual([[hour(1), hour(6)]]);
    expect(spans.existed).toEqual([hour(1), hour(6)]);
  });
});

describe("shownDevboxState", () => {
  it.each([
    [undefined, "stopped", "stopped"],
    ["starting", "stopped", "starting"],
    ["failed", "stopped", "failed"],
    ["failed", "running", "failed"],
    ["failed", "starting", "failed"],
  ] as const)("action %j with Coder %j shows %j", (transient, actual, shown) => {
    expect(shownDevboxState(transient, actual)).toBe(shown);
  });
});

describe("goneFromCoder", () => {
  const check = (misses: ReadonlyMap<string, number>, listed: ReadonlyArray<string>) =>
    goneFromCoder({
      recorded: ["kept", "vanished", "new"],
      listed: new Set(listed),
      creating: new Set(["new"]),
      misses,
      confirmations: 2,
    });

  it("drops a box only after two lists in a row miss it", () => {
    const first = check(new Map(), ["kept"]);
    expect(first.gone).toEqual([]);
    expect([...first.misses]).toEqual([["vanished", 1]]);
    expect(check(first.misses, ["kept"]).gone).toEqual(["vanished"]);
  });

  it("forgets a miss once the box shows up again, and never counts boxes being created", () => {
    const first = check(new Map(), ["kept"]);
    const back = check(first.misses, ["kept", "vanished"]);
    expect(back.gone).toEqual([]);
    expect(back.misses.size).toBe(0);
  });
});
