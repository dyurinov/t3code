import { T, useGT } from "gt-react";
import type { DevboxLoginProvider, EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { readLocalApi } from "../../localApi";
import { devboxEnvironment } from "../../state/devboxes";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * Claude's page returns a code; Codex finishes in the browser. Key by `url` so a new
 * sign-in starts fresh.
 */
export function DevboxLoginActions({
  provider,
  url,
  hostEnvironmentId,
}: {
  readonly provider: DevboxLoginProvider;
  readonly url: string;
  readonly hostEnvironmentId: EnvironmentId;
}) {
  const gt = useGT();
  const submit = useAtomCommand(devboxEnvironment.submitLoginCode, { reportFailure: false });
  const [opened, setOpened] = useState(false);
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);

  const openSignIn = () => {
    setOpened(true);
    void readLocalApi()?.shell.openExternal(url);
  };

  if (!opened || provider === "codex") {
    return (
      <Button size="xs" onClick={openSignIn}>
        {opened ? gt("Open again") : gt("Continue sign-in")}
      </Button>
    );
  }
  const send = async () => {
    setSending(true);
    const result = await submit({ environmentId: hostEnvironmentId, input: { provider, code } });
    setSending(false);
    if (result._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({ type: "error", title: gt("The sign-in did not take that code") }),
      );
      return;
    }
    setCode("");
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
        id={`devbox-login-code-${provider}`}
        size="sm"
        className="w-56"
        placeholder={gt("Paste the code from the page")}
        value={code}
        onChange={(event) => setCode(event.target.value)}
        autoFocus
      />
      <Button size="xs" type="submit" disabled={sending || code.trim().length === 0}>
        <T>Sign in</T>
      </Button>
    </form>
  );
}
