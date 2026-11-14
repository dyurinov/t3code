import type { DevboxPendingLogin, EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { readLocalApi } from "../../localApi";
import { devboxEnvironment } from "../../state/devboxes";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * Approve opens the provider's sign-in page. Claude's page then shows a code, which goes
 * back to the waiting sign-in from here; Codex finishes in the browser by itself.
 */
export function DevboxLoginActions({
  login,
  hostEnvironmentId,
}: {
  readonly login: DevboxPendingLogin;
  readonly hostEnvironmentId: EnvironmentId;
}) {
  const submit = useAtomCommand(devboxEnvironment.submitLoginCode, { reportFailure: false });
  const [opened, setOpened] = useState(false);
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);

  if (!opened || login.provider === "codex") {
    return (
      <Button
        size="xs"
        onClick={() => {
          setOpened(true);
          void readLocalApi()?.shell.openExternal(login.url);
        }}
      >
        Approve
      </Button>
    );
  }
  const send = async () => {
    setSending(true);
    const result = await submit({
      environmentId: hostEnvironmentId,
      input: { provider: login.provider, code },
    });
    setSending(false);
    if (result._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({ type: "error", title: "The sign-in did not take that code" }),
      );
    }
  };
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (code.trim().length > 0) void send();
      }}
    >
      <Input
        id={`devbox-login-code-${login.provider}`}
        size="sm"
        className="w-56"
        placeholder="Paste the code from the page"
        value={code}
        onChange={(event) => setCode(event.target.value)}
        autoFocus
      />
      <Button size="xs" type="submit" disabled={sending || code.trim().length === 0}>
        Sign in
      </Button>
    </form>
  );
}
