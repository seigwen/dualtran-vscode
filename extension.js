/**
 * DualTran for VS Code — translate the selection and keep it visible next to the code.
 *
 * Two surfaces, the same engine as the browser extension:
 *   • inline  — the translation is rendered as a ghost line under the selection (toggle off with Esc)
 *   • panel   — source and translation side by side in a webview
 */
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

/** Runtime strings go through VS Code's own l10n (l10n/bundle.l10n.<locale>.json). */
const t = (message, ...args) => (args.length ? vscode.l10n.t(message, ...args.map(String)) : vscode.l10n.t(message));
const { translate, providerRequiredError } = require("./src/translate");
const { MODELS_DEV_URL, projectCatalog, buildProviderList, resolveReasoning } = require("./src/catalog");

const pkg = require("./package.json");

/** @type {vscode.TextEditorDecorationType | undefined} */
let ghost;
/** @type {vscode.StatusBarItem | undefined} */
let status;
/** @type {vscode.WebviewPanel | undefined} */
let panel;

const CATALOG_TTL = 24 * 60 * 60 * 1000;
// The projection is ~1.3 MB; globalState is a json blob VS Code warns about at
// this size, so it lives in the extension's global storage directory instead.
const CATALOG_FILE = "catalog.json";

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
function catalogPath(context) {
  return path.join(context.globalStorageUri.fsPath, CATALOG_FILE);
}

async function readCatalogCache(context) {
  try {
    return JSON.parse(await fs.readFile(catalogPath(context), "utf8"));
  } catch {
    return null;
  }
}

async function loadCatalog(context) {
  const cached = await readCatalogCache(context);
  if (cached && Date.now() - cached.ts < CATALOG_TTL) return cached.data;
  try {
    const res = await fetch(MODELS_DEV_URL);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = projectCatalog(await res.json());
    await fs.mkdir(context.globalStorageUri.fsPath, { recursive: true });
    await fs.writeFile(catalogPath(context), JSON.stringify({ ts: Date.now(), data }), "utf8");
    return data;
  } catch (error) {
    if (cached) return cached.data;
    throw error;
  }
}

/**
 * The target languages, read from the manifest's enum so the Settings dropdown
 * and the QuickPick can never drift apart. One entry per enum slot.
 */
const TARGET = pkg.contributes.configuration.properties["dualtran.targetLanguage"];
const LANGUAGES = (TARGET.enum || []).map((code, index) => [
  code,
  (TARGET.enumDescriptions && TARGET.enumDescriptions[index]) || code,
]);
const TARGET_CODES = new Set(LANGUAGES.map(([code]) => code));

/**
 * A target language only ever comes from the enum: a hand-edited setting with an
 * unknown code falls back to the current/default value instead of being sent to
 * the engine. Known codes pass through untouched (case is the caller's business).
 */
function normalizeTargetLanguage(code, fallback = TARGET.default) {
  const value = typeof code === "string" ? code.trim() : "";
  if (TARGET_CODES.has(value)) return value;
  return TARGET_CODES.has(fallback) ? fallback : TARGET.default;
}

/**
 * The AI settings, read once. Nothing here falls back to a provider: a fresh
 * install is unconfigured (`""`) and `runTranslate` refuses to call out until
 * the user picks one. Stored values are returned exactly as they are stored.
 */
const AI_DEFAULTS = { provider: "", endpoint: "", model: "", reasoning: "lowest" };

function config() {
  const c = vscode.workspace.getConfiguration("dualtran");
  const stored = typeof c.get("ai.provider", AI_DEFAULTS.provider) === "string" ? c.get("ai.provider", AI_DEFAULTS.provider) : "";
  return {
    engine: c.get("engine", "google"),
    sourceLanguage: c.get("sourceLanguage", "auto"),
    targetLanguage: normalizeTargetLanguage(c.get("targetLanguage", TARGET.default)),
    // "" is the unconfigured state; a stored id is returned untouched.
    provider: stored.trim() === "" ? "" : stored,
    endpoint: c.get("ai.endpoint", AI_DEFAULTS.endpoint),
    model: c.get("ai.model", AI_DEFAULTS.model),
    reasoning: c.get("ai.reasoning", AI_DEFAULTS.reasoning),
  };
}

/** The unconfigured-state defaults, exported so tests can pin them. */
function configDefaults() {
  return { ...AI_DEFAULTS };
}

/**
 * The provider's display name and endpoints for a stored id. The curated list
 * knows every id without a network round-trip; a models.dev-only id still ends
 * in the same shape, with the catalogue's own name/api and no model list.
 */
function resolveProvider(providerId, catalog) {
  const id = typeof providerId === "string" ? providerId.trim() : "";
  const catalogueList = (catalog && catalog.providers) || [];
  const list = buildProviderList(catalogueList, catalog && catalog.modelsById);
  const known = list.find((provider) => provider.id === id);
  if (known) return { ...known, models: known.models.map((model) => ({ ...model })) };
  // A models.dev-only id: the catalogue knows it, possibly under an alias.
  const dev = (catalog && catalog.providers || []).find((provider) => provider.id === id);
  const models = ((catalog && catalog.modelsById && catalog.modelsById[devIdFor(id)]) || []).map((model) => ({ ...model }));
  return {
    id,
    name: dev ? dev.name : id,
    api: (dev && dev.api) || providerApi(id, catalog),
    models,
    builtIn: false,
  };
}

/**
 * The base URL the endpoint input is filled with when `providerId` is picked.
 * A models.dev provider carries its own `api`; a curated provider that does not
 * (id aliasing a models.dev entry without `api`, e.g. OpenAI) uses the curated
 * endpoint from src/catalog.js. No catalogue at all still yields the curated
 * endpoint, so choosing a provider never leaves the endpoint blank.
 */
function providerApi(providerId, catalog) {
  const id = typeof providerId === "string" ? providerId.trim() : "";
  if (!id) return "";
  const catalogueApi = ((catalog && catalog.providers) || []).find((provider) => provider.id === id)?.api;
  if (catalogueApi) return catalogueApi;
  const builtIn = BUILTINS_BY_ID[id];
  if (builtIn) return builtIn.api;
  const dev = (catalog && catalog.providers || []).find((provider) => provider.id === devIdFor(id));
  return (dev && dev.api) || "";
}

/**
 * The model picker of the provider step, computed once so the QuickPick and the
 * conformance payload describe the same rows. With no provider it is disabled
 * and says so; the reasoning sentinel is a separate setting and stays `lowest`.
 */
function pickModelStep({ provider: providerId, catalog }) {
  const empty = !providerId || !String(providerId).trim();
  if (empty) {
    return { disabled: true, placeholder: t("providerRequiredForModel"), options: [] };
  }
  const resolved = resolveProvider(providerId, catalog);
  return {
    disabled: false,
    placeholder: t("pickModelPlaceholder", resolved.name),
    options: resolved.models.map((model) => ({ value: model.id, label: model.label })),
  };
}

async function apiKey(context) {
  const key = await context.secrets.get("dualtran.aiKey");
  if (!key) {
    const entered = await vscode.window.showInputBox({
      title: t("DualTran — AI API key"),
      prompt: t("Stored in the OS keychain via VS Code SecretStorage. Leave empty to keep the current key."),
      password: true,
      ignoreFocusOut: true,
    });
    if (!entered) throw new Error(t("No API key set (DualTran: Set AI API Key)."));
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
  // Unconfigured AI: report the localized requirement and send nothing — no
  // catalogue fetch, no key prompt, no request.
  if (cfg.engine === "ai" && !cfg.provider) {
    const error = providerRequiredError();
    error.message = t("Choose an AI provider in settings before translating.");
    throw error;
  }
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
      provider: cfg.provider,
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
    status.tooltip = text;
    status.show();
    clearTimeout(paintStatus._t);
    paintStatus._t = setTimeout(() => status.hide(), 6000);
  } else {
    status.tooltip = undefined;
    status.hide();
  }
}

/**
 * The translate entry points render this as the primary action (status bar for
 * inline / panel, command palette for replace), so an unconfigured AI setting
 * disables it and shows the requirement in its tooltip instead of letting the
 * click fail.
 */
function paintTranslateAction(actionText, ready) {
  if (!status) return;
  status.text = `${ready ? "$(globe)" : "$(lock)"} ${actionText}`;
  status.tooltip = ready ? actionText : t("Choose an AI provider in settings before translating.");
  status.show();
}

/** True when the AI engine is selected but no provider has been chosen yet. */
function aiUnconfigured() {
  const cfg = config();
  return cfg.engine === "ai" && !cfg.provider;
}

/**
 * Write the picked provider. The endpoint value follows the provider when the
 * stored endpoint is empty or is exactly what a previous provider autofilled;
 * a user-edited endpoint is never overwritten. Nothing is written for no id.
 */
async function applyProviderPick(cfg, provider, catalog) {
  if (!provider || !provider.id) return false;
  const storedEndpoint = cfg.get("ai.endpoint", "");
  const endpointWasAutofill =
    !String(storedEndpoint || "").trim() || String(storedEndpoint).trim() === providerApi(cfg.get("ai.provider", ""), catalog);
  await cfg.update("ai.provider", provider.id, vscode.ConfigurationTarget.Global);
  if (endpointWasAutofill) {
    await cfg.update("ai.endpoint", provider.api || providerApi(provider.id, catalog), vscode.ConfigurationTarget.Global);
  }
  await cfg.update("engine", "ai", vscode.ConfigurationTarget.Global);
  return true;
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
  status.command = "dualtran.translateInline";
  context.subscriptions.push(status);

  const cmd = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // The status-bar item IS the primary translate button; show it as disabled
  // (lock + tooltip) while the AI engine has no provider, and re-paint it
  // whenever the provider setting changes.
  const paintPrimary = () => paintTranslateAction(t("statusTranslateAction"), !aiUnconfigured());
  paintPrimary();
  // Re-evaluate on any settings change; a host without the event (unit stub) still works.
  if (typeof vscode.workspace.onDidChangeConfiguration === "function") {
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(() => paintPrimary()));
  }

  cmd("dualtran.translateInline", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return vscode.window.showWarningMessage(t("warnOpenFile"));
    const text = selectionOrLine(editor).trim();
    if (!text) return;
    if (aiUnconfigured()) return vscode.window.showWarningMessage(t("Choose an AI provider in settings before translating."));
    try {
      paintStatus(t("translating…"), true);
      const result = await runTranslate(context, text);
      const line = editor.selection.end.line;
      const endChar = editor.document.lineAt(line).range.end.character;
      const range = new vscode.Range(line, 0, line, endChar);
      editor.setDecorations(ghost, [{ range, renderOptions: { after: { contentText: "  " + result.replace(/\s*\n\s*/g, " ") } } }]);
      paintStatus(result.slice(0, 60) + (result.length > 60 ? "…" : ""));
    } catch (e) {
      vscode.window.showErrorMessage(t("DualTran: {0}", e && e.message ? e.message : e));
      paintStatus("");
    }
  });

  cmd("dualtran.clearInline", () => {
    vscode.window.visibleTextEditors.forEach((ed) => ed.setDecorations(ghost, []));
    paintStatus("");
  });

  cmd("dualtran.translatePanel", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return vscode.window.showWarningMessage(t("warnOpenFile"));
    const text = selectionOrLine(editor).trim();
    if (!text) return;
    if (aiUnconfigured()) return vscode.window.showWarningMessage(t("Choose an AI provider in settings before translating."));
    try {
      paintStatus(t("translating…"), true);
      const result = await runTranslate(context, text);
      showPanel(context, text, result, config().targetLanguage);
      paintStatus("");
    } catch (e) {
      vscode.window.showErrorMessage(t("DualTran: {0}", e && e.message ? e.message : e));
      paintStatus("");
    }
  });

  cmd("dualtran.replaceSelection", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    if (editor.selection.isEmpty) return vscode.window.showWarningMessage(t("warnSelectText"));
    if (aiUnconfigured()) return vscode.window.showWarningMessage(t("Choose an AI provider in settings before translating."));
    const text = editor.document.getText(editor.selection);
    try {
      const result = await runTranslate(context, text);
      await editor.edit((b) => b.replace(editor.selection, result));
    } catch (e) {
      vscode.window.showErrorMessage(t("DualTran: {0}", e && e.message ? e.message : e));
    }
  });

  cmd("dualtran.pickTarget", async () => {
    const current = config().targetLanguage;
    const pick = await vscode.window.showQuickPick(
      LANGUAGES.map(([code, label]) => ({ label: label, description: code, code })),
      { title: t("DualTran — target language") }
    );
    if (!pick) return;
    // Only a code the enum knows is ever written (or sent): anything else keeps the current one.
    const code = normalizeTargetLanguage(pick.code, current);
    if (code === pick.code) {
      await vscode.workspace.getConfiguration("dualtran").update("targetLanguage", code, vscode.ConfigurationTarget.Global);
    }
  });

  cmd("dualtran.pickProvider", async () => {
    let catalog;
    try {
      catalog = await loadCatalog(context);
    } catch (error) {
      return vscode.window.showErrorMessage(t("DualTran: could not load models.dev — {0}", error && error.message ? error.message : error));
    }
    // One list: buildProviderList already merged the built-ins into the
    // catalogue and sorted the result — render it as given, no divider. The
    // empty placeholder is a single disabled row that only shows the current
    // unconfigured state; it is not a pickable entry and there is no "None".
    const list = buildProviderList(catalog.providers, catalog.modelsById);
    const cfg = vscode.workspace.getConfiguration("dualtran");
    const current = config().provider;
    const placeholder = { label: t("providerPlaceholder"), description: "", detail: "", provider: { id: "" }, enabled: false };
    const pick = await vscode.window.showQuickPick(
      list.map((provider) => ({ label: provider.name, description: provider.id, detail: provider.api, provider, enabled: Boolean(provider.id) })),
      {
        title: t("DualTran — AI provider"),
        placeHolder: t("pickProviderPlaceholder"),
        matchOnDescription: true,
        matchOnDetail: true,
        // The empty row is the one VS Code settings shows as "Select a provider":
        // it is shown only while unconfigured, never enabled, never chosen.
        items: current ? undefined : [placeholder],
      }
    );
    if (!pick || !pick.provider.id) return;
    // Step one: the provider decides the endpoint (a user may still edit it afterwards).
    await applyProviderPick(cfg, pick.provider, catalog);

    // Step two: that provider's models, in the same alphabetical order. The
    // model step writes ai.model only — an endpoint edited in between stays.
    const modelStep = pickModelStep({ provider: pick.provider.id, catalog });
    if (modelStep.disabled) return;
    const modelPick = await vscode.window.showQuickPick(
      modelStep.options.map((model) => ({ label: model.label, description: model.value })),
      {
        title: t("pickModelTitle"),
        placeHolder: modelStep.placeholder,
        matchOnDescription: true,
      }
    );
    if (!modelPick) {
      if (modelStep.options.length === 0) {
        return vscode.window.showInformationMessage(t("DualTran: {0} — set a model", pick.provider.name));
      }
      return;
    }
    await cfg.update("ai.model", modelPick.description, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(t("DualTran: {0} — {1}", pick.provider.name, modelPick.description));
  });

  cmd("dualtran.refreshProviders", async () => {
    await fs.rm(catalogPath(context), { force: true });
    try {
      const catalog = await loadCatalog(context);
      vscode.window.showInformationMessage(t("DualTran: {0} providers loaded from models.dev.", catalog.providers.length));
    } catch (error) {
      vscode.window.showErrorMessage(t("DualTran: catalogue refresh failed — {0}", error && error.message ? error.message : error));
    }
  });

  // E2E seam: the host tests cannot type into a secret prompt, and SecretStorage
  // lives on the extension context. Registered only when the test harness sets
  // DT_E2E, so production never sees it.
  if (process.env.DT_E2E === "1") {
    cmd("dualtran.__e2e.setApiKey", async (key) => {
      await context.secrets.store("dualtran.aiKey", String(key || "e2e-key"));
    });
  }

  cmd("dualtran.setApiKey", async () => {
    const entered = await vscode.window.showInputBox({
      title: t("DualTran — AI API key"),
      prompt: t("Stored in SecretStorage (OS keychain)."),
      password: true,
      ignoreFocusOut: true,
    });
    if (entered) {
      await context.secrets.store("dualtran.aiKey", entered);
      vscode.window.showInformationMessage(t("DualTran: API key saved."));
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

module.exports = {
  activate,
  deactivate,
  normalizeTargetLanguage,
  LANGUAGES,
  TARGET_CODES,
  configDefaults,
  resolveProvider,
  providerApi,
  pickModelStep,
};
