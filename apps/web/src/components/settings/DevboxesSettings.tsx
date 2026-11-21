import { T, useGT } from "gt-react";
import type { DevboxLogin, EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { DevboxLoginActions } from "../devbox/DevboxLoginActions";
import { devboxEnvironment, useDevboxes } from "../../state/devboxes";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const PROVIDER_LABELS = { claude: "Claude", codex: "Codex" } as const;

export function DevboxesSettings() {
  const gt = useGT();
  const { hostEnvironmentId, available, logins, refresh } = useDevboxes();
  const signingIn = logins.some((login) => login.signingIn);
  // A fresh Claude sign-in seals on its first renewal; an error may clear on the next one.
  const settling = logins.some(
    (login) => (login.signedIn && !login.sealed && login.provider === "claude") || login.lastError,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the host does not push sign-in or renewal progress; follow it while something is pending.
  useEffect(() => {
    if (!signingIn && !settling) return;
    const timer = setInterval(refresh, signingIn ? 2_000 : 10_000);
    return () => clearInterval(timer);
  }, [signingIn, settling, refresh]);
  const searchableSetting = useSearchableSetting();
  const search = searchableSetting("devbox-sign-ins");

  return (
    <SettingsPageContainer>
      <SettingsSection id={search.id} title={search.title}>
        {!available || hostEnvironmentId === null ? (
          <SettingsRow
            title={gt("Devboxes are not available")}
            description={gt("This machine needs the Coder CLI, signed in, to create devboxes.")}
          />
        ) : (
          <>
            <SettingsRow
              title={gt("How it works")}
              description={gt(
                "Sign in once per provider. The sign-in stays on this machine and renews through a running devbox; every devbox gets a short-lived token from it. Claude needs Formal on the devbox.",
              )}
            />
            {logins.map((login) => (
              <DevboxLoginRow
                key={login.provider}
                login={login}
                hostEnvironmentId={hostEnvironmentId}
              />
            ))}
          </>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function DevboxLoginRow({
  login,
  hostEnvironmentId,
}: {
  readonly login: DevboxLogin;
  readonly hostEnvironmentId: EnvironmentId;
}) {
  const gt = useGT();
  const start = useAtomCommand(devboxEnvironment.startLogin, { reportFailure: false });
  const cancel = useAtomCommand(devboxEnvironment.cancelLogin, { reportFailure: false });
  const signOut = useAtomCommand(devboxEnvironment.signOut, { reportFailure: false });
  const label = PROVIDER_LABELS[login.provider];
  const target = { environmentId: hostEnvironmentId, input: { provider: login.provider } };

  const signIn = async () => {
    const result = await start(target);
    if (result._tag === "Failure")
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not start the {label} sign-in", { label }),
        }),
      );
  };

  const status = !login.signedIn
    ? gt("Not signed in. New devboxes start without {label}.", { label })
    : [
        login.account,
        login.expiresAt === null
          ? null
          : gt("current token valid until {time}", {
              time: new Date(login.expiresAt).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              }),
            }),
        login.sealed ? gt("sealed by Formal") : null,
      ]
        .filter(Boolean)
        .join(" · ");

  return (
    <SettingsRow
      title={label}
      description={
        <>
          <span>{status}</span>
          {login.lastError ? (
            <span className="block text-destructive">{login.lastError}</span>
          ) : null}
          {login.signingIn && login.pendingUrl === null ? (
            <span className="block">
              <T>Starting the sign-in…</T>
            </span>
          ) : null}
        </>
      }
      control={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {login.pendingUrl !== null ? (
            <DevboxLoginActions
              key={login.pendingUrl}
              provider={login.provider}
              url={login.pendingUrl}
              hostEnvironmentId={hostEnvironmentId}
            />
          ) : null}
          {login.signingIn ? (
            <Button size="xs" variant="ghost" onClick={() => void cancel(target)}>
              <T>Cancel</T>
            </Button>
          ) : (
            <>
              <Button size="xs" variant="outline" onClick={() => void signIn()}>
                {login.signedIn ? <T>Sign in again</T> : <T>Sign in</T>}
              </Button>
              {login.signedIn ? (
                <Button size="xs" variant="ghost" onClick={() => void signOut(target)}>
                  <T>Sign out</T>
                </Button>
              ) : null}
            </>
          )}
        </div>
      }
    />
  );
}
