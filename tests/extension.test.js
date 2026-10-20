// Loads extension.js against a stub of the `vscode` module: catches bad command ids,
// missing exports and activate-time crashes without needing a VS Code window.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");
const path = require("node:path");

function stubVscode() {
  const commands = [];
  const subs = [];
  const vscode = {
    window: {
      activeTextEditor: undefined,
      visibleTextEditors: [],
      createTextEditorDecorationType: () => ({ dispose() {} }),
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
      showWarningMessage() {}, showErrorMessage() {}, showInformationMessage() {},
      showQuickPick: async () => undefined,
      showInputBox: async () => undefined,
      createWebviewPanel: () => ({ webview: {}, reveal() {}, onDidDispose() {} }),
    },
    workspace: {
      getConfiguration: () => ({ get: (_k, d) => d, update: async () => {} }),
    },
    commands: {
      registerCommand: (id, fn) => { commands.push(id); const d = { dispose() {} }; subs.push(d); return d; },
      executeCommand: async () => {},
    },
    StatusBarAlignment: { Right: 2 },
    ThemeColor: class { constructor(c) { this.id = c; } },
    DecorationRangeBehavior: { ClosedClosed: 1 },
    Range: class { constructor(a, b, c, d) { Object.assign(this, { a, b, c, d }); } },
    ViewColumn: { Beside: -2 },
    ConfigurationTarget: { Global: 1 },
  };
  return { vscode, commands, subs };
}

test("extension registers every contributed command", () => {
  const stub = stubVscode();
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") return stub.vscode;
    return original.apply(this, arguments);
  };
  try {
    const ext = require(path.join(__dirname, "..", "extension.js"));
    const context = { subscriptions: [], secrets: { get: async () => "k", store: async () => {} } };
    ext.activate(context);
    const pkg = require(path.join(__dirname, "..", "package.json"));
    const declared = pkg.contributes.commands.map((c) => c.command);
    for (const id of declared) assert.ok(stub.commands.includes(id), "not registered: " + id);
    assert.ok(stub.commands.includes("dualtran.escape"), "escape handler missing");
    ext.deactivate();
  } finally {
    Module._load = original;
  }
});
