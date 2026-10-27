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
