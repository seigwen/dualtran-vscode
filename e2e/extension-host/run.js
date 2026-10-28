/**
 * Runs INSIDE the VS Code extension host (see e2e/run-tests.mjs).
 *
 * Real extension, real editor, real HTTP: the mock records what left the
 * process, so these checks fail if the endpoint, the key, the model or the
 * reasoning parameter regress — the exact class of bug unit tests miss.
 */
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const vscode = require("vscode");

const MOCK = process.env.DT_MOCK;
const ARTIFACTS = process.env.DT_ARTIFACTS || "/tmp";

function mockRequest(url, { method = "GET", body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      `${MOCK}${url}`,
      {
        method,
        headers: payload ? { "content-type": "application/json" } : undefined,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") })
        );
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function runChecks() {
  // Warm-up start of a localised profile: it only exists to let VS Code build
  // its extension cache, which is what makes the language pack take effect.
  if (process.env.DT_WARMUP === "1") return;

  const extension = vscode.extensions.getExtension("seigwenlee.dualtran");
  assert.ok(extension, "DualTran extension is not installed in the test host");
  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  for (const id of [
    "dualtran.translateInline",
    "dualtran.translatePanel",
    "dualtran.pickProvider",
    "dualtran.refreshProviders",
  ]) {
    assert.ok(commands.includes(id), `command ${id} is not registered`);
  }

  const config = vscode.workspace.getConfiguration("dualtran");
  await config.update("engine", "ai", vscode.ConfigurationTarget.Global);
  await config.update("ai.provider", "openai", vscode.ConfigurationTarget.Global);
  await config.update("ai.endpoint", `${MOCK}/v1`, vscode.ConfigurationTarget.Global);
  await config.update("ai.model", "gpt-5", vscode.ConfigurationTarget.Global);
  await config.update("ai.reasoning", "high", vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand("dualtran.__e2e.setApiKey", "e2e-key");

  const document = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: "Hello world, this is a sentence to translate.\n",
  });
  const editor = await vscode.window.showTextDocument(document);
  editor.selection = new vscode.Selection(0, 0, 0, 12);

  // 1) one real request, with the configured model, key and reasoning level
  await vscode.commands.executeCommand("dualtran.translateInline");
  const first = await mockRequest("/requests");
  const calls = JSON.parse(first.text);
  assert.strictEqual(calls.length, 1, `expected one request, saw ${calls.length}`);
  assert.strictEqual(calls[0].body.model, "gpt-5", "model did not reach the wire");
  assert.strictEqual(calls[0].body.reasoning_effort, "high", "reasoning_effort did not reach the wire");
  assert.strictEqual(calls[0].headers.authorization, "Bearer e2e-key", "api key did not reach the wire");

  // 2) a gateway that rejects reasoning gets exactly one retry without it
  await mockRequest("/mode", { method: "POST", body: { mode: "reject-reasoning" } });
  await mockRequest("/reset", { method: "POST" });
  editor.selection = new vscode.Selection(0, 0, 0, 12);
  await vscode.commands.executeCommand("dualtran.translateInline");
  await waitFor(
    async () => {
      const snapshot = JSON.parse((await mockRequest("/requests")).text);
      return snapshot.length >= 2;
    },
    5000,
    "the retry without reasoning_effort"
  );
  const retried = JSON.parse((await mockRequest("/requests")).text);
  assert.strictEqual(retried.length, 2, `expected 2 attempts, saw ${retried.length}`);
  assert.ok("reasoning_effort" in retried[0].body, "first attempt must carry reasoning_effort");
  assert.ok(!("reasoning_effort" in retried[1].body), "retry must drop reasoning_effort");

  // 3) the side panel actually opens a DualTran webview tab
  await mockRequest("/mode", { method: "POST", body: { mode: "ok" } });
  await vscode.commands.executeCommand("dualtran.translatePanel");
  await waitFor(
    async () =>
      vscode.window.tabGroups.all.some((group) =>
        group.tabs.some((tab) => tab.label === "DualTran")
      ),
    5000,
    "the DualTran webview tab"
  );

  // 4) settings are global and survive a re-read (the QuickPick writes the same keys)
  const reread = vscode.workspace.getConfiguration("dualtran");
  assert.strictEqual(reread.get("ai.provider"), "openai");
  assert.strictEqual(reread.get("ai.reasoning"), "high");

  // 5) localisation: the host's display language selects our bundles
  const expectedLocale = process.env.DT_EXPECT_LOCALE || "";
  const localeProbe = {
    envLanguage: vscode.env.language,
    translatedStatus: vscode.l10n.t("translating…"),
    translatedSaved: vscode.l10n.t("DualTran: API key saved."),
    commandTitles: (vscode.extensions.getExtension("seigwenlee.dualtran").packageJSON.contributes.commands || []).map(
      (command) => command.title
    ),
  };
  fs.writeFileSync(path.join(ARTIFACTS, "i18n-probe.json"), JSON.stringify(localeProbe, null, 2));

  if (expectedLocale) {
    const cataloguePath = path.join(__dirname, "..", "..", "locales", expectedLocale, "messages.json");
    const catalogue = JSON.parse(fs.readFileSync(cataloguePath, "utf8"));
    // VS Code resolves %keys% in the manifest from package.nls.<locale>.json.
    const nlsPath = path.join(__dirname, "..", "..", `package.nls.${expectedLocale}.json`);
    const nls = JSON.parse(fs.readFileSync(nlsPath, "utf8"));
    const titles = localeProbe.commandTitles;
    assert.ok(
      titles.length > 0 && titles.every((entry) => typeof entry === "object" && entry.value !== entry.original),
      `manifest command titles were not localised: ${JSON.stringify(titles)}`
    );
    const localised = titles.find((entry) => entry.value === nls.cmdRefreshProviders);
    assert.ok(
      localised && localised.value !== localised.original,
      "the provider-catalogue command title must come from package.nls.<locale>.json"
    );
    assert.strictEqual(
      vscode.env.language,
      expectedLocale,
      `the host ignored --locale=${expectedLocale} (env.language=${vscode.env.language})`
    );
    assert.strictEqual(
      localeProbe.translatedStatus,
      catalogue.statusTranslating.message,
      `l10n.t must use l10n/bundle.l10n.${expectedLocale}.json, got "${localeProbe.translatedStatus}"`
    );
    assert.strictEqual(
      localeProbe.translatedSaved,
      catalogue.infoApiKeySaved.message,
      `runtime message not translated, got "${localeProbe.translatedSaved}"`
    );
  } else {
    // English host: no bundle for "en" — l10n.t must return the source string,
    // and the manifest titles stay unresolved English.
    assert.strictEqual(localeProbe.translatedStatus, "translating…");
    assert.strictEqual(localeProbe.translatedSaved, "DualTran: API key saved.");
    assert.ok(
      localeProbe.commandTitles.every((entry) => entry.value === entry.original),
      "English host must show the source titles"
    );
  }

  fs.writeFileSync(path.join(ARTIFACTS, "host-checks.txt"), "all host checks passed\n");
}

exports.run = async function run() {
  try {
    await runChecks();
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    fs.writeFileSync(
      path.join(ARTIFACTS, "error.txt"),
      String(error && error.stack ? error.stack : error)
    );
    throw error;
  }
};
