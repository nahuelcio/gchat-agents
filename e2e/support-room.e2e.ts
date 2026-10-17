import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { authoredBy, call, ensureCatalog, SUPPORT } from "./helpers";

const REAL = process.env.E2E_DRIVER === "opencode";
const LONG = { timeout: 900000 };
const REPLY = { timeout: 600000 };


async function supportRoom() {
  await ensureCatalog();
  const thread = `soporte-${Date.now().toString(36)}`;
  for (const p of SUPPORT) await call("POST", "/api/team/members", { thread, op: "add", member: { kind: "agent", persona: p.name } });
  return thread;
}

async function ask(app: any, screen: any, thread: string, text: string) {
  await app.open(`/#team/${thread}`);
  const field = screen.getByLabel("Your name");
  if (await field.isVisible()) {
    await field.fill("Lucia");
    await screen.getByRole("button", "Continue").tap();
  }
  await screen.getByRole("textbox", "Message the agent").fill(text);
  await screen.getByRole("button", "Send").tap();
}

if (REAL) {
  test("a process question is picked up by support without mentions", LONG, async ({ app, screen }) => {
    const thread = await supportRoom();
    await ask(app, screen, thread, "Un cliente pregunta como explicarle a sus operadores que el bot deriva a humano fuera de horario y nadie atiende. Como se lo comunicamos?");
    await expect(authoredBy(screen, "soporte")).toBeVisible(REPLY);
    await expect(screen.getByText(/failed: |Agent error/)).not.toBeVisible();
  });

  test("a log question is picked up by the code agent without mentions", LONG, async ({ app, screen }) => {
    const thread = await supportRoom();
    await ask(app, screen, thread, "Nos pasaron este log de un cliente, que significa y es grave? `Redis: Max retries reached (10)`");
    await expect(authoredBy(screen, "codigo")).toBeVisible(REPLY);
    await expect(screen.getByText(/failed: |Agent error/)).not.toBeVisible();
  });
}
