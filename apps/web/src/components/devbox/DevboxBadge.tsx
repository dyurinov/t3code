import { Badge } from "../ui/badge";

/** Marks an environment as one of this machine's devboxes. */
export function DevboxBadge() {
  return (
    <Badge variant="info" size="sm" className="shrink-0">
      Devbox
    </Badge>
  );
}
