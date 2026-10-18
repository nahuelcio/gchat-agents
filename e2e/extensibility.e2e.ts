import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { call, ensureCatalog } from "./helpers";

test("skills, MCP servers and delegation are set up from Settings", async ({ app, screen }) => {
  await ensureCatalog();
  const stamp = Date.now().toString(36);
  await app.open("/#settings/tools");

  const skills = screen.getByRole("group", "Skills");
  await skills.getByRole("button", "+ New skill").tap();
  const skillForm = screen.getByRole("form", "Skill");
  await skillForm.getByLabel("Name").fill(`ventas-${stamp}`);
  await skillForm.getByLabel("Description").fill("Precios y planes");
  await skillForm.getByLabel("Instructions").fill("Respondé siempre con el precio en USD.");
  await skillForm.getByRole("button", "Save skill").tap();
  await expect(skills.getByText(`ventas-${stamp}`)).toBeVisible({ timeout: 10000 });

  const servers = screen.getByRole("group", "MCP servers");
  await servers.getByRole("button", "+ Add MCP server").tap();
  const serverForm = screen.getByRole("form", "MCP server");
  await serverForm.getByLabel("Name").fill(`fake${stamp}`);
  await serverForm.getByLabel("Command").fill("node");
  await serverForm.getByLabel("Arguments").fill("e2e/fixtures/fake-mcp.mjs");
  await serverForm.getByRole("button", "Add server").tap();
  await expect(servers.getByText(`fake${stamp}`, { exact: true })).toBeVisible({ timeout: 10000 });

  await screen.getByRole("tab", "Agents").tap();
  await screen.getByRole("button", "+ Add agent").tap();
  const agent = screen.getByRole("form", "Agent in chat");
  await agent.getByLabel("Name").fill(`soporte${stamp}`);
  await agent.getByLabel("Role and knowledge").fill("Soporte tecnico.");
  await expect(agent.getByText(new RegExp(`^fake${stamp} — your MCP server`))).toBeVisible();
  await agent.getByText(/^Ask other agents/).tap();
  await expect(agent.getByText("Can ask")).toBeVisible();
  await agent.getByText("@qa", { exact: true }).tap();
  await agent.getByRole("button", "Save").tap();

  const settings = (await call("GET", "/api/settings")).json;
  const persona = settings.personas.find((p: { name: string }) => p.name === `soporte${stamp}`);
  expect(persona.mcps).toEqual(["agents"]);
  expect(persona.delegates).toEqual(["qa"]);
  expect(settings.mcpServers.some((m: { name: string }) => m.name === `fake${stamp}`)).toBe(true);
  await call("PUT", "/api/settings", { mcpServers: [] });
  await call("DELETE", `/api/skills?name=ventas-${stamp}`);
  await ensureCatalog();
});
