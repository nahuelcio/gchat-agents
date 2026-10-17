import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { room, say } from "./helpers";

const LONG = { timeout: 900000 };
const REPLY = { timeout: 480000 };
const from = (persona: string) => new RegExp(`@${persona}[*]`);

async function joinAs(app: any, screen: any, thread: string, name: string) {
  await app.open(`/#team/${thread}`);
  const field = screen.getByLabel("Your name");
  if (await field.isVisible()) {
    await field.fill(name);
    await screen.getByRole("button", "Continue").tap();
  }
}

async function send(screen: any, text: string) {
  await screen.getByRole("textbox", "Message the agent").fill(text);
  await screen.getByRole("button", "Send").tap();
}

async function noAgentErrors(screen: any) {
  await expect(screen.getByText(/failed: |Agent error/)).not.toBeVisible();
}

test("a mentioned agent answers in the room", LONG, async ({ app, screen }) => {
  const thread = await room(["architect", "qa"], ["Beto"]);
  await joinAs(app, screen, thread, "Ana");
  await send(screen, "@architect en una frase: monolito o microservicios para un MVP?");
  await expect(screen.getByText(from("architect")).first()).toBeVisible(REPLY);
  await noAgentErrors(screen);
});

test("two humans share the room and an agent answers the other human", LONG, async ({ app, screen }) => {
  const thread = await room(["architect", "qa"], ["Ana", "Beto"]);
  await joinAs(app, screen, thread, "Ana");
  await say(thread, "Beto", "hola soy Beto, @qa en una frase: que testearias primero en un checkout?");
  await expect(screen.getByText(/hola soy Beto/).first()).toBeVisible(REPLY);
  await expect(screen.getByText(from("qa")).first()).toBeVisible(REPLY);
  await send(screen, "gracias Beto");
  await expect(screen.getByText("gracias Beto").first()).toBeVisible();
  await noAgentErrors(screen);
});

test("agents talk to each other when a human brings both in", LONG, async ({ app, screen }) => {
  const thread = await room(["architect", "qa"], ["Beto"]);
  await joinAs(app, screen, thread, "Ana");
  await send(screen, "@architect propone en una frase como guardar sesiones y @qa responde con un riesgo de esa idea");
  await expect(screen.getByText(from("architect")).first()).toBeVisible(REPLY);
  await expect(screen.getByText(from("qa")).first()).toBeVisible(REPLY);
  await noAgentErrors(screen);
});
