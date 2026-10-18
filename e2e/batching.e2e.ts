import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { call, say } from "./helpers";

test("messages sent in a burst reach the agent as one turn", async ({ app, screen }) => {
  await app.open("/#settings/chat");
  const card = screen.getByRole("group", "Message batching");
  await card.getByText("2 s", { exact: true }).tap();
  await expect(card.getByText(/within 2 s of each other/)).toBeVisible({ timeout: 10000 });

  const thread = `batch-${Date.now().toString(36)}`;
  await say(thread, "Ana", "hola");
  await say(thread, "Ana", "tengo un problema");
  await say(thread, "Ana", "con el webhook");

  await app.open(`/#team/${thread}`);
  const field = screen.getByLabel("Your name");
  if (await field.isVisible()) {
    await field.fill("Ana");
    await screen.getByRole("button", "Continue").tap();
  }
  const chat = screen.getByRole("region", "Conversation");
  await expect(chat.getByText(/^Echo: Ana: hola\s+tengo un problema\s+con el webhook$/)).toBeVisible({ timeout: 15000 });
  await expect(chat.getByTestId("message-author").filter({ hasText: "Switchi" })).toHaveCount(1);
  await call("PUT", "/api/settings", { debounceMs: 0 });
});
