import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { EnvironmentId } from "@t3tools/contracts";
import { AnchoredToastProvider, ToastProvider, toastManager } from "./toast";

describe("toastManager", () => {
  it("shows a toast added before any provider mounted", async () => {
    toastManager.add({
      type: "warning",
      title: "Raised before the first render",
      data: { environmentId: EnvironmentId.make("frozen-host") },
    });
    expect(
      JSON.parse(sessionStorage.getItem("t3code:pending-client-issues") ?? "[]"),
    ).toContainEqual(
      expect.objectContaining({
        title: "Raised before the first render",
        environmentId: "frozen-host",
      }),
    );

    await using _screen = await render(<ToastProvider>{null}</ToastProvider>);

    await expect.element(page.getByText("Raised before the first render")).toBeVisible();
  });

  it("logs a toast updated in place once, until its title changes", () => {
    const logged = (title: string) =>
      JSON.parse(sessionStorage.getItem("t3code:pending-client-issues") ?? "[]").filter(
        (issue: { title: string }) => issue.title === title,
      ).length;
    const id = toastManager.add({ type: "warning", title: "Slow", description: "1 request" });
    toastManager.update(id, { type: "warning", title: "Slow", description: "2 requests" });
    toastManager.update(id, { type: "warning", title: "Slow", description: "1 request" });
    expect(logged("Slow")).toBe(1);
    toastManager.update(id, { type: "error", title: "Failed" });
    expect(logged("Failed")).toBe(1);
    toastManager.close(id);
    toastManager.add({ type: "warning", title: "Slow" });
    expect(logged("Slow")).toBe(2);
  });

  it("exposes one Notifications landmark when both toast providers mount", async () => {
    await using _screen = await render(
      <ToastProvider>
        <AnchoredToastProvider>{null}</AnchoredToastProvider>
      </ToastProvider>,
    );

    const notifications = page.getByRole("region", { name: "Notifications" });
    await expect.element(notifications.first()).toBeInTheDocument();
    expect(
      notifications.elements(),
      "only the corner toast viewport should be a Notifications landmark",
    ).toHaveLength(1);
    await expect.element(notifications).toHaveAttribute("data-slot", "toast-viewport");

    const anchoredViewport = document.querySelector("[data-slot=toast-viewport-anchored]");
    expect(anchoredViewport).toHaveAttribute("aria-live", "polite");
  });
});
