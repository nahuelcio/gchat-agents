import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { call } from "./helpers";

function gitRepo(root: string, name: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
  git("init", "-q");
  writeFileSync(join(dir, "README.md"), name);
  git("add", ".");
  git("commit", "-qm", "init");
  return dir;
}

async function gone(path: string) {
  for (let i = 0; i < 50 && existsSync(path); i++) await new Promise((r) => setTimeout(r, 100));
  return !existsSync(path);
}

test("a thread works across several repos at once", async ({ app, screen }) => {
  const root = mkdtempSync(join(tmpdir(), "switchboard-repos-"));
  const names = ["api", "web", "worker"];
  const repos = Object.fromEntries(names.map((n) => [n, { path: gitRepo(root, n) }]));
  expect((await call("PUT", "/api/settings", { repos })).status).toBe(200);

  await app.open("/#team");
  const field = screen.getByLabel("Your name");
  if (await field.isVisible()) {
    await field.fill("Ana");
    await screen.getByRole("button", "Continue").tap();
  }
  await screen.getByRole("button", "New thread").tap();
  await screen.getByText("api").tap();
  await screen.getByText("worker").tap();
  await screen.getByRole("button", "Start in 2 repos").tap();
  await expect(screen.getByText(/Worktrees ready in .*: api, worker/)).toBeVisible({ timeout: 30000 });
  const head = screen.getByRole("region", "Conversation");
  await expect(head.getByText(/^switchboard\/\w+ · api, worker$/)).toBeVisible({ timeout: 10000 });
  await screen.getByRole("textbox", "Message the agent").fill("/topic Login SAML");
  await screen.getByRole("button", "Send").tap();
  await expect(head.getByText("Login SAML", { exact: true })).toBeVisible({ timeout: 10000 });
  await app.open("/#overview");
  await screen.getByRole("link", "Login SAML").tap();
  await expect(head.getByText("Login SAML", { exact: true })).toBeVisible({ timeout: 10000 });

  await screen.getByRole("textbox", "Message the agent").fill("/repo web");
  await screen.getByRole("button", "Send").tap();
  await expect(screen.getByText(/Worktrees ready in .*: api, worker, web/)).toBeVisible({ timeout: 30000 });

  await screen.getByRole("textbox", "Message the agent").fill("/status");
  await screen.getByRole("button", "Send").tap();
  const status = screen.getByText(/^Repos: api, worker, web/);
  await expect(status).toBeVisible({ timeout: 15000 });
  const folder = (await status.textContent())!.match(/Folder: (.+?)\s*App:/)![1].trim();
  for (const n of names) expect(existsSync(join(folder, n, "README.md"))).toBe(true);

  await screen.getByRole("textbox", "Message the agent").fill("/close worker");
  await screen.getByRole("button", "Send").tap();
  await expect(screen.getByText("Worktree for worker removed. The branch stays in the repo.")).toBeVisible({ timeout: 15000 });
  expect(await gone(join(folder, "worker"))).toBe(true);

  await screen.getByRole("textbox", "Message the agent").fill("/close");
  await screen.getByRole("button", "Send").tap();
  await expect(screen.getByText("Worktrees removed. Branches stay in their repos.")).toBeVisible({ timeout: 15000 });
  expect(await gone(folder)).toBe(true);
});
