import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { BRIDGE_PORT } from "./helpers";

test("a guest chats through the share link on the public port", async ({ app, screen }) => {
  const token = readFileSync(join(process.env.E2E_DATA_DIR!, "share-token"), "utf8").trim();
  const thread = `guest-${Date.now().toString(36)}`;
  await app.open(`http://127.0.0.1:${BRIDGE_PORT}/play#${token}&thread=${thread}`);
  const field = screen.getByLabel("Your name");
  if (await field.isVisible()) {
    await field.fill("Invitada");
    await screen.getByRole("button", "Continue").tap();
  }
  const say = async (text: string) => {
    await screen.getByRole("textbox", "Message the agent").fill(text);
    await screen.getByRole("button", "Send").tap();
  };
  await say("hola desde el link");
  await expect(screen.getByText(/Echo: .*hola desde el link/).first()).toBeVisible({ timeout: 15000 });
  await say("/repo api");
  await expect(screen.getByText(/not available on the shared link/)).toBeVisible({ timeout: 10000 });
});

test("a wrong share token is rejected", async ({ app, screen }) => {
  await app.open(`http://127.0.0.1:${BRIDGE_PORT}/play#token-falso&thread=x`);
  const field = screen.getByLabel("Your name");
  if (await field.isVisible()) {
    await field.fill("Intrusa");
    await screen.getByRole("button", "Continue").tap();
  }
  await expect(screen.getByText(/invalid or expired share link/).first()).toBeVisible({ timeout: 10000 });
});
