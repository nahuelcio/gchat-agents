import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adoProjects, adoRepos, cloneRepo, detectAdo, type FetchFn } from "../src/integrations.js";

function fakeFetch(routes: Record<string, unknown>, seen: { url: string; auth?: string }[] = []): FetchFn {
  return async (url, init) => {
    seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") ?? undefined });
    const body = routes[String(url)];
    if (body === undefined) return new Response("not found", { status: 404 });
    return Response.json(body);
  };
}

describe("Azure DevOps", () => {
  const ado = { org: "acme", pat: "secret-pat" };
  const basic = `Basic ${Buffer.from(":secret-pat").toString("base64")}`;

  it("lists projects and repos with PAT basic auth", async () => {
    const seen: { url: string; auth?: string }[] = [];
    const fetch = fakeFetch(
      {
        "https://dev.azure.com/acme/_apis/projects?api-version=7.1&$top=500": { value: [{ id: "p1", name: "Web App" }] },
        "https://dev.azure.com/acme/Web%20App/_apis/git/repositories?api-version=7.1": {
          value: [{ id: "r1", name: "frontend", remoteUrl: "https://acme@dev.azure.com/acme/Web%20App/_git/frontend", defaultBranch: "refs/heads/main" }],
        },
      },
      seen,
    );
    expect(await adoProjects(ado, fetch)).toEqual([{ id: "p1", name: "Web App" }]);
    expect(await adoRepos(ado, "Web App", fetch)).toEqual([
      { id: "r1", name: "frontend", remoteUrl: "https://acme@dev.azure.com/acme/Web%20App/_git/frontend", defaultBranch: "main" },
    ]);
    expect(seen.every((s) => s.auth === basic)).toBe(true);
  });
});

describe("cloneRepo", () => {
  it("clones into the target dir and refuses to overwrite an existing one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gchat-clone-"));
    const origin = join(dir, "origin");
    execFileSync("git", ["init", "-q", "-b", "main", origin]);
    await writeFile(join(origin, "a.txt"), "x");
    execFileSync("git", ["-C", origin, "add", "."]);
    execFileSync("git", ["-C", origin, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i"]);

    const dest = join(dir, "repos", "frontend");
    await cloneRepo(origin, dest, "pat");
    expect(existsSync(join(dest, "a.txt"))).toBe(true);
    // The PAT must never land in the remote URL.
    expect(execFileSync("git", ["-C", dest, "remote", "get-url", "origin"], { encoding: "utf8" })).not.toContain("pat");
    await expect(cloneRepo(origin, dest, "pat")).rejects.toThrow(/already exists/);
  });
});

describe("detectAdo", () => {
  async function home(adoJson: unknown, patFile?: string) {
    const h = await mkdtemp(join(tmpdir(), "gchat-home-"));
    await mkdir(join(h, ".config", "opencode"), { recursive: true });
    await writeFile(join(h, ".config", "opencode", "ado.json"), JSON.stringify(adoJson));
    if (patFile !== undefined) {
      await mkdir(join(h, ".azure-devops-cli"));
      await writeFile(join(h, ".azure-devops-cli", "pat"), `${patFile}\n`);
    }
    return h;
  }
  const profiles = {
    defaultProfile: "social",
    profiles: {
      flow: { org: "acme", project: "flow" },
      social: { org: "acme", project: "Social App", patEnvVar: "SOCIAL_PAT" },
    },
  };

  it("uses the default profile's org and follows the ado CLI PAT order", async () => {
    const h = await home(profiles, "file-pat");
    expect(detectAdo(h, { SOCIAL_PAT: "env-var-pat", AZURE_DEVOPS_PAT: "global" })).toEqual({
      org: "acme",
      pat: "env-var-pat",
      profile: "social",
      projects: ["flow", "Social App"],
      defaultProject: "Social App",
    });
    expect(detectAdo(h, { AZURE_DEVOPS_PAT: "global" })?.pat).toBe("global");
    expect(detectAdo(h, {})?.pat).toBe("file-pat");
  });

  it("returns undefined when there is no config or no PAT anywhere", async () => {
    expect(detectAdo(await mkdtemp(join(tmpdir(), "gchat-empty-")), { AZURE_DEVOPS_PAT: "x" })).toBeUndefined();
    expect(detectAdo(await home(profiles), {})).toBeUndefined();
  });
});
