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
import { ensureLanguagePack } from "./langpack.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const ARTIFACTS = path.join(ROOT, "e2e-artifacts");

async function main() {
  fs.rmSync(ARTIFACTS, { recursive: true, force: true });
  fs.mkdirSync(ARTIFACTS, { recursive: true });

  const mock = await startMock();
  let profileDir = "";
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dualtran-e2e-"));
  fs.writeFileSync(path.join(workspace, "sample.md"), "Hello world\n", "utf8");

  try {
    // DT_LOCALE runs the very same suite inside a localised host, so the i18n
    // block in run.js can prove the bundle is actually picked up.
    const locale = process.env.DT_LOCALE || "";
    const launchArgs = [workspace, "--disable-gpu", "--no-sandbox", "--skip-welcome", "--skip-release-notes"];
    const baseEnv = { DT_E2E: "1", DT_MOCK: mock.origin, DT_ARTIFACTS: ARTIFACTS };

    if (!locale) {
      await runTests({
        extensionDevelopmentPath: ROOT,
        extensionTestsPath: path.join(HERE, "extension-host", "run.js"),
        launchArgs,
        extensionTestsEnv: { ...baseEnv, DT_EXPECT_LOCALE: "" },
      });
    } else {
      // VS Code ignores --locale unless the matching pack is installed AND the
      // profile already knows the extension: the first start only builds that
      // cache. So the localised run is: install pack → warm-up start → real run.
      const profile = fs.mkdtempSync(path.join(os.tmpdir(), "dualtran-e2e-profile-"));
      const extensionsDir = path.join(profile, "extensions");
      const dataDir = path.join(profile, "data");
      await ensureLanguagePack(locale, extensionsDir);
      fs.mkdirSync(dataDir, { recursive: true });
      // argv.json is the documented place for a persistent UI language.
      fs.writeFileSync(path.join(dataDir, "argv.json"), JSON.stringify({ locale }, null, 2) + "\n");
      launchArgs.push(`--user-data-dir=${dataDir}`, `--extensions-dir=${extensionsDir}`, `--locale=${locale}`);
      profileDir = profile;

      const hostEnv = { ...baseEnv, DT_EXPECT_LOCALE: locale };
      await runTests({
        extensionDevelopmentPath: ROOT,
        extensionTestsPath: path.join(HERE, "extension-host", "run.js"),
        launchArgs,
        extensionTestsEnv: { ...hostEnv, DT_WARMUP: "1" },
      });
      await runTests({
        extensionDevelopmentPath: ROOT,
        extensionTestsPath: path.join(HERE, "extension-host", "run.js"),
        launchArgs,
        extensionTestsEnv: hostEnv,
      });
    }
  } finally {
    fs.writeFileSync(path.join(ARTIFACTS, "requests.json"), JSON.stringify(mock.requests, null, 2));
    await mock.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("VS Code E2E failed:", error);
  process.exit(1);
});
