import { request } from "node:http";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";

function status(port: number, path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    })
      .on("error", reject)
      .end();
  });
}

test("admin rejects foreign Host header", async () => {
  expect(await status(18081, "/api/settings", "evil.example")).toBe(403);
  expect(await status(18081, "/api/settings", "127.0.0.1:18081")).toBe(200);
});

test("bridge healthz answers", async () => {
  expect(await status(18080, "/healthz", "anything")).toBe(200);
});
