import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("a /command job waits for approval and deny keeps it from running", async ({ app, screen }) => {
  const command = `ship${Date.now().toString(36)}`;
  await app.open("/#schedules");
  await screen.getByRole("button", "New job").tap();
  await screen.getByLabel("What should the agent do?").fill(`deploy ${command}`);
  await screen.getByRole("button", "When someone writes /command").tap();
  await screen.getByLabel("Command, without the slash").fill(command);
  await screen.getByLabel("Ask for approval before each run").check();
  await screen.getByRole("button", "Create job").tap();
  await expect(screen.getByText(`/${command}`)).toBeVisible({ timeout: 10000 });

  await app.open(`/#team/wf-${command}`);
  const field = screen.getByLabel("Your name");
  if (await field.isVisible()) {
    await field.fill("Ana");
    await screen.getByRole("button", "Continue").tap();
  }
  await screen.getByRole("textbox", "Message the agent").fill(`/${command}`);
  await screen.getByRole("button", "Send").tap();
  await expect(screen.getByText(/needs approval: \/approve \w+ or \/deny \w+/)).toBeVisible({ timeout: 15000 });

  await app.open("/#overview");
  const banner = screen.getByRole("region", "Pending approval").filter({ hasText: `deploy ${command}` });
  await expect(banner).toBeVisible({ timeout: 10000 });
  await banner.getByRole("button", "Deny").tap();
  await expect(banner).not.toBeVisible();

  await app.open("/#schedules");
  await expect(screen.getByText("Denied").first()).toBeVisible({ timeout: 10000 });
});
