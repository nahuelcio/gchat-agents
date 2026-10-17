import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("an image attached in team chat is shown and reaches the agent", async ({ app, screen, browser }) => {
  await app.open(`/#team/img-${Date.now().toString(36)}`);
  const field = screen.getByLabel("Your name");
  if (await field.isVisible()) {
    await field.fill("Ana");
    await screen.getByRole("button", "Continue").tap();
  }
  await browser.locator('input[type="file"]').setInputFiles("e2e/fixtures/pixel.png");
  await screen.getByRole("textbox", "Message the agent").fill("mirá esta captura");
  await screen.getByRole("button", "Send").tap();
  const chat = screen.getByRole("region", "Conversation");
  await expect(chat.getByText("mirá esta captura").first()).toBeVisible({ timeout: 10000 });
  await expect(chat.getByText(/\[Attached image\/png "pixel\.png"/)).toBeVisible({ timeout: 15000 });
  await expect(browser.locator('.messages img[src*="/api/media/"]').first()).toBeVisible();
});
