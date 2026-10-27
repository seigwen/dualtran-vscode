/**
 * run-tests.mjs — VS Code E2E in the real extension host.
 *
 * Downloads VS Code stable (cached under .vscode-test/), launches it with the
 * extension under development, and runs e2e/extension-host/run.js inside the
 * host. A local OpenAI-compatible mock records every request, so the checks
 * prove the transport (endpoint/model/key/reasoning + retry), not just that a
 * command returned.
 *
 * Linux needs a display: use `xvfb-run -a npm run e2e` in CI.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";
import { startMock } from "./mock-server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const ARTIFACTS = path.join(ROOT, "e2e-artifacts");

async function main() {
  fs.rmSync(ARTIFACTS, { recursive: true, force: true });
  fs.mkdirSync(ARTIFACTS, { recursive: true });

  const mock = await startMock();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dualtran-e2e-"));
  fs.writeFileSync(path.join(workspace, "sample.md"), "Hello world\n", "utf8");

  try {
    await runTests({
      extensionDevelopmentPath: ROOT,
      extensionTestsPath: path.join(HERE, "extension-host", "run.js"),
      launchArgs: [workspace, "--disable-gpu", "--no-sandbox", "--skip-welcome", "--skip-release-notes"],
      extensionTestsEnv: {
        DT_E2E: "1",
        DT_MOCK: mock.origin,
        DT_ARTIFACTS: ARTIFACTS,
      },
    });
  } finally {
    fs.writeFileSync(path.join(ARTIFACTS, "requests.json"), JSON.stringify(mock.requests, null, 2));
    await mock.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("VS Code E2E failed:", error);
  process.exit(1);
});
