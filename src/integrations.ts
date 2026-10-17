import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

async function getJson<T>(fetchFn: FetchFn, url: string, auth: string): Promise<T> {
  const res = await fetchFn(url, { headers: { authorization: auth }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

export interface AdoAuth {
  org: string;
  pat: string;
}

function adoAuth(pat: string): string {
  return `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
}

export async function adoProjects(
  ado: AdoAuth,
  fetchFn: FetchFn = fetch,
): Promise<{ id: string; name: string }[]> {
  const body = await getJson<{ value: { id: string; name: string }[] }>(
    fetchFn,
    `https://dev.azure.com/${ado.org}/_apis/projects?api-version=7.1&$top=500`,
    adoAuth(ado.pat),
  );
  return body.value.map(({ id, name }) => ({ id, name }));
}

export interface AdoRepo {
  id: string;
  name: string;
  remoteUrl: string;
  defaultBranch?: string;
}

export async function adoRepos(
  ado: AdoAuth,
  project: string,
  fetchFn: FetchFn = fetch,
): Promise<AdoRepo[]> {
  const body = await getJson<{ value: (AdoRepo & { defaultBranch?: string })[] }>(
    fetchFn,
    `https://dev.azure.com/${ado.org}/${encodeURIComponent(project)}/_apis/git/repositories?api-version=7.1`,
    adoAuth(ado.pat),
  );
  return body.value.map(({ id, name, remoteUrl, defaultBranch }) => ({
    id,
    name,
    remoteUrl,
    ...(defaultBranch && { defaultBranch: defaultBranch.replace(/^refs\/heads\//, "") }),
  }));
}

export interface AdoWorkItem {
  id: number;
  title: string;
  state: string;
  type: string;
  url: string;
}

/** Looks up one work item by id (org-wide). Failures bubble as Error. */
export async function adoWorkItem(ado: AdoAuth, id: number, fetchFn: FetchFn = fetch): Promise<AdoWorkItem> {
  const body = await getJson<{
    id: number;
    fields: Record<string, string>;
    _links?: { html?: { href?: string } };
  }>(fetchFn, `https://dev.azure.com/${ado.org}/_apis/wit/workitems/${id}?api-version=7.1`, adoAuth(ado.pat));
  return {
    id: body.id,
    title: body.fields["System.Title"] ?? "",
    state: body.fields["System.State"] ?? "",
    type: body.fields["System.WorkItemType"] ?? "Work Item",
    url: body._links?.html?.href ?? `https://dev.azure.com/${ado.org}/_workitems/edit/${id}`,
  };
}

/**
 * Clones with the PAT sent as an HTTP header, then stores that header in the clone's
 * local git config so the agent can fetch/push from worktrees. The remote URL stays clean.
 */
export async function cloneRepo(remoteUrl: string, dest: string, pat: string): Promise<void> {
  if (existsSync(dest)) throw new Error(`${dest} already exists`);
  mkdirSync(dirname(dest), { recursive: true });
  const header = `http.extraHeader=Authorization: ${adoAuth(pat)}`;
  await run("git", ["-c", header, "clone", "--quiet", remoteUrl, dest], { timeout: 10 * 60_000 });
  // ponytail: PAT lives in <clone>/.git/config, same trust level as config.json (both local, user-only).
  await run("git", ["-C", dest, "config", "http.extraHeader", `Authorization: ${adoAuth(pat)}`]);
}

export interface DetectedAdo {
  org: string;
  pat: string;
  profile: string;
  /** Projects from the ado CLI profiles, to preselect in the UI. */
  projects: string[];
  defaultProject?: string;
}

interface AdoCliConfig {
  defaultProfile?: string;
  profiles?: Record<string, { org?: string; project?: string; pat?: string; patEnvVar?: string; default?: boolean }>;
}

/**
 * Reuses the machine's `ado` CLI setup (~/.config/opencode/ado.json) so nobody pastes a PAT twice.
 * PAT order mirrors the CLI: profile pat -> profile patEnvVar -> AZURE_DEVOPS_PAT -> ~/.azure-devops-cli/pat.
 */
export function detectAdo(home: string, env: NodeJS.ProcessEnv): DetectedAdo | undefined {
  let config: AdoCliConfig;
  try {
    config = JSON.parse(readFileSync(join(home, ".config", "opencode", "ado.json"), "utf8")) as AdoCliConfig;
  } catch {
    return undefined;
  }
  const profiles = config.profiles ?? {};
  const name =
    (config.defaultProfile && profiles[config.defaultProfile] ? config.defaultProfile : undefined) ??
    Object.keys(profiles).find((k) => profiles[k]?.default) ??
    Object.keys(profiles)[0];
  const profile = name ? profiles[name] : undefined;
  if (!name || !profile?.org) return undefined;

  let filePat: string | undefined;
  try {
    filePat = readFileSync(join(home, ".azure-devops-cli", "pat"), "utf8").trim() || undefined;
  } catch {
    // no PAT file
  }
  const pat =
    profile.pat || (profile.patEnvVar && env[profile.patEnvVar]) || env["AZURE_DEVOPS_PAT"] || filePat;
  if (!pat) return undefined;

  const projects = [
    ...new Set(
      Object.values(profiles)
        .filter((p) => p.org === profile.org && p.project)
        .map((p) => p.project!),
    ),
  ];
  return { org: profile.org, pat, profile: name, projects, ...(profile.project && { defaultProject: profile.project }) };
}
