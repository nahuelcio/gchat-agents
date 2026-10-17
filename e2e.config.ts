import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";

const dataDir = mkdtempSync(join(tmpdir(), "switchboard-e2e-"));
const bin = join("rust", "target", "debug", process.platform === "win32" ? "switchboard.exe" : "switchboard");

export default {
  tests: ["e2e/**/*.e2e.ts"],
  targets: [
    {
      engine: web(),
      app: {
        url: "http://127.0.0.1:18081",
        readyUrl: "http://127.0.0.1:18081/api/health",
        command: {
          executable: bin,
          args: ["--driver", "echo"],
          env: {
            PORT: "18080",
            ADMIN_PORT: "18081",
            TUNNEL: "off",
            DATA_DIR: dataDir,
            AGENT_WORKDIR: join(dataDir, "workspace"),
            CHAT_ALLOWED_SPACES: "spaces/e2e",
          },
          log: ".e2e/logs/app.log",
        },
      },
    },
  ],
} satisfies E2EConfig;
