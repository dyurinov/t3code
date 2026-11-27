// @effect-diagnostics nodeBuiltinImport:off - Installer fixtures execute the shipped shell script against a fake curl and an isolated home.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { AuthProvidersManageScope, WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";

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
  isCurrentProvisionRevision,
  PROVISION_REVISION,
  PROVISION_SCRIPT,
  PREPARE_ANTIGRAVITY_SCRIPT,
  SETTINGS_TOKEN_SCRIPT,
  INSTALL_PERSONALIZATION_SCRIPT,
  INSTALL_CREDENTIALS_SCRIPT,
  REFRESH_LOGIN_SCRIPT,
  SIBLING_SCRIPT,
} from "./devboxScripts.ts";

describe("devbox sign-in install", () => {
  it("writes access tokens only, keeps MCP sign-ins, and skips sealed tokens a box without Formal cannot use", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-logins-"));
    using _cleanup = {
      [Symbol.dispose]: () => NodeFS.rmSync(home, { recursive: true, force: true }),
    };
    const bin = NodePath.join(home, "bin");
    NodeFS.mkdirSync(bin);
    NodeFS.writeFileSync(
      NodePath.join(bin, "formal"),
      "#!/bin/sh\necho 'You are not logged in'\n",
      {
        mode: 0o755,
      },
    );
    const credentials = NodePath.join(home, ".claude", ".credentials.json");
    NodeFS.mkdirSync(NodePath.dirname(credentials));
    NodeFS.writeFileSync(
      credentials,
      JSON.stringify({
        claudeAiOauth: { accessToken: "old", refreshToken: "box-own-refresh" },
        mcpOAuth: { "axiom|1": { accessToken: "mcp" } },
      }),
    );
    NodeFS.writeFileSync(NodePath.join(home, ".claude.json"), JSON.stringify({ theme: "dark" }));
    const payload = {
      claude: {
        oauth: { accessToken: "sk-ant-oat01-new", expiresAt: 1, scopes: ["user:inference"] },
        oauthAccount: { emailAddress: "me@example.com" },
      },
      codex: {
        auth_mode: "chatgpt",
        tokens: { id_token: "id", access_token: "formalsealed:v2:codex", refresh_token: "" },
      },
    };
    const stdout = NodeChildProcess.execFileSync("python3", ["-c", INSTALL_CREDENTIALS_SCRIPT], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(JSON.parse(stdout)).toEqual({ claude: "installed", codex: "unbound" });
    expect(JSON.parse(NodeFS.readFileSync(credentials, "utf8"))).toEqual({
      claudeAiOauth: payload.claude.oauth,
      mcpOAuth: { "axiom|1": { accessToken: "mcp" } },
    });
    expect(NodeFS.statSync(credentials).mode & 0o777).toBe(0o600);
    expect(JSON.parse(NodeFS.readFileSync(NodePath.join(home, ".claude.json"), "utf8"))).toEqual({
      theme: "dark",
      oauthAccount: payload.claude.oauthAccount,
      hasCompletedOnboarding: true,
    });
    expect(NodeFS.existsSync(NodePath.join(home, ".codex", "auth.json"))).toBe(false);
  });
});

describe("devbox sign-in install with broken files", () => {
  it.each(["{ not json", "null", "[]"])(
    "still installs Codex, and leaves Claude untouched, when Claude's config is %s",
    (config) => {
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-logins-broken-"));
      using _cleanup = {
        [Symbol.dispose]: () => NodeFS.rmSync(home, { recursive: true, force: true }),
      };
      NodeFS.writeFileSync(NodePath.join(home, ".claude.json"), config);
      const stdout = NodeChildProcess.execFileSync("python3", ["-c", INSTALL_CREDENTIALS_SCRIPT], {
        input: JSON.stringify({
          claude: { oauth: { accessToken: "sk-ant-oat01-new" }, oauthAccount: {} },
          codex: { auth_mode: "chatgpt", tokens: { access_token: "access", refresh_token: "" } },
        }),
        encoding: "utf8",
        env: { ...process.env, HOME: home },
      });
      expect(JSON.parse(stdout)).toEqual({ claude: "failed", codex: "installed" });
      expect(NodeFS.existsSync(NodePath.join(home, ".codex", "auth.json"))).toBe(true);
      expect(NodeFS.existsSync(NodePath.join(home, ".claude", ".credentials.json"))).toBe(false);
    },
  );
});

describe("devbox sign-in renewal", () => {
  it("tells a dead refresh token from an outage, in each provider's error shape", () => {
    const cases = [
      { status: 400, body: { error: "invalid_grant" }, expected: "rejected" },
      {
        status: 401,
        body: { error: { code: "invalid_refresh_token", type: "invalid_request_error" } },
        expected: "rejected",
      },
      { status: 401, body: { error: { code: "refresh_token_reused" } }, expected: "rejected" },
      { status: 400, body: { error: "invalid_scope" }, expected: "unreachable" },
      { status: 403, body: "<html>blocked by proxy</html>", expected: "unreachable" },
    ];
    for (const { status, body, expected } of cases) {
      const text = typeof body === "string" ? body : JSON.stringify(body);
      // Stands in for the provider: every request is answered with this refusal.
      const harness = [
        "import io, sys, urllib.error, urllib.request",
        "def refuse(request, timeout=None):",
        `    raise urllib.error.HTTPError(request.full_url, ${status}, "refused", {}, io.BytesIO(${JSON.stringify(text)}.encode()))`,
        "urllib.request.urlopen = refuse",
        "exec(sys.argv[1])",
      ].join("\n");
      const stdout = NodeChildProcess.execFileSync(
        "python3",
        ["-c", harness, REFRESH_LOGIN_SCRIPT],
        {
          input: JSON.stringify({
            provider: "codex",
            refreshToken: "rt.1.secret",
            scopes: [],
            requireFormal: false,
          }),
          encoding: "utf8",
        },
      );
      expect(JSON.parse(stdout)).toEqual({ error: expected, status });
    }
  });

  it("refuses to send a token that needs Formal from a box without it", () => {
    const bin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-renew-"));
    using _cleanup = {
      [Symbol.dispose]: () => NodeFS.rmSync(bin, { recursive: true, force: true }),
    };
    NodeFS.writeFileSync(
      NodePath.join(bin, "formal"),
      "#!/bin/sh\necho 'You are not logged in'\n",
      {
        mode: 0o755,
      },
    );
    const stdout = NodeChildProcess.execFileSync("python3", ["-c", REFRESH_LOGIN_SCRIPT], {
      input: JSON.stringify({
        provider: "claude",
        refreshToken: "sk-ant-ort01-secret",
        scopes: [],
        requireFormal: true,
      }),
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(JSON.parse(stdout)).toEqual({ error: "unbound" });
  });
});

describe("devbox personal instructions", () => {
  it("copies shared skill files for both providers and updates the managed instruction block", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-personalization-"));
    using _cleanup = {
      [Symbol.dispose]: () => NodeFS.rmSync(home, { recursive: true, force: true }),
    };
    const instructions = NodePath.join(home, ".codex", "AGENTS.md");
    NodeFS.mkdirSync(NodePath.dirname(instructions), { recursive: true });
    NodeFS.writeFileSync(instructions, "Keep my existing instructions.\n");
    NodeFS.writeFileSync(NodePath.join(home, ".codex", "auth.json"), "untouched credentials");
    const payload = {
      skills: {
        cleantest: {
          "SKILL.md":
            "---\nname: cleantest\ndescription: Deduplicate and reduce tests.\n---\nCleanTest workflow\n",
        },
        council: {
          "SKILL.md":
            "---\nname: council\ndescription: Review with the council.\n---\nCouncil workflow\n",
        },
        dig: {
          "agents/openai.yaml": "policy:\n  allow_implicit_invocation: false\n",
          "SKILL.md": "---\nname: dig\ndisable-model-invocation: true\n---\nFind evidence\n",
        },
      },
      codexInstructions: "## Council\nUse reviewer A and reviewer B only.\n",
      claudeInstructions: "## Council\nUse reviewer A and reviewer B only.\n",
    };
    const run = () =>
      NodeChildProcess.execFileSync("python3", ["-c", INSTALL_PERSONALIZATION_SCRIPT], {
        input: JSON.stringify(payload),
        encoding: "utf8",
        env: { ...process.env, HOME: home },
      });
    run();
    for (const provider of [".agents", ".codex", ".claude"]) {
      for (const [name, files] of Object.entries(payload.skills)) {
        for (const [relative, content] of Object.entries(files)) {
          expect(
            NodeFS.readFileSync(NodePath.join(home, provider, "skills", name, relative), "utf8"),
          ).toBe(content);
        }
      }
    }
    const first = NodeFS.readFileSync(instructions, "utf8");
    expect(first).toContain("Keep my existing instructions.");
    expect(first).toContain(payload.codexInstructions.trim());
    run();
    expect(NodeFS.readFileSync(instructions, "utf8")).toBe(first);
    payload.codexInstructions = "## Council\nUpdated reviewer preference.\n";
    run();
    const updated = NodeFS.readFileSync(instructions, "utf8");
    expect(updated).toContain("Keep my existing instructions.");
    expect(updated).toContain(payload.codexInstructions.trim());
    expect(updated).not.toContain("Use reviewer A and reviewer B only.");
    expect(NodeFS.readFileSync(NodePath.join(home, ".codex/auth.json"), "utf8")).toBe(
      "untouched credentials",
    );
    expect(NodeFS.readFileSync(NodePath.join(home, ".claude/CLAUDE.md"), "utf8")).toContain(
      payload.claudeInstructions.trim(),
    );
  });
});

describe("devbox Antigravity preparation", () => {
  it("issues the exact RPC scopes required to read settings and manage provider instances", () => {
    const granted = [...SETTINGS_TOKEN_SCRIPT.matchAll(/--scope\s+(\S+)/g)].map((m) => m[1]);
    expect(granted).toContain(requiredScopeForRpcMethod(WS_METHODS.serverGetSettings));
    expect(granted).toContain(AuthProvidersManageScope);
  });

  it("verifies broker project and brokerId, downloads and SHA-512-verifies agy on clean install, and rejects mismatches", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agy-prepare-"));
    using _cleanup = {
      [Symbol.dispose]: () => NodeFS.rmSync(home, { recursive: true, force: true }),
    };
    const payloadDir = NodePath.join(home, "archive-src");
    NodeFS.mkdirSync(payloadDir, { recursive: true });
    const fakeAgyScript = "#!/bin/sh\necho fake-agy\n";
    NodeFS.writeFileSync(NodePath.join(payloadDir, "antigravity"), fakeAgyScript, { mode: 0o755 });
    const archivePath = NodePath.join(home, "cli_linux_x64.tar.gz");
    NodeChildProcess.execFileSync("tar", ["-czf", archivePath, "-C", payloadDir, "antigravity"]);
    const archiveBytes = NodeFS.readFileSync(archivePath);
    const validSha512 = NodeCrypto.createHash("sha512").update(archiveBytes).digest("hex");

    const runWithFixture = (opts: {
      brokerProject: string;
      expectedProject: string;
      actualBrokerId?: string;
      expectedBrokerId?: string;
      sha512?: string;
      downloadUrl?: string;
    }) => {
      const harness = `
import io, json, platform, time, urllib.request
platform.machine = lambda: "x86_64"
time.sleep = lambda _: None
archive = open(${JSON.stringify(archivePath)}, "rb").read()
manifest = json.dumps({
    "version": "1.5.17",
    "url": ${JSON.stringify(opts.downloadUrl ?? "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.17-1/linux-x64/cli_linux_x64.tar.gz")},
    "sha512": ${JSON.stringify(opts.sha512 ?? validSha512)},
}).encode()
class FakeResp(io.BytesIO):
    def __init__(self, data, headers=None, status=200):
        super().__init__(data)
        self.headers = headers or {}
        self.status = status
    def __enter__(self): return self
    def __exit__(self, *a): return False
def fake_urlopen(req, timeout=30):
    url = req.full_url if hasattr(req, "full_url") else str(req)
    if url.endswith("/computeMetadata/v1/project/project-id"):
        assert req.headers.get("Metadata-flavor") == "Google"
        return FakeResp(${JSON.stringify(opts.brokerProject)}.encode(), {"Metadata-Flavor": "Google"})
    if url.endswith("/computeMetadata/v1/instance/attributes/t3-broker-id"):
        assert req.headers.get("Metadata-flavor") == "Google"
        return FakeResp(${JSON.stringify(opts.actualBrokerId ?? "broker-123")}.encode(), {"Metadata-Flavor": "Google"})
    if url.endswith("/manifests/linux_amd64.json"):
        return FakeResp(manifest)
    if url.startswith("https://storage.googleapis.com/antigravity-public/antigravity-cli/"):
        return FakeResp(archive)
    raise AssertionError(f"unexpected url: {url}")
class FakeOpener:
    def open(self, req, timeout=30):
        return fake_urlopen(req, timeout=timeout)
def fake_build_opener(*handlers):
    assert any(isinstance(h, urllib.request.ProxyHandler) and h.proxies == {} for h in handlers)
    return FakeOpener()
urllib.request.build_opener = fake_build_opener
urllib.request.urlopen = fake_urlopen
exec(compile(${JSON.stringify(PREPARE_ANTIGRAVITY_SCRIPT)}, "prepare_agy.py", "exec"))
`;
      return NodeChildProcess.spawnSync("python3", ["-c", harness], {
        input: JSON.stringify({
          gcpProject: opts.expectedProject,
          metadataHost: "127.0.0.1:13798",
          brokerId: opts.expectedBrokerId ?? "broker-123",
        }),
        encoding: "utf8",
        env: { ...process.env, HOME: home },
      });
    };

    // Rejects SHA-512 checksum mismatch before touching ~/.local/bin/agy.
    const badHash = runWithFixture({
      brokerProject: "demo-proj",
      expectedProject: "demo-proj",
      sha512: "0".repeat(128),
    });
    expect(badHash.status).not.toBe(0);
    expect(badHash.stderr).toContain("SHA-512 checksum mismatch");
    expect(NodeFS.existsSync(NodePath.join(home, ".local/bin/agy"))).toBe(false);

    // Rejects untrusted download URL outside Google's bucket prefix.
    const badUrl = runWithFixture({
      brokerProject: "demo-proj",
      expectedProject: "demo-proj",
      downloadUrl: "https://evil.example/cli_linux_x64.tar.gz",
    });
    expect(badUrl.status).not.toBe(0);
    expect(badUrl.stderr).toContain("Unexpected Antigravity download URL");

    // Rejects when another host's broker owns port 13798 even for the same GCP project.
    const wrongBroker = runWithFixture({
      brokerProject: "demo-proj",
      expectedProject: "demo-proj",
      actualBrokerId: "other-host-broker",
      expectedBrokerId: "broker-123",
    });
    expect(wrongBroker.status).not.toBe(0);
    expect(wrongBroker.stderr).toContain("Vertex metadata broker");

    // Clean install succeeds and writes executable ~/.local/bin/agy.
    const ok = runWithFixture({
      brokerProject: "demo-proj",
      expectedProject: "demo-proj",
    });
    expect(ok.status).toBe(0);
    const agyBin = NodePath.join(home, ".local/bin/agy");
    expect(ok.stdout.trim()).toBe(agyBin);
    expect(NodeFS.readFileSync(agyBin, "utf8")).toBe(fakeAgyScript);
    expect(NodeFS.statSync(agyBin).mode & 0o111).not.toBe(0);

    // Rejects when broker answers with a different project.
    const wrongProject = runWithFixture({
      brokerProject: "wrong-proj",
      expectedProject: "demo-proj",
    });
    expect(wrongProject.status).not.toBe(0);
    expect(wrongProject.stderr).toContain("Vertex metadata broker");
  });
});

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

  it("bounds every curl call in PROVISION_SCRIPT with connect and max-time timeouts", () => {
    const curlLines = PROVISION_SCRIPT.split("\n").filter((line) => /\bcurl\b/u.test(line));
    expect(curlLines.length).toBeGreaterThanOrEqual(2);
    for (const line of curlLines) {
      expect(line).toContain("--connect-timeout");
      expect(line).toContain("--max-time");
    }
  });

  it("lets boxes provisioned before the readiness timeout reconnect", () => {
    expect(isCurrentProvisionRevision(PROVISION_REVISION)).toBe(true);
    expect(isCurrentProvisionRevision("b1cd7455")).toBe(true);
    expect(isCurrentProvisionRevision(undefined)).toBe(false);
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
