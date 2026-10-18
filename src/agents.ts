export interface DetectedAgent {
  id: string;
  name: string;
  installed: boolean;
  version?: string;
  supported: boolean;
  ready?: boolean;
  detail?: string;
}

export async function detectAgents(harnessPresent = true, harnessUp = false): Promise<DetectedAgent[]> {
  return [
    {
      id: "pi",
      name: "Pi (durable)",
      installed: harnessPresent,
      version: "pi-durable 1.3.0",
      supported: true,
      ready: harnessUp,
      detail: harnessUp
        ? "harness running"
        : harnessPresent
          ? "harness starting or stopped"
          : "harness/server.ts not found",
    },
  ];
}

export async function piModels(): Promise<string[]> {
  return [];
}
