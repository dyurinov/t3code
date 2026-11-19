import { msg, T, useGT, useMessages } from "gt-react";
import type { MessageResolver } from "../../i18n/messages";
import { useAtomValue } from "@effect/atom-react";
import type { DevboxSummary } from "@t3tools/contracts";

import { environmentCatalog } from "../../connection/catalog";
import { devboxStatusLabel, useDevboxes } from "../../state/devboxes";
import { EnvironmentRow } from "../settings/EnvironmentRow";
import { SettingsSection } from "../settings/settingsLayout";
import { Badge } from "../ui/badge";
import { DevboxBadge } from "./DevboxBadge";
import { DevboxWakeButton } from "./DevboxWakeButton";

/**
 * Claimed devboxes this device has no saved environment for yet. They are the user's own
 * machines, so they list under Environments; this device connects once one runs.
 */
export function useUnpairedDevboxes(): ReadonlyArray<DevboxSummary> {
  const { devboxes } = useDevboxes();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  return devboxes.filter(
    (devbox) =>
      !devbox.spare &&
      devbox.state !== "missing" &&
      (devbox.environmentId === null || !catalog.entries.has(devbox.environmentId)),
  );
}

export function UnpairedDevboxRows({
  devboxes,
}: {
  readonly devboxes: ReadonlyArray<DevboxSummary>;
}) {
  const m = useMessages();
  return devboxes.map((devbox) => (
    <EnvironmentRow
      key={devbox.name}
      kind="cloud"
      label={devbox.name}
      badge={<DevboxBadge />}
      subtitle={devboxStatusLabel(devbox, m) ?? m(msg("Connecting to this device…"))}
    >
      <DevboxWakeButton devbox={devbox} />
    </EnvironmentRow>
  ));
}

function spareStatus(devbox: DevboxSummary, resolve: MessageResolver): string {
  switch (devbox.state) {
    case "running":
      return resolve(msg("Ready. New devbox takes it next."));
    case "stopped":
      return resolve(msg("Asleep. New devbox wakes it, which takes about 90 seconds."));
    case "creating":
    case "starting":
      return resolve(msg("Being set up…"));
    case "failed":
      return devbox.lastError ?? resolve(msg("Setup failed. A new spare replaces it."));
    default:
      return devboxStatusLabel({ ...devbox, spare: false }, resolve) ?? "";
  }
}

/** Boxes prepared ahead of time so New devbox does not wait for one to be created. */
export function SpareDevboxesSection() {
  const gt = useGT();
  const m = useMessages();
  const { devboxes } = useDevboxes();
  const spares = devboxes.filter((devbox) => devbox.spare);
  if (spares.length === 0) return null;
  return (
    <SettingsSection title={gt("Spare devboxes")}>
      {spares.map((devbox) => (
        <EnvironmentRow
          key={devbox.name}
          kind="cloud"
          label={devbox.name}
          badge={
            <Badge variant="secondary" size="sm">
              <T>Spare</T>
            </Badge>
          }
          subtitle={spareStatus(devbox, m)}
        />
      ))}
    </SettingsSection>
  );
}
