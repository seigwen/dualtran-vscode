/**
 * DualTran for VS Code — translate the selection and keep it visible next to the code.
 *
 * Two surfaces, the same engine as the browser extension:
 *   • inline  — the translation is rendered as a ghost line under the selection (toggle off with Esc)
 *   • panel   — source and translation side by side in a webview
 */
"use strict";

const vscode = require("vscode");
const { translate } = require("./src/translate");
const { MODELS_DEV_URL, projectCatalog, buildProviderList, resolveReasoning } = require("./src/catalog");

/** @type {vscode.TextEditorDecorationType | undefined} */
let ghost;
/** @type {vscode.StatusBarItem | undefined} */
let status;
/** @type {vscode.WebviewPanel | undefined} */
let panel;

const CATALOG_TTL = 24 * 60 * 60 * 1000;
const CATALOG_KEY = "dualtran.catalog";

/** models.dev id behind a built-in alias (google-gemini → google). */
function devIdFor(providerId) {
  const builtIn = BUILTINS_BY_ID[providerId];
  return builtIn ? builtIn.dev : providerId;
}

const BUILTINS_BY_ID = require("./src/catalog").BUILTINS.reduce((acc, entry) => {
  acc[entry.id] = entry;
  return acc;
}, {});

/**
 * models.dev catalogue, cached for a day. A failed refresh falls back to the
 * stale copy so a flaky network never empties the provider list.
 */
async function loadCatalog(context) {
  const cached = context.globalState.get(CATALOG_KEY);
  if (cached && Date.now() - cached.ts < CATALOG_TTL) return cached.data;
  try {
    const res = await fetch(MODELS_DEV_URL);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = projectCatalog(await res.json());
    await context.globalState.update(CATALOG_KEY, { ts: Date.now(), data });
    return data;
  } catch (error) {
    if (cached) return cached.data;
    throw error;
  }
}

const LANGUAGES = [
  ["zh-CN", "Chinese (Simplified)"],
  ["zh-TW", "Chinese (Traditional)"],
  ["en", "English"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["ru", "Russian"],
  ["pt", "Portuguese"],
  ["it", "Italian"],
  ["ar", "Arabic"],
  ["hi", "Hindi"],
];

function config() {
  const c = vscode.workspace.getConfiguration("dualtran");
  return {
    engine: c.get("engine", "google"),
    sourceLanguage: c.get("sourceLanguage", "auto"),
    targetLanguage: c.get("targetLanguage", "zh-CN"),
    provider: c.get("ai.provider", "openai"),
    endpoint: c.get("ai.endpoint", "https://api.openai.com/v1"),
    model: c.get("ai.model", "gpt-4o-mini"),
    reasoning: c.get("ai.reasoning", "lowest"),
  };
}

async function apiKey(context) {
  const key = await context.secrets.get("dualtran.aiKey");
  if (!key) {
    const entered = await vscode.window.showInputBox({
      title: "DualTran — AI API key",
      prompt: "Stored in the OS keychain via VS Code SecretStorage. Leave empty to keep the current key.",
      password: true,
      ignoreFocusOut: true,
    });
    if (!entered) throw new Error("No API key set (DualTran: Set AI API Key).");
    await context.secrets.store("dualtran.aiKey", entered);
    return entered;
  }
  return key;
}

function selectionOrLine(editor) {
  const sel = editor.selection;
  if (!sel.isEmpty) return editor.document.getText(sel);
  return editor.document.lineAt(sel.active.line).text;
}

async function runTranslate(context, text) {
  const cfg = config();
  let reasoning = "";
  if (cfg.engine === "ai" && cfg.reasoning !== "default") {
    // Unknown models resolve to "" — a parameter the endpoint invents would only cause a 400.
    const catalog = await loadCatalog(context).catch(() => null);
    const levels = catalog && catalog.reasoning[devIdFor(cfg.provider)] && catalog.reasoning[devIdFor(cfg.provider)][cfg.model];
    reasoning = resolveReasoning(cfg.reasoning, levels);
  }
  const opts = {
    engine: cfg.engine,
    sourceLanguage: cfg.sourceLanguage,
    targetLanguage: cfg.targetLanguage,
    ai: {
      endpoint: cfg.endpoint,
      model: cfg.model,
      reasoning,
      key: cfg.engine === "ai" ? await apiKey(context) : "",
    },
  };
  return translate(text, opts);
}

function paintStatus(text, busy) {
  if (!status) return;
  if (text) {
    status.text = (busy ? "$(sync~spin) " : "$(globe) ") + text;
    status.show();
    clearTimeout(paintStatus._t);
    paintStatus._t = setTimeout(() => status.hide(), 6000);
  } else {
    status.hide();
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function showPanel(context, source, result, targetLang) {
  const nonce = String(Math.random()).slice(2);
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font: 13px/1.6 var(--vscode-font-family); color: var(--vscode-foreground); margin: 0; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--vscode-panel-border); height: 100vh; }
  section { background: var(--vscode-editor-background); padding: 14px 16px; overflow: auto; }
  h2 { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--vscode-descriptionForeground); margin: 0 0 10px; }
  pre { white-space: pre-wrap; word-break: break-word; margin: 0; font: inherit; }
</style></head>
<body><div class="grid">
  <section><h2>Source</h2><pre>${escapeHtml(source)}</pre></section>
  <section><h2>${escapeHtml(targetLang)}</h2><pre>${escapeHtml(result)}</pre></section>
</div>
<script nonce="${nonce}">const vscode = acquireVsCodeApi();</script>
</body></html>`;

  if (panel) {
    panel.webview.html = html;
    panel.reveal(vscode.ViewColumn.Beside, true);
    return;
  }
  panel = vscode.window.createWebviewPanel("dualtran.panel", "DualTran", vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  panel.webview.html = html;
  panel.onDidDispose(() => (panel = undefined), null, context.subscriptions);
}

function activate(context) {
  ghost = vscode.window.createTextEditorDecorationType({
    after: {
      margin: "0 0 0 2em",
      color: new vscode.ThemeColor("editorCodeLens.foreground"),
      fontStyle: "italic",
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });

  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(status);

  const cmd = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  cmd("dualtran.translateInline", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return vscode.window.showWarningMessage("DualTran: open a file first.");
    const text = selectionOrLine(editor).trim();
    if (!text) return;
    try {
      paintStatus("translating…", true);
      const result = await runTranslate(context, text);
      const line = editor.selection.end.line;
      const endChar = editor.document.lineAt(line).range.end.character;
      const range = new vscode.Range(line, 0, line, endChar);
      editor.setDecorations(ghost, [{ range, renderOptions: { after: { contentText: "  " + result.replace(/\s*\n\s*/g, " ") } } }]);
      paintStatus(result.slice(0, 60) + (result.length > 60 ? "…" : ""));
    } catch (e) {
      vscode.window.showErrorMessage("DualTran: " + (e && e.message ? e.message : e));
      paintStatus("");
    }
  });

  cmd("dualtran.clearInline", () => {
    vscode.window.visibleTextEditors.forEach((ed) => ed.setDecorations(ghost, []));
    paintStatus("");
  });

  cmd("dualtran.translatePanel", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return vscode.window.showWarningMessage("DualTran: open a file first.");
    const text = selectionOrLine(editor).trim();
    if (!text) return;
    try {
      paintStatus("translating…", true);
      const result = await runTranslate(context, text);
      showPanel(context, text, result, config().targetLanguage);
      paintStatus("");
    } catch (e) {
      vscode.window.showErrorMessage("DualTran: " + (e && e.message ? e.message : e));
      paintStatus("");
    }
  });

  cmd("dualtran.replaceSelection", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    if (editor.selection.isEmpty) return vscode.window.showWarningMessage("DualTran: select the text to replace.");
    const text = editor.document.getText(editor.selection);
    try {
      const result = await runTranslate(context, text);
      await editor.edit((b) => b.replace(editor.selection, result));
    } catch (e) {
      vscode.window.showErrorMessage("DualTran: " + (e && e.message ? e.message : e));
    }
  });

  cmd("dualtran.pickTarget", async () => {
    const pick = await vscode.window.showQuickPick(
      LANGUAGES.map(([code, label]) => ({ label: label, description: code, code })),
      { title: "DualTran — target language" }
    );
    if (pick) await vscode.workspace.getConfiguration("dualtran").update("targetLanguage", pick.code, vscode.ConfigurationTarget.Global);
  });

  cmd("dualtran.pickProvider", async () => {
    let catalog;
    try {
      catalog = await loadCatalog(context);
    } catch (error) {
      return vscode.window.showErrorMessage("DualTran: could not load models.dev — " + (error && error.message ? error.message : error));
    }
    const list = buildProviderList(catalog.providers, catalog.modelsById);
    const firstCatalogue = list.findIndex((provider) => !provider.builtIn);
    const items = [];
    list.forEach((provider, index) => {
      if (index === firstCatalogue) {
        items.push({ label: "More (models.dev)", kind: vscode.QuickPickItemKind.Separator });
      }
      items.push({
        label: provider.name,
        description: provider.id,
        detail: provider.api,
        provider,
      });
    });
    const pick = await vscode.window.showQuickPick(items, {
      title: "DualTran — AI provider",
      placeHolder: "Built-in first, then every provider models.dev knows",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!pick || !pick.provider) return;
    const cfg = vscode.workspace.getConfiguration("dualtran");
    const model = (pick.provider.models[0] && pick.provider.models[0].id) || "";
    await cfg.update("ai.provider", pick.provider.id, vscode.ConfigurationTarget.Global);
    await cfg.update("ai.endpoint", pick.provider.api, vscode.ConfigurationTarget.Global);
    await cfg.update("engine", "ai", vscode.ConfigurationTarget.Global);
    if (model) await cfg.update("ai.model", model, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(
      "DualTran: " + pick.provider.name + (model ? " — " + model : " — set a model")
    );
  });

  cmd("dualtran.refreshProviders", async () => {
    await context.globalState.update(CATALOG_KEY, undefined);
    try {
      const catalog = await loadCatalog(context);
      vscode.window.showInformationMessage("DualTran: " + catalog.providers.length + " providers loaded from models.dev.");
    } catch (error) {
      vscode.window.showErrorMessage("DualTran: catalogue refresh failed — " + (error && error.message ? error.message : error));
    }
  });

  cmd("dualtran.setApiKey", async () => {
    const entered = await vscode.window.showInputBox({
      title: "DualTran — AI API key",
      prompt: "Stored in SecretStorage (OS keychain).",
      password: true,
      ignoreFocusOut: true,
    });
    if (entered) {
      await context.secrets.store("dualtran.aiKey", entered);
      vscode.window.showInformationMessage("DualTran: API key saved.");
    }
  });

  // Esc clears the ghost line, the same reflex as closing a hover.
  context.subscriptions.push(
    vscode.commands.registerCommand("dualtran.escape", () => {
      vscode.window.visibleTextEditors.forEach((ed) => ed.setDecorations(ghost, []));
      paintStatus("");
    })
  );
}

function deactivate() {
  if (ghost) ghost.dispose();
  if (status) status.dispose();
}

module.exports = { activate, deactivate };
