import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("navigates every control plane view", async ({ app, screen }) => {
  await app.open("/");
  for (const view of ["Team chat", "Schedules", "Settings", "Overview"]) {
    await screen.getByRole("link", view).tap();
    await expect(screen.getByRole("heading", view, { level: 1 })).toBeVisible();
  }
});

test("tunnel provider persists", async ({ app, screen }) => {
  await app.open("/#settings");
  await expect(screen.getByRole("heading", "Public tunnel")).toBeVisible();
  await screen.getByText("cloudflared").tap();
  await expect(screen.getByRole("radio", "cloudflared")).toBeChecked();
  await app.open("/#overview");
  await app.open("/#settings");
  await expect(screen.getByRole("radio", "cloudflared")).toBeChecked();
  await screen.getByText("Auto").tap();
});

test("team chat echoes a message", async ({ app, screen }) => {
  await app.open("/#team");
  const name = screen.getByLabel("Your name");
  if (await name.isVisible()) {
    await name.fill("E2E");
    await screen.getByRole("button", "Continue").tap();
  }
  await screen.getByRole("button", "New thread").tap();
  await screen.getByPlaceholder("Message @agent, paste an image, or use the mic").fill("hola e2e");
  await screen.getByRole("button", "Send").tap();
  await expect(screen.getByText(/^Echo: .*hola e2e$/)).toBeVisible({ timeout: 15000 });
});
