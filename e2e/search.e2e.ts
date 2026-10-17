import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { say } from "./helpers";

test("search finds a phrase and opens its thread", async ({ app, screen }) => {
  const stamp = Date.now().toString(36);
  await say(`buscar-a-${stamp}`, "Ana", `el token de Meta vence hoy ${stamp}`);
  await say(`buscar-b-${stamp}`, "Beto", "hablemos del webhook");
  await app.open(`/#team/buscar-b-${stamp}`);
  const field = screen.getByLabel("Your name");
  if (await field.isVisible()) {
    await field.fill("Ana");
    await screen.getByRole("button", "Continue").tap();
  }
  await expect(screen.getByText("hablemos del webhook").first()).toBeVisible();
  await screen.getByRole("searchbox", "Search messages").fill(`token de meta vence hoy ${stamp}`);
  const results = screen.getByRole("list", "Search results");
  await expect(results.getByRole("button")).toHaveCount(2, { timeout: 10000 });
  await results.getByRole("button").first().tap();
  await expect(screen.getByText(`el token de Meta vence hoy ${stamp}`).first()).toBeVisible();
  await expect(screen.getByRole("region", "Conversation").getByText("hablemos del webhook")).not.toBeVisible();
});
