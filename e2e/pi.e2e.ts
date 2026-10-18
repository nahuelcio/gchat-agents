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

  test("openai-compatible custom providers are saved without echoing the key", { timeout: 60000 }, async ({ app, screen }) => {
    await app.open("/#settings");
    await expect(screen.getByText(/harness running/)).toBeVisible({ timeout: 10000 });
    const group = screen.getByRole("group", "OpenAI-compatible providers");
    await expect(group).toBeVisible();
    await group.getByRole("button", "+ Add OpenAI-compatible endpoint").tap();
    const form = group.getByLabel("OpenAI-compatible provider");
    await form.getByLabel("Provider id").fill("e2e-local");
    await form.getByLabel("Provider name").fill("E2E Local");
    await form.getByLabel("Base URL").fill("http://127.0.0.1:11434/v1");
    await form.getByLabel("Models").fill("echo-model");
    await form.getByLabel("Custom API key").fill("sk-custom-e2e");
    await form.getByRole("button", "Add endpoint").tap();
    await expect(group.getByText("E2E Local")).toBeVisible({ timeout: 10000 });
    await expect(group.getByText(/e2e-local/)).toBeVisible();
    await expect(screen.getByText("sk-custom-e2e")).not.toBeVisible();
    await group.getByLabel("Remove e2e-local").tap();
    await expect(group.getByText("E2E Local")).not.toBeVisible({ timeout: 10000 });
  });
}
