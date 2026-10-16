import { describe, expect, it } from "vitest";
import { ensureTunnel } from "../src/tunnel.js";

describe("ensureTunnel", () => {
  it("adds (or reuses) the route for the port and returns its public URL", async () => {
    const calls: string[][] = [];
    const url = await ensureTunnel(8080, async (bin, args) => {
      calls.push([bin, ...args]);
      return "Tunnel is ready.\nAdded route 379f2a5f37dcea5a → 127.0.0.1:8080\nhttps://379f2a5f37dcea5a.4vy2yxzey55t.opentunnel.xyz\n";
    });
    expect(calls).toEqual([["opentunnel", "route", "add", "8080"]]);
    expect(url).toBe("https://379f2a5f37dcea5a.4vy2yxzey55t.opentunnel.xyz");
  });

  it("explains how to install opentunnel when it is missing", async () => {
    const missing = Object.assign(new Error("spawn opentunnel ENOENT"), { code: "ENOENT" });
    await expect(ensureTunnel(8080, async () => Promise.reject(missing))).rejects.toThrow(/npm i -g opentunnel/);
  });

  it("fails clearly when no URL comes back", async () => {
    await expect(ensureTunnel(8080, async () => "something unexpected")).rejects.toThrow(/no public URL/);
  });
});
