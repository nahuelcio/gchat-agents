import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { room } from "./helpers";

test("room roster shows presence and handles /invite and /kick", async ({ app, screen }) => {
  const thread = await room(["qa", "dev"]);
  await app.open(`/#team/${thread}`);
  const field = screen.getByLabel("Your name");
  if (await field.isVisible()) {
    await field.fill("Ana");
    await screen.getByRole("button", "Continue").tap();
  }
  const members = screen.getByRole("region", "Members");
  await expect(members.getByText("@qa")).toBeVisible();
  await expect(members.getByText(/^idle/).first()).toBeVisible();

  const say = async (text: string) => {
    await screen.getByRole("textbox", "Message the agent").fill(text);
    await screen.getByRole("button", "Send").tap();
  };
  await say("/invite nadie");
  await expect(screen.getByText(/no agent @nadie/)).toBeVisible({ timeout: 15000 });
  await say("/kick dev");
  await expect(screen.getByText("@dev left the room.")).toBeVisible({ timeout: 15000 });
  await expect(members.getByText("@dev", { exact: true })).not.toBeVisible();
  await say("/agents");
  await expect(screen.getByText(/@qa · idle/)).toBeVisible({ timeout: 15000 });
});
