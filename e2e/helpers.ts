import { request } from "node:http";

export const ADMIN_PORT = 18081;
export const BRIDGE_PORT = 18080;

export function call(method: string, path: string, body?: unknown, port = ADMIN_PORT, host = `127.0.0.1:${port}`) {
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      { host: "127.0.0.1", port, path, method, headers: { host, "content-type": "application/json" } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: raw ? safeJson(raw) : null }));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

function safeJson(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export const SUPPORT = [
  { name: "soporte", prompt: "Sos el agente de soporte funcional. Respondés dudas de configuración, uso y procedimientos, breve y en español. Si es un bug de código o hay que leer código o un stack trace, respondé exactamente PASS." },
  { name: "codigo", prompt: "Sos el agente que conoce el código del repo en tu directorio de trabajo. Explicás bugs y logs citando archivo y línea, breve y en español. Si es puramente de procedimiento o atención al cliente, respondé exactamente PASS." },
];

const CATALOG = [...["architect", "qa", "dev"].map((name) => ({ name, prompt: `You are ${name}.` })), ...SUPPORT];

export const ensureCatalog = () => call("PUT", "/api/settings", { personas: CATALOG });

export async function room(personas: string[], humans: string[] = []) {
  await ensureCatalog();
  const thread = `room-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  for (const persona of personas) await call("POST", "/api/team/members", { thread, op: "add", member: { kind: "agent", persona } });
  for (const name of humans) await call("POST", "/api/team/members", { thread, op: "add", member: { kind: "human", name } });
  return thread;
}

export const say = (thread: string, name: string, text: string) => call("POST", "/api/team/send", { thread, name, text });

export const authoredBy = (screen: any, persona: string) => screen.getByTestId("message-author").filter({ hasText: `@${persona}` }).first();
