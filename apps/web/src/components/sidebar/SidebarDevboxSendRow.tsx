import { CircleDashedIcon } from "lucide-react";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { DraftId } from "../../composerDraftStore";
import type { DevboxSendWait } from "../../state/devboxes";
import { resolveSidebarRowAccessibility } from "../Sidebar.logic";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";

/**
 * A message sent from a draft whose devbox is still being prepared or woken. Its thread exists
 * only once the box answers, so until then it is listed as working from here.
 */
export const SidebarDevboxSendRow = memo(function SidebarDevboxSendRow(props: {
  wait: DevboxSendWait & { readonly draftId: string };
  project: ProjectFaviconProject | null;
  projectDisplayName: string | null;
  isActive: boolean;
  onNavigate: (draftId: DraftId) => void;
}) {
  const { wait, onNavigate } = props;
  const accessibility = resolveSidebarRowAccessibility({
    title: wait.title,
    statusLabel: wait.label,
    projectDisplayName: props.projectDisplayName,
    isActive: props.isActive,
  });
  const navigate = () => onNavigate(DraftId.make(wait.draftId));
  return (
    <li className="list-none py-0.5">
      <div
        role="button"
        tabIndex={0}
        aria-label={accessibility.label}
        aria-current={accessibility.current}
        data-testid="sidebar-devbox-send-row"
        className={cn(
          "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left text-sidebar-foreground outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.isActive
            ? "bg-sidebar-row-active light:ring-1 light:ring-inset light:ring-sidebar-border/70"
            : "bg-transparent hover:bg-sidebar-row-hover",
        )}
        onClick={navigate}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            navigate();
          }
        }}
      >
        <div className="relative z-10 h-[4.875rem] px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)">
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            {props.project ? (
              <ProjectFavicon project={props.project} className="size-4 shrink-0" />
            ) : null}
            <span className="min-w-0 flex-1 truncate text-xs font-normal text-secondary-label">
              {props.projectDisplayName}
            </span>
            <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs font-medium text-info-foreground">
              <CircleDashedIcon aria-hidden className="size-4 shrink-0" />
              Setting up
            </span>
          </div>
          <div className="mt-0.5 truncate text-sm font-medium text-foreground/90">{wait.title}</div>
          <div className="truncate text-xs text-muted-foreground">{wait.label}</div>
        </div>
      </div>
    </li>
  );
});
