#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off globalConsole:off - Standalone macOS restart helper must survive the app and run without workspace dependencies.
/* oxlint-disable t3code/no-global-process-runtime -- This copied standalone helper cannot import workspace runtime services. */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as NodeConsole from "node:console";
import * as NodeNet from "node:net";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const app = "/Applications/T3 Code Fork (Nightly).app";
const appIds = ["com.t3tools.t3code", "com.t3tools.t3code.fork"];

interface Health {
  serverVersion: string;
  environmentId: string;
}

export interface RestartPlan {
  app: string;
  stagedApp: string | null;
  backupApp: string;
  statusFile: string;
  version: string;
  previousVersion: string;
  environmentId: string | null;
  origin: string;
  jobLabel: string;
  uid: number;
}

interface RestartStatus {
  phase: "running" | "succeeded" | "rolled-back" | "failed";
  error?: string;
}

interface RestartActions {
  quit: () => Promise<void>;
  waitStopped: () => Promise<void>;
  open: () => Promise<void>;
  waitHealthy: (version: string) => Promise<Health>;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const exists = (file: string) =>
  NodeFSP.access(file).then(
    () => true,
    () => false,
  );
const matches = (health: Health, version: string, environmentId: string | null) =>
  health.serverVersion === version &&
  (environmentId === null || health.environmentId === environmentId);

export async function restartOnce(
  plan: RestartPlan,
  actions: RestartActions,
): Promise<RestartStatus> {
  try {
    await NodeFSP.writeFile(plan.statusFile, JSON.stringify({ phase: "running" }), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    return JSON.parse(await NodeFSP.readFile(plan.statusFile, "utf8"));
  }
  let replaced = false;
  let result: RestartStatus;
  try {
    await actions.quit();
    await actions.waitStopped();
    if (plan.stagedApp !== null) {
      await NodeFSP.rename(plan.app, plan.backupApp);
      replaced = true;
      await NodeFSP.rename(plan.stagedApp, plan.app);
    }
    await actions.open();
    const health = await actions.waitHealthy(plan.version);
    if (!matches(health, plan.version, plan.environmentId))
      throw new Error("The restarted server has the wrong version or environment identity.");
    result = { phase: "succeeded" };
  } catch (error) {
    result = { phase: "failed", error: errorText(error) };
    if (replaced) {
      try {
        await actions.quit();
        await actions.waitStopped();
        if (await exists(plan.app)) await NodeFSP.rename(plan.app, `${plan.backupApp}.failed`);
        await NodeFSP.rename(plan.backupApp, plan.app);
        await actions.open();
        const health = await actions.waitHealthy(plan.previousVersion);
        if (!matches(health, plan.previousVersion, plan.environmentId))
          throw new Error("The restored app did not recover its environment.", { cause: error });
        result = { phase: "rolled-back", error: errorText(error) };
      } catch (rollbackError) {
        result.error += ` Rollback failed: ${errorText(rollbackError)}`;
      }
    }
  }
  await NodeFSP.writeFile(plan.statusFile, `${JSON.stringify(result)}\n`);
  return result;
}

export function launchdPlist(label: string, args: readonly string[], log: string): string {
  const xml = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${args.map((value) => `<string>${xml(value)}</string>`).join("")}</array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><false/>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>\n`;
}

export function nextForkVersion(source: string, installed: string, date: string): string {
  const base = /^\d+\.\d+\.\d+/u.exec(source)?.[0];
  if (!base) throw new Error("Cannot derive the fork version from apps/server/package.json.");
  const prefix = `${base}-nightly.${date}.`;
  const counter = installed.startsWith(prefix) ? Number(installed.slice(prefix.length)) : 0;
  if (!Number.isSafeInteger(counter) || counter < 0)
    throw new Error("Installed fork has an unrecognized version; pass --version explicitly.");
  return `${prefix}${counter + 1}`;
}

async function health(origin: string): Promise<Health | null> {
  try {
    const response = await fetch(`${origin}/.well-known/t3/environment`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    const value: unknown = await response.json();
    if (
      value &&
      typeof value === "object" &&
      "serverVersion" in value &&
      "environmentId" in value &&
      typeof value.serverVersion === "string" &&
      typeof value.environmentId === "string"
    ) {
      return { serverVersion: value.serverVersion, environmentId: value.environmentId };
    }
  } catch {}
  return null;
}

async function running(id: string): Promise<boolean> {
  const result = await exec("/usr/bin/osascript", ["-e", `application id "${id}" is running`], {
    timeout: 10_000,
  });
  return result.stdout.trim() === "true";
}

async function portOpen(origin: string): Promise<boolean> {
  const url = new URL(origin);
  return new Promise((resolve) => {
    const socket = NodeNet.createConnection({
      host: url.hostname.replace(/^\[|\]$/gu, ""),
      port: Number(url.port || 80),
    });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(2_000, () => done(true));
  });
}

export async function withRestartLock<A>(root: string, run: () => Promise<A>): Promise<A> {
  const lockPath = NodePath.join(root, "controller.lock");
  const lock = await NodeFSP.open(lockPath, "wx", 0o600);
  try {
    await lock.writeFile(String(process.pid));
    return await run();
  } finally {
    await lock.close();
    await NodeFSP.unlink(lockPath);
  }
}

function actionsFor(plan: RestartPlan): RestartActions {
  return {
    async quit() {
      for (const id of appIds) {
        if (await running(id))
          await exec("/usr/bin/osascript", ["-e", `tell application id "${id}" to quit`], {
            timeout: 70_000,
          });
      }
    },
    async waitStopped() {
      for (let attempt = 0; attempt < 90; attempt++) {
        const appsRunning = await Promise.all(appIds.map(running));
        if (!appsRunning.some(Boolean) && !(await portOpen(plan.origin))) return;
        await NodeTimersPromises.setTimeout(1_000);
      }
      throw new Error("The current app/server did not stop; its bundle was left in place.");
    },
    async open() {
      await exec("/usr/bin/open", ["-a", plan.app], { timeout: 30_000 });
    },
    async waitHealthy(version) {
      for (let attempt = 0; attempt < 90; attempt++) {
        const current = await health(plan.origin);
        if (current && matches(current, version, plan.environmentId)) return current;
        await NodeTimersPromises.setTimeout(1_000);
      }
      throw new Error(`Server ${version} did not become healthy with the original environment.`);
    },
  };
}

async function bundleValue(bundle: string, key: string): Promise<string> {
  return (
    await exec("/usr/libexec/PlistBuddy", [
      "-c",
      `Print :${key}`,
      NodePath.join(bundle, "Contents/Info.plist"),
    ])
  ).stdout.trim();
}

async function localOrigin(override: string | undefined): Promise<string> {
  let origin = override;
  if (!origin) {
    try {
      const runtime: { origin: string } = JSON.parse(
        await NodeFSP.readFile(
          NodePath.join(NodeOS.homedir(), ".t3/userdata/server-runtime.json"),
          "utf8",
        ),
      );
      origin = runtime.origin;
    } catch {}
  }
  const url = new URL(origin ?? "http://127.0.0.1:3773");
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error("--origin must name the local desktop server.");
  return url.origin;
}

async function main() {
  const { values } = NodeUtil.parseArgs({
    options: {
      help: { type: "boolean" },
      status: { type: "boolean" },
      "restart-only": { type: "boolean" },
      version: { type: "string" },
      origin: { type: "string" },
      worker: { type: "string" },
    },
  });
  if (values.help) {
    NodeConsole.log(
      "Usage: node scripts/restart-fork.ts [--restart-only] [--version <nightly-version>] [--origin <local-url>]\n       node scripts/restart-fork.ts --status\n\nDefault: rebuild, stage a backup, then restart once through an ephemeral launchd job.\n--restart-only reopens the installed fork without rebuilding.\n--status verifies the live version/environment and unloads a finished helper.\nBuild/restart logs and status live in this checkout's ignored .t3/restarts directory.",
    );
    return;
  }
  if (process.platform !== "darwin")
    throw new Error("This script restarts the installed macOS fork.");
  if (values.worker) {
    const plan: RestartPlan = JSON.parse(await NodeFSP.readFile(values.worker, "utf8"));
    await NodeTimersPromises.setTimeout(6_000);
    const result = await restartOnce(plan, actionsFor(plan));
    NodeConsole.log(
      JSON.stringify({ ...result, version: plan.version, backupApp: plan.backupApp }),
    );
    process.exitCode = result.phase === "succeeded" ? 0 : 1;
    return;
  }
  const repo = NodePath.resolve(import.meta.dirname, "..");
  const root = NodePath.join(repo, ".t3/restarts");
  const latest = NodePath.join(root, "latest.json");
  const origin = await localOrigin(values.origin);
  if (values.status) {
    const current = await health(origin);
    if (!(await exists(latest))) {
      const healthy =
        current?.serverVersion === (await bundleValue(app, "CFBundleShortVersionString"));
      NodeConsole.log(JSON.stringify({ current, healthy, lastRestart: null }, null, 2));
      process.exitCode = healthy ? 0 : 1;
      return;
    }
    const plan: RestartPlan = JSON.parse(await NodeFSP.readFile(latest, "utf8"));
    const result: RestartStatus = (await exists(plan.statusFile))
      ? JSON.parse(await NodeFSP.readFile(plan.statusFile, "utf8"))
      : { phase: "running" };
    if (result.phase !== "running")
      await exec("/bin/launchctl", ["bootout", `gui/${plan.uid}/${plan.jobLabel}`]).catch(
        () => undefined,
      );
    const healthy =
      current !== null &&
      matches(
        current,
        result.phase === "rolled-back" ? plan.previousVersion : plan.version,
        plan.environmentId,
      );
    NodeConsole.log(
      JSON.stringify(
        {
          ...result,
          current,
          expectedVersion: plan.version,
          healthy,
          log: NodePath.join(NodePath.dirname(plan.statusFile), "restart.log"),
        },
        null,
        2,
      ),
    );
    process.exitCode = healthy && result.phase === "succeeded" ? 0 : 1;
    return;
  }
  await NodeFSP.mkdir(root, { recursive: true });
  await withRestartLock(root, async () => {
    if (await exists(latest)) {
      const previous: RestartPlan = JSON.parse(await NodeFSP.readFile(latest, "utf8"));
      const result: RestartStatus = (await exists(previous.statusFile))
        ? JSON.parse(await NodeFSP.readFile(previous.statusFile, "utf8"))
        : { phase: "running" };
      if (result.phase === "running")
        throw new Error(
          "A restart is already running. Inspect --status and its log before starting another.",
        );
    }
    const dir = await NodeFSP.mkdtemp(NodePath.join(root, "run-"));
    const current = await health(origin);
    if ((await bundleValue(app, "CFBundleIdentifier")) !== "com.t3tools.t3code.fork")
      throw new Error("The installed app at the fork path has the wrong bundle identifier.");
    const previousVersion = await bundleValue(app, "CFBundleShortVersionString");
    const source: { version: string } = JSON.parse(
      await NodeFSP.readFile(NodePath.join(repo, "apps/server/package.json"), "utf8"),
    );
    const version = values["restart-only"]
      ? previousVersion
      : (values.version ??
        nextForkVersion(
          source.version,
          previousVersion,
          new Date().toISOString().slice(0, 10).replaceAll("-", ""),
        ));
    let stagedApp: string | null = null;
    let backupApp = NodePath.join(dir, "previous.app");
    if (!values["restart-only"]) {
      const log = await NodeFSP.open(NodePath.join(dir, "build.log"), "w");
      NodeConsole.log(`Building ${version}; log: ${NodePath.join(dir, "build.log")}`);
      try {
        await new Promise<void>((resolve, reject) => {
          const child = NodeChildProcess.spawn(
            process.execPath,
            [
              NodePath.join(repo, "scripts/build-desktop-artifact.ts"),
              "--platform",
              "mac",
              "--target",
              "dir",
              "--arch",
              process.arch,
              "--build-version",
              version,
              "--output-dir",
              NodePath.join(dir, "build"),
            ],
            {
              cwd: repo,
              env: {
                ...process.env,
                PATH: [
                  NodePath.dirname(process.execPath),
                  NodePath.join(repo, "node_modules/.bin"),
                  process.env.PATH ?? "",
                ].join(NodePath.delimiter),
              },
              stdio: ["ignore", log.fd, log.fd],
            },
          );
          child.once("error", reject);
          child.once("exit", (code) =>
            code === 0
              ? resolve()
              : reject(
                  new Error(`Build failed (${code}); see ${NodePath.join(dir, "build.log")}.`),
                ),
          );
        });
      } finally {
        await log.close();
      }
      const built = NodePath.join(
        dir,
        "build",
        process.arch === "arm64" ? "mac-arm64" : "mac",
        "T3 Code Fork (Nightly).app",
      );
      if (
        (await bundleValue(built, "CFBundleIdentifier")) !== "com.t3tools.t3code.fork" ||
        (await bundleValue(built, "CFBundleShortVersionString")) !== version
      )
        throw new Error("Build produced an unexpected app; the installed app was left unchanged.");
      const staging = await NodeFSP.mkdtemp("/Applications/.t3code-fork-restart-");
      stagedApp = NodePath.join(staging, "new.app");
      backupApp = NodePath.join(staging, "previous.app");
      await exec("/usr/bin/ditto", [built, stagedApp]);
    }
    const uid = process.getuid!();
    const jobLabel = `com.t3code.fork.restart.${NodeCrypto.randomUUID()}`;
    const plan: RestartPlan = {
      app,
      stagedApp,
      backupApp,
      version,
      previousVersion,
      environmentId:
        current?.environmentId ??
        (await NodeFSP.readFile(
          NodePath.join(NodeOS.homedir(), ".t3/userdata/environment-id"),
          "utf8",
        ).then(
          (value) => value.trim() || null,
          () => null,
        )),
      origin,
      jobLabel,
      uid,
      statusFile: NodePath.join(dir, "status.json"),
    };
    const config = NodePath.join(dir, "plan.json");
    const worker = NodePath.join(dir, "worker.ts");
    const plist = NodePath.join(dir, "job.plist");
    await NodeFSP.copyFile(NodeURL.fileURLToPath(import.meta.url), worker);
    await NodeFSP.writeFile(config, JSON.stringify(plan), { mode: 0o600 });
    await NodeFSP.writeFile(
      plist,
      launchdPlist(
        jobLabel,
        [process.execPath, worker, "--worker", config],
        NodePath.join(dir, "restart.log"),
      ),
      { mode: 0o600 },
    );
    await exec("/usr/bin/plutil", ["-lint", plist]);
    await exec("/bin/launchctl", ["bootstrap", `gui/${uid}`, plist]);
    await NodeFSP.writeFile(latest, JSON.stringify(plan), { mode: 0o600 });
    NodeConsole.log(
      `Restart scheduled once. This session may disconnect.\nVerify afterward: node ${NodePath.join(repo, "scripts/restart-fork.ts")} --status`,
    );
  });
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    NodeConsole.error(errorText(error));
    process.exitCode = 1;
  });
}
