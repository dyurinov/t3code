import { createFileRoute } from "@tanstack/react-router";

import { DevboxesSettings } from "../components/settings/DevboxesSettings";

export const Route = createFileRoute("/_chat/settings/devboxes")({
  component: DevboxesSettings,
});
