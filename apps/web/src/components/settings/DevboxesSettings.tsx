import type { DevboxLoginPool, EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { DevboxLoginActions } from "../devbox/DevboxLoginActions";
import { devboxEnvironment, useDevboxes } from "../../state/devboxes";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const PROVIDER_LABELS = { claude: "Claude", codex: "Codex" } as const;
const BATCH_SIZES = [1, 5] as const;

export function DevboxesSettings() {
  const { hostEnvironmentId, available, pools, refresh } = useDevboxes();
  const busy = pools.some((pool) => pool.queued > 0 || pool.pendingUrl !== null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the host does not push sign-in progress; follow a batch while it runs.
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(refresh, 2_000);
    return () => clearInterval(timer);
  }, [busy, refresh]);
  const search = searchableSetting("devbox-sign-in-pool");

  return (
    <SettingsPageContainer>
      <SettingsSection id={search.id} title={search.title}>
        {!available || hostEnvironmentId === null ? (
          <SettingsRow
            title="Devboxes are not available"
            description="This machine needs the Coder CLI, signed in, to create devboxes."
          />
        ) : (
          <>
            <SettingsRow
              title="How it works"
              description="Each new devbox takes one Claude and one Codex sign-in from here, so it starts signed in. Add a few ahead of time. Each sign-in opens your browser for approval, one after another."
            />
            {pools.map((pool) => (
              <DevboxPoolRow
                key={pool.provider}
                pool={pool}
                hostEnvironmentId={hostEnvironmentId}
              />
            ))}
          </>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function DevboxPoolRow({
  pool,
  hostEnvironmentId,
}: {
  readonly pool: DevboxLoginPool;
  readonly hostEnvironmentId: EnvironmentId;
}) {
  const start = useAtomCommand(devboxEnvironment.startLogin, { reportFailure: false });
  const cancel = useAtomCommand(devboxEnvironment.cancelLogins, { reportFailure: false });
  const label = PROVIDER_LABELS[pool.provider];
  // `queued` counts the sign-in running now until it finishes.
  const running = pool.pendingUrl !== null || pool.queued > 0;

  const add = async (count: number) => {
    const result = await start({
      environmentId: hostEnvironmentId,
      input: { provider: pool.provider, count },
    });
    if (result._tag === "Failure")
      toastManager.add(
        stackedThreadToast({ type: "error", title: `Could not add ${label} sign-ins` }),
      );
  };

  const status = [
    `${pool.free} ready`,
    pool.inUse > 0 ? `${pool.inUse} in use` : null,
    running ? `signing in, ${pool.queued} to go` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <SettingsRow
      title={label}
      description={
        <>
          <span>{status}</span>
          {pool.lastError ? <span className="block text-destructive">{pool.lastError}</span> : null}
          {running && pool.pendingUrl === null ? (
            <span className="block">Starting the next sign-in…</span>
          ) : null}
        </>
      }
      control={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {pool.pendingUrl !== null ? (
            <DevboxLoginActions
              key={pool.pendingUrl}
              provider={pool.provider}
              url={pool.pendingUrl}
              hostEnvironmentId={hostEnvironmentId}
            />
          ) : null}
          {running ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                void cancel({
                  environmentId: hostEnvironmentId,
                  input: { provider: pool.provider },
                })
              }
            >
              Cancel
            </Button>
          ) : (
            BATCH_SIZES.map((count) => (
              <Button key={count} size="xs" variant="outline" onClick={() => void add(count)}>
                Add {count}
              </Button>
            ))
          )}
        </div>
      }
    />
  );
}
