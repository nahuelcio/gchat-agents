import { test } from "@e2e-dev/web";
import { expect } from "e2e";

if (process.env.E2E_DRIVER === "pi") {
  test("team chat answers through the durable Pi harness", { timeout: 120000 }, async ({ app, screen }) => {
    await app.open(`/#team/pi-${Date.now().toString(36)}`);
    const field = screen.getByLabel("Your name");
    if (await field.isVisible()) {
      await field.fill("Ana");
      await screen.getByRole("button", "Continue").tap();
    }
    await screen.getByRole("textbox", "Message the agent").fill("hola pi");
    await screen.getByRole("button", "Send").tap();
    await expect(screen.getByText(/^Echo: .*hola pi$/).first()).toBeVisible({ timeout: 60000 });
    await app.open("/#settings");
    await expect(screen.getByText("Pi (durable)").first()).toBeVisible();
    await expect(screen.getByText(/harness running/)).toBeVisible({ timeout: 10000 });
  });

  test("provider keys are set from Settings and never shown back", { timeout: 60000 }, async ({ app, screen }) => {
    await app.open("/#settings");
    await expect(screen.getByText(/harness running/)).toBeVisible({ timeout: 10000 });
    const keys = screen.getByRole("group", "Provider keys");
    await expect(keys).toBeVisible();
    await keys.getByLabel("Provider").selectOption("DeepSeek");
    await keys.getByLabel("API key").fill("sk-e2e-not-real");
    await keys.getByRole("button", "Save key").tap();
    await expect(keys.getByText("Saved here.")).toBeVisible({ timeout: 10000 });
    await expect(screen.getByText("sk-e2e-not-real")).not.toBeVisible();
    await keys.getByRole("button", "Remove").tap();
    await expect(keys.getByText("Not configured yet.")).toBeVisible({ timeout: 10000 });
  });
}
