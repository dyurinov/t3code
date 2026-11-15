import type { DevboxUsageResult, UsageSummaryInput } from "@t3tools/contracts";
import { formatUsd } from "@t3tools/shared/usageFormat";

import { cn } from "../../lib/utils";
import { DevboxBadge } from "../devbox/DevboxBadge";
import { devboxEnvironment, useDevboxes } from "../../state/devboxes";
import { useEnvironmentQuery } from "../../state/query";

/** The window's bounds as instants; day windows run from local midnight to the day's end. */
export function devboxUsageInput(window: UsageSummaryInput) {
  return {
    since: window.sinceTime ?? new Date(`${window.sinceDay}T00:00:00`).toISOString(),
    until: window.untilTime ?? new Date(`${window.untilDay}T23:59:59.999`).toISOString(),
  };
}

function formatHours(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  return hours < 10 ? `${hours.toFixed(1)}h` : `${Math.round(hours)}h`;
}

export function DevboxUsage({
  window,
  refreshing,
}: {
  readonly window: UsageSummaryInput;
  readonly refreshing: boolean;
}) {
  const { hostEnvironmentId, available } = useDevboxes();
  const query = useEnvironmentQuery(
    hostEnvironmentId === null || !available
      ? null
      : devboxEnvironment.usage({
          environmentId: hostEnvironmentId,
          input: devboxUsageInput(window),
        }),
  );
  if (!available)
    return (
      <p className="text-sm text-muted-foreground">
        Devboxes need the Coder CLI, signed in, on this machine.
      </p>
    );
  if (query.error) return <p className="text-sm text-destructive">{query.error}</p>;
  const usage = query.data;
  if (!usage) return <p className="text-sm text-muted-foreground">Reading Coder build history…</p>;
  return <DevboxUsageView usage={usage} loading={refreshing || query.isPending} />;
}

function DevboxUsageView({
  usage,
  loading,
}: {
  readonly usage: DevboxUsageResult;
  readonly loading: boolean;
}) {
  const total = usage.boxes.reduce((sum, box) => sum + box.cost, 0);
  const awake = usage.boxes.reduce((sum, box) => sum + box.awakeHours, 0);
  const asleep = usage.boxes.reduce((sum, box) => sum + box.asleepHours, 0);
  const figures = cn("transition-opacity", loading && "opacity-40 delay-150");
  return (
    <div aria-busy={loading} className="flex flex-col gap-6">
      <section className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex flex-col gap-1">
            <p className={cn("text-4xl font-semibold text-foreground tabular-nums", figures)}>
              {formatUsd(total)}
            </p>
            <p className="text-xs text-muted-foreground">
              AWS list-price estimate · {formatUsd(usage.awakeRate)}/h awake ·{" "}
              {formatUsd(usage.asleepRate * 24)}/day asleep
            </p>
          </div>
          <dl className="grid grid-cols-3 gap-4">
            <UsageFigure label="Boxes" value={String(usage.boxes.length)} loading={loading} />
            <UsageFigure label="Awake" value={formatHours(awake)} loading={loading} />
            <UsageFigure label="Asleep" value={formatHours(asleep)} loading={loading} />
          </dl>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-right text-xs text-muted-foreground">
              <th className="w-full py-2 pl-2 text-left font-normal">Box</th>
              <th className="py-2 pl-6 font-normal">Awake</th>
              <th className="py-2 pl-6 font-normal">Asleep</th>
              <th className="py-2 pr-2 pl-6 font-normal">Cost</th>
            </tr>
          </thead>
          <tbody>
            {usage.boxes.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-6 text-center text-muted-foreground">
                  No devboxes in this window.
                </td>
              </tr>
            ) : (
              usage.boxes.map((box) => (
                <tr
                  key={box.name}
                  className={cn(
                    "border-b border-border/50 text-right whitespace-nowrap text-muted-foreground tabular-nums",
                    figures,
                  )}
                >
                  <td className="py-2.5 pl-2 text-left">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-foreground">{box.name}</span>
                      {box.managed ? <DevboxBadge /> : null}
                      {box.state === null ? (
                        <span className="text-xs text-muted-foreground">deleted</span>
                      ) : box.state === "running" ? (
                        <span className="text-xs text-success-foreground">running</span>
                      ) : null}
                    </span>
                  </td>
                  <td className="py-2.5 pl-6">{formatHours(box.awakeHours)}</td>
                  <td className="py-2.5 pl-6">{formatHours(box.asleepHours)}</td>
                  <td className="py-2.5 pr-2 pl-6 font-medium text-foreground">
                    {formatUsd(box.cost)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function UsageFigure({
  label,
  value,
  loading,
}: {
  readonly label: string;
  readonly value: string;
  readonly loading: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "text-base font-medium text-foreground tabular-nums transition-opacity",
          loading && "opacity-40 delay-150",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
