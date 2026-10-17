import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { say } from "./helpers";

test("overview shows recent activity and filters failures", async ({ app, screen }) => {
  const thread = `act-${Date.now().toString(36)}`;
  await say(thread, "Ana", "mensaje para el feed de actividad");
  await app.open("/#overview");
  const feed = screen.getByRole("region", "Activity");
  const row = feed.getByRole("link", "mensaje para el feed de actividad");
  await expect(row).toBeVisible({ timeout: 15000 });
  await feed.getByText("Failures").tap();
  await expect(row).not.toBeVisible();
  await feed.getByText("All").tap();
  await row.tap();
  const field = screen.getByLabel("Your name");
  if (await field.isVisible()) {
    await field.fill("Ana");
    await screen.getByRole("button", "Continue").tap();
  }
  await expect(screen.getByText("mensaje para el feed de actividad").first()).toBeVisible();
});
