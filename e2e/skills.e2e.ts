import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { call, ensureCatalog } from "./helpers";

test("a Finance agent gets the finanzas skill and the Drive folder is saved", async ({ app, screen }) => {
  await ensureCatalog();
  await app.open("/#settings");
  await screen.getByRole("button", "+ Add agent").tap();
  await screen.getByLabel("Name").fill("finanzas-e2e");
  await screen.getByLabel("Role and knowledge").fill("Sos el agente de Finanzas.");
  await screen.getByRole("form", "Agent in chat").getByText("finanzas", { exact: true }).tap();
  await screen.getByRole("form", "Agent in chat").getByRole("button", "Save").tap();
  await expect(screen.getByText("@finanzas-e2e")).toBeVisible({ timeout: 10000 });

  await screen.getByRole("tab", "Connections").tap();
  await screen.getByPlaceholder(/the part after \/folders\//).fill("FOLDER123");
  await screen.getByRole("group", "Google Drive").getByRole("button", "Save").tap();

  const settings = (await call("GET", "/api/settings")).json;
  const persona = settings.personas.find((p: { name: string }) => p.name === "finanzas-e2e");
  expect(persona.skills).toEqual(["finanzas"]);
  expect(settings.googleDriveFolderId).toBe("FOLDER123");
  await ensureCatalog();
});
