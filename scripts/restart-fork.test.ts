// @effect-diagnostics nodeBuiltinImport:off - Tests use isolated app bundles and the restart script's filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import Plist from "plist";
import { expect, it } from "vite-plus/test";

import {
  launchdPlist,
  nextForkVersion,
  restartOnce,
  withRestartLock,
  type RestartPlan,
} from "./restart-fork.ts";

async function fixture(failNewApp = false) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3 fork restart "));
  const plan: RestartPlan = {
    app: NodePath.join(root, "T3 Code Fork.app"),
    stagedApp: NodePath.join(root, "new.app"),
    backupApp: NodePath.join(root, "previous.app"),
    statusFile: NodePath.join(root, "status.json"),
    version: "0.1.10-nightly.20261116.11494",
    previousVersion: "0.1.10-nightly.20261116.11493",
    environmentId: "original-environment",
    origin: "http://127.0.0.1:3773",
    jobLabel: "com.t3code.fork.restart.test",
    uid: 501,
  };
  for (const [app, version] of [
    [plan.app, plan.previousVersion],
    [plan.stagedApp!, plan.version],
  ]) {
    await NodeFSP.mkdir(app!, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(app!, "version"), version!);
  }
  let running = plan.previousVersion;
  let stops = 0;
  const actions = {
    quit: async () => {
      stops++;
      running = "";
    },
    waitStopped: async () => {
      expect(running).toBe("");
    },
    open: async () => {
      running = await NodeFSP.readFile(NodePath.join(plan.app, "version"), "utf8");
    },
    waitHealthy: async () => ({
      serverVersion: running,
      environmentId:
        failNewApp && running === plan.version ? "wrong-environment" : plan.environmentId!,
    }),
  };
  return {
    root,
    plan,
    actions,
    running: () => running,
    stops: () => stops,
    async [Symbol.asyncDispose]() {
      await NodeFSP.rm(root, { recursive: true, force: true });
    },
  };
}

it("restarts exactly once even when the same helper is invoked again", async () => {
  await using f = await fixture();
  const result = await restartOnce(f.plan, f.actions);
  expect(result.phase).toBe("succeeded");
  expect(f.running()).toBe(f.plan.version);
  expect(await NodeFSP.readFile(NodePath.join(f.plan.backupApp, "version"), "utf8")).toBe(
    f.plan.previousVersion,
  );
  expect(await restartOnce(f.plan, f.actions)).toEqual(result);
  expect(f.stops()).toBe(1);
});

it("restores and reopens the previous app when the new server has the wrong identity", async () => {
  await using f = await fixture(true);
  const result = await restartOnce(f.plan, f.actions);
  expect(result.phase).toBe("rolled-back");
  expect(f.running()).toBe(f.plan.previousVersion);
  expect(await NodeFSP.readFile(NodePath.join(f.plan.app, "version"), "utf8")).toBe(
    f.plan.previousVersion,
  );
  await restartOnce(f.plan, f.actions);
  expect(f.stops()).toBe(2);
});

it("leaves the installed app intact when it cannot stop the current server", async () => {
  await using f = await fixture();
  const result = await restartOnce(f.plan, {
    ...f.actions,
    waitStopped: async () => {
      throw new Error("Server still running");
    },
  });
  expect(result.phase).toBe("failed");
  expect(await NodeFSP.readFile(NodePath.join(f.plan.app, "version"), "utf8")).toBe(
    f.plan.previousVersion,
  );
  expect(await NodeFSP.readFile(NodePath.join(f.plan.stagedApp!, "version"), "utf8")).toBe(
    f.plan.version,
  );
});

it("installs an ephemeral launchd job without automatic relaunch, preserving arguments", () => {
  const args = ["/Node & tools/node", "/a folder/worker.ts", "--worker", "/a folder/plan.json"];
  const job = Plist.parse(launchdPlist("com.t3code.test", args, "/logs/restart.log"));
  expect(job).toMatchObject({ KeepAlive: false, RunAtLoad: true, ProgramArguments: args });
});

it("rejects a second controller and releases its lock after failure", async () => {
  await using f = await fixture();
  await expect(
    withRestartLock(f.root, async () => {
      await expect(withRestartLock(f.root, async () => undefined)).rejects.toMatchObject({
        code: "EEXIST",
      });
      throw new Error("Build failed");
    }),
  ).rejects.toThrow("Build failed");
  expect(await withRestartLock(f.root, async () => "available")).toBe("available");
});

it.each([
  [
    "0.1.10-nightly.20261115.11474",
    "0.1.10-nightly.20261116.11493",
    "0.1.10-nightly.20261116.11494",
  ],
  ["0.1.10-nightly.20261115.11474", "0.1.10-nightly.20261115.11493", "0.1.10-nightly.20261116.1"],
])("chooses a distinct nightly version from %s and %s", (source, installed, expected) => {
  expect(nextForkVersion(source, installed, "20261116")).toBe(expected);
});
