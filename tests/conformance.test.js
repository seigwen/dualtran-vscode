"use strict";
/**
 * Host conformance for DualTran for VS Code (SPEC 2.0.0).
 *
 * Two jobs:
 *   1. assert the product rules against the real surface — package.json, the
 *      shared provider list in src/catalog.js and extension.js;
 *   2. double as the payload generator `npm run conformance` imports: the
 *      exported `buildPayload()` projects those same files into the JSON
 *      contract scripts/conformance/validate.mjs validates.
 *
 * Everything is read from disk or from the fixtures in facts/ — no network, no
 * VS Code host. The one place the host has to describe behaviour it cannot
 * execute (what pickProvider writes after each QuickPick) says so explicitly.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const pkg = readJson("package.json");
const extensionSource = readText("extension.js");
const languages = readJson("tests/fixtures/conformance/language-names.json");
const { projectCatalog, buildProviderList, resolveReasoning } = require("../src/catalog");

/** The payload's source label: the picked provider's curated or catalogue home. */
function providerSource(provider) {
  return provider.builtIn ? "built-in" : "models.dev";
}

/**
 * Load extension.js with a minimal `vscode` stub so its exports (the language
 * list and the normaliser) can be exercised outside a VS Code host.
 */
function loadExtension() {
  const Module = require("node:module");
  // l10n.t answers with the locale catalogue's English text when it knows the key,
  // so assertions can compare rendering against locales/en; `t("key")` still resolves.
  const messages = readJson("locales/en/messages.json");
  const l10n = {
    t: (message, ...args) => {
      const text = (messages[message] && messages[message].message) || message;
      return args.reduce((out, arg, index) => out.split(`{${index}}`).join(String(arg)), text);
    },
  };
  const stub = {
    l10n,
    window: {
      showQuickPick: async () => undefined,
      showInputBox: async () => undefined,
      showWarningMessage: () => undefined,
      showErrorMessage: () => undefined,
      showInformationMessage: () => undefined,
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    },
    workspace: {
      getConfiguration: () => ({ get: (_key, fallback) => fallback, update: async () => {} }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    commands: { registerCommand: () => ({ dispose() {} }) },
    StatusBarAlignment: { Right: 2 },
    ThemeColor: class {},
    DecorationRangeBehavior: { ClosedClosed: 1 },
    Range: class {},
    ViewColumn: { Beside: -2 },
    ConfigurationTarget: { Global: 1 },
  };
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") return stub;
    return original.apply(this, arguments);
  };
  try {
    const resolved = require.resolve("../extension");
    delete require.cache[resolved];
    return require("../extension");
  } finally {
    Module._load = original;
  }
}

const sample = readJson("tests/fixtures/conformance/models-dev-sample.json");
const catalogue = projectCatalog(sample);

const VSCODE_LOCALE = { zh_CN: "zh-cn", zh_TW: "zh-tw", pt_BR: "pt-br", pt_PT: "pt-pt" };
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

const settings = (id) => pkg.contributes.configuration.properties[`dualtran.${id}`];

/** The body of a command handler in extension.js, from `cmd("<id>"` to the next `cmd(`. */
function commandBody(id) {
  const start = extensionSource.indexOf(`cmd("${id}"`);
  assert.ok(start >= 0, `extension.js registers no "${id}" command`);
  const next = extensionSource.indexOf("cmd(", start + 10);
  return extensionSource.slice(start, next === -1 ? undefined : next);
}

// ── R1: target language is a dropdown; both paths reject unknown codes ─────
test("R1 package.json turns dualtran.targetLanguage into a dropdown", () => {
  const target = settings("targetLanguage");
  assert.ok(target, "dualtran.targetLanguage setting is missing");
  assert.ok(Array.isArray(target.enum), "dualtran.targetLanguage has no enum");
  assert.ok(target.enum.length >= 38, `enum has ${target.enum.length} codes, expected >= 38`);
  assert.ok(Array.isArray(target.enumDescriptions), "dualtran.targetLanguage has no enumDescriptions");
  assert.equal(target.enumDescriptions.length, target.enum.length, "enumDescriptions must match enum");
  assert.equal(new Set(target.enum).size, target.enum.length, "enum repeats a code");
  assert.ok(target.enum.includes(target.default), "the default is not one of the enum values");
  for (const [code, name] of Object.entries(languages)) {
    assert.ok(target.enum.includes(code), `tests/fixtures/conformance/language-names.json code "${code}" is missing from the enum`);
    assert.equal(
      target.enumDescriptions[target.enum.indexOf(code)],
      name,
      `enumDescriptions must carry the English name of "${code}"`
    );
  }
  for (const description of target.enumDescriptions) {
    assert.ok(description.trim().length > 0, "an enumDescriptions entry is empty");
  }
});

test("R1 the target-language picker and the setting reject unknown codes", () => {
  // The QuickPick offers exactly the enum (no free text) and nothing else …
  const { normalizeTargetLanguage, LANGUAGES, TARGET_CODES } = loadExtension();
  assert.deepEqual(
    LANGUAGES.map(([code]) => code),
    settings("targetLanguage").enum,
    "the QuickPick list must BE the enum"
  );
  assert.ok(!TARGET_CODES.has("auto"), "a target-language picker must not offer auto");
  // … and anything outside it falls back to the current/default value.
  assert.equal(normalizeTargetLanguage("ja", "zh-CN"), "ja", "a known code must survive");
  assert.equal(normalizeTargetLanguage("klingon", "zh-CN"), "zh-CN", "an unknown code falls back");
  assert.equal(normalizeTargetLanguage("", "en"), "en", "an empty code falls back");
  assert.equal(normalizeTargetLanguage(undefined, "ja"), "ja", "a missing code falls back");
  assert.equal(normalizeTargetLanguage("zh-cn", "ja"), "ja", "a code outside the enum (wrong case) falls back");
  const pickBody = commandBody("dualtran.pickTarget");
  assert.ok(pickBody.includes("normalizeTargetLanguage("), "pickTarget writes the picked code unchecked");
  assert.ok(extensionSource.includes("targetLanguage: normalizeTargetLanguage("), "config() does not validate the stored code");
});

// ── R2: one alphabetical provider list, then a model QuickPick ─────────────
test("R2 buildProviderList renders one list sorted by name (no builtIn grouping)", () => {
  const list = buildProviderList(catalogue.providers, catalogue.modelsById);
  assert.ok(list.length >= 5, `only ${list.length} providers`);
  for (let i = 1; i < list.length; i += 1) {
    assert.ok(collator.compare(list[i - 1].name, list[i].name) <= 0, `"${list[i - 1].name}" before "${list[i].name}"`);
  }
  assert.equal(new Set(list.map((provider) => provider.id)).size, list.length, "duplicate provider id");
  assert.ok(list.some((provider) => provider.builtIn), "no built-in provider left");
  assert.ok(list.some((provider) => !provider.builtIn), "models.dev providers were dropped");
  // The curated ids survive; a built-in still pulls its models from its dev twin.
  assert.ok(list.some((provider) => provider.id === "google-gemini"), "google-gemini lost its place");
  const moons = list.filter((provider) => provider.id === "moonshot" || provider.id === "moonshotai");
  assert.equal(moons.length, 1, "moonshot ↔ moonshotai must not repeat");
  const openai = list.find((provider) => provider.id === "openai");
  assert.ok(openai.models.some((model) => model.id === "gpt-4o"), "openai lost its catalogue models");
  // Source labels for the payload: one per rendered row, built-in vs catalogue.
  for (const provider of list) {
    assert.equal(providerSource(provider), provider.builtIn ? "built-in" : "models.dev");
  }
});

test("R2 pickProvider has no divider and opens a model QuickPick", () => {
  assert.ok(!/QuickPickItemKind\s*\.\s*Separator/.test(extensionSource), "extension.js still inserts a Separator");
  const body = commandBody("dualtran.pickProvider");
  assert.ok(!/Separator/.test(body), "pickProvider still builds a divider item");
  const dividerLiterals = ["More (models.dev)"];
  for (const literal of dividerLiterals) {
    assert.ok(!extensionSource.includes(literal), `extension.js still contains the literal "${literal}"`);
  }
  const picks = body.match(/showQuickPick\(/g) || [];
  assert.equal(picks.length, 2, `pickProvider calls showQuickPick ${picks.length} times, expected 2 (provider, then model)`);
  const modelPicker = body.match(/pickModel|buildModelList|modelItems/);
  assert.ok(modelPicker, "pickProvider has no named model-picker step");
  assert.ok(!/cmd\("dualtran\.pickModel"/.test(extensionSource), "the model step must stay inside pickProvider");
  assert.ok(
    !pkg.contributes.commands.some((command) => command.command === "dualtran.pickModel"),
    "a new command was contributed instead of a second QuickPick"
  );
  for (const key of ["pickModelTitle", "pickModelPlaceholder"]) {
    assert.ok(
      (body.match(new RegExp(`t\\("${key}"`, "g")) || []).length > 0 || extensionSource.match(new RegExp(`t\\("${key}"`)),
      `extension.js never renders ${key}`
    );
  }
});

test("R2 every provider offers a sorted model list, custom ids typed in the setting", () => {
  const list = buildProviderList(catalogue.providers, catalogue.modelsById);
  for (const provider of list) {
    assert.ok(provider.models.length > 0, `${provider.id} has no model to offer`);
    const labels = provider.models.map((model) => model.label);
    for (let i = 1; i < labels.length; i += 1) {
      assert.ok(collator.compare(labels[i - 1], labels[i]) <= 0, `${provider.id}: "${labels[i - 1]}" before "${labels[i]}"`);
    }
    assert.equal(new Set(provider.models.map((model) => model.id)).size, provider.models.length, `${provider.id}: duplicate model`);
  }
  // The escape hatch stays a free string, declared as a platform limit.
  const model = settings("ai.model");
  assert.equal(model.type, "string", "dualtran.ai.model must stay a free string for custom ids");
  assert.ok(!model.enum, "dualtran.ai.model cannot enumerate a dynamic catalogue");
  const config = readJson("conformance.json");
  assert.ok(config.platformLimits.some((limit) => limit.rule === "R2" && /models\.dev/.test(limit.reason)), "the R2 model-picker limit is not declared");
});

// ── R3 / R4: unchanged behaviour, kept honest ─────────────────────────────
test("R3 the endpoint stays an editable setting and a model pick keeps it", () => {
  assert.equal(settings("ai.endpoint").type, "string", "dualtran.ai.endpoint must stay a text input");
  assert.ok(!settings("ai.endpoint").enum, "the endpoint must stay free-form");
  const body = commandBody("dualtran.pickProvider");
  const endpointWrites = (body.match(/update\(/g) || []).length;
  assert.ok(endpointWrites >= 1, "pickProvider writes nothing");
  // The only place the endpoint is written is applyProviderPick, which fills its *value*
  // with the provider API base (never overwrites a user-edited endpoint).
  const pickStep = extensionSource.slice(extensionSource.indexOf("async function applyProviderPick"));
  const applyBody = pickStep.slice(0, pickStep.indexOf("\n}\n"));
  assert.equal((applyBody.match(/update\(\s*"ai\.endpoint"/g) || []).length, 1, "ai.endpoint must be written once, in applyProviderPick");
  assert.ok(/provider\.api|providerApi\(/.test(applyBody), "the endpoint write is not the provider's API base");
  assert.ok(body.includes("applyProviderPick(cfg, pick.provider, catalog)"), "pickProvider bypasses applyProviderPick");
  const modelPart = body.slice(body.indexOf("pickModelStep("));
  assert.ok(!/update\(\s*"ai\.endpoint"/.test(modelPart), "the model step clobbers the endpoint");
});

test("R4 reasoning keeps the lowest sentinel and none → minimal → low", () => {
  const reasoning = settings("ai.reasoning");
  assert.equal(reasoning.default, "lowest");
  assert.deepEqual(reasoning.enum.slice(0, 4), ["lowest", "default", "none", "minimal"]);
  assert.equal(resolveReasoning("lowest", ["none", "minimal", "low"]), "none");
  assert.equal(resolveReasoning("lowest", ["minimal", "low"]), "minimal");
  assert.equal(resolveReasoning("lowest", ["low", "medium"]), "low");
});

// ── R5: the new picker strings exist in every catalogue ───────────────────
const EMPTY_STATE_KEYS = ["providerPlaceholder", "providerRequiredForModel", "providerRequiredError"];

test("R5 pickModelTitle / pickModelPlaceholder and the SPEC 2.1 provider strings ship in all 38 locales", () => {
  const extra = readJson("tests/fixtures/conformance/i18n-extra-vscode.json");
  const en = readJson("locales/en/messages.json");
  const keys = ["pickModelTitle", "pickModelPlaceholder", ...EMPTY_STATE_KEYS];
  for (const key of keys) {
    assert.equal(typeof en[key]?.message, "string", `locales/en is missing ${key}`);
    assert.ok(en[key].description, `locales/en ${key} has no description`);
    for (const [code, value] of Object.entries(extra[key])) {
      const catalogueLocale = readJson(`locales/${code}/messages.json`);
      assert.equal(catalogueLocale[key]?.message, value, `locales/${code} is missing ${key}`);
      if (code === "en") continue;
      const vs = VSCODE_LOCALE[code] || code;
      assert.equal(readJson(`package.nls.${vs}.json`)[key], value, `package.nls.${vs}.json is missing ${key}`);
      assert.equal(
        readJson(`l10n/bundle.l10n.${vs}.json`)[en[key].message],
        value,
        `l10n/bundle.l10n.${vs}.json is missing ${key}`
      );
    }
    assert.equal(Object.keys(extra[key]).length, 37, `${key} must translate all 37 non-English locales`);
  }
  // The three SPEC 2.1 strings carry the agreed English wording …
  assert.equal(en.providerPlaceholder.message, "Select a provider");
  assert.equal(en.providerRequiredForModel.message, "Select a provider first");
  assert.equal(en.providerRequiredError.message, "Choose an AI provider in settings before translating.");
  // … and the agreed Chinese wording.
  assert.equal(readJson("locales/zh_CN/messages.json").providerPlaceholder.message, "请选择 AI 提供商");
  assert.equal(readJson("locales/zh_CN/messages.json").providerRequiredForModel.message, "请先选择提供商");
  assert.equal(readJson("locales/zh_CN/messages.json").providerRequiredError.message, "翻译前请先在设置中选择 AI 提供商。");
  for (const code of ["zh_CN", "zh_TW"]) {
    for (const key of EMPTY_STATE_KEYS) assert.ok(readJson(`locales/${code}/messages.json`)[key].message, `${code}: ${key}`);
  }
});

// ── SPEC 2.1: the provider setting is an enum with an empty default ───────
test("SPEC 2.1 dualtran.ai.provider is a dropdown whose empty item is labelled by enumItemLabels", () => {
  const provider = settings("ai.provider");
  assert.equal(provider.default, "", "a fresh install must not pick a provider");
  assert.ok(Array.isArray(provider.enum), "dualtran.ai.provider has no enum");
  assert.equal(provider.enum[0], "", "the empty placeholder must be the first enum item");
  assert.ok(Array.isArray(provider.enumItemLabels), "dualtran.ai.provider has no enumItemLabels");
  assert.equal(provider.enumItemLabels.length, provider.enum.length, "enumItemLabels must match enum");
  // The empty item's label is the providerPlaceholder string, resolved through the manifest.
  const nls = readJson("package.nls.json");
  const labelled = /^%([^%]+)%$/.exec(provider.enumItemLabels[0]);
  assert.ok(labelled, "the empty item must be labelled by a %key%");
  assert.equal(nls[labelled[1]], readJson("locales/en/messages.json").providerPlaceholder.message, `%${labelled[1]}% is not the placeholder string`);
  assert.deepEqual(provider.enumDescriptions, undefined, "enumDescriptions would label the rows again");
  // The enum is the payload list: one alphabetical run of providers after "".
  const list = buildProviderList(catalogue.providers, catalogue.modelsById);
  assert.deepEqual(provider.enum.slice(1), list.map((entry) => entry.id), "the enum must BE the provider list");
  for (let i = 2; i < provider.enum.length; i += 1) {
    assert.ok(
      collator.compare(list[i - 2].name, list[i - 1].name) <= 0,
      `enum order drifted from the alphabetical provider list at ${provider.enum[i]}`
    );
  }
  const extra = readJson("tests/fixtures/conformance/i18n-extra-vscode.json");
  assert.ok(extra.providerPlaceholder, "i18n-extra-vscode.json carries no providerPlaceholder translations");
});

// ── SPEC 2.1: empty endpoint / model defaults, no OpenAI leftovers ────────
test("SPEC 2.1 a fresh install has no endpoint and no model, and the empty state names no OpenAI default", () => {
  assert.equal(settings("ai.endpoint").default, "", "the endpoint must start empty");
  assert.equal(settings("ai.endpoint").type, "string", "the endpoint stays an editable input");
  assert.equal(settings("ai.model").default, "", "the model must start empty");
  assert.equal(settings("ai.model").type, "string", "the model stays a free string");
  const provider = settings("ai.provider");
  for (const [index, id] of provider.enum.entries()) {
    if (!id) continue;
    assert.ok(id.trim().length > 0, `enum item ${index} is blank`);
    assert.ok(provider.enumItemLabels[index].trim().length > 0, `enum item ${id} has no label`);
  }
  // What a fresh install stores, i.e. what runTranslate() reads: no OpenAI name anywhere.
  const defaults = loadExtension().configDefaults();
  assert.deepEqual(defaults, { provider: "", endpoint: "", model: "", reasoning: "lowest" });
  const emptyState = JSON.stringify({
    provider: provider.default,
    endpoint: settings("ai.endpoint").default,
    model: settings("ai.model").default,
    reasoning: settings("ai.reasoning").default,
  }).toLowerCase();
  for (const banned of ["openai", "gpt-4o", "api.openai.com", "custom"]) {
    assert.ok(!emptyState.includes(banned), `the empty state still mentions "${banned}"`);
  }
  assert.ok(provider.enum.includes("openai"), "openai must stay pickable once the user chooses it");
  const source = ["package.json", "extension.js", "src/translate.js"].map(readText).join("\n");
  for (const fallback of ['|| "openai"', "|| CUSTOM_PROVIDER"]) {
    assert.ok(!source.includes(fallback), `a request path still falls back with ${fallback}`);
  }
});

// ── SPEC 2.1: choosing a provider is the only way out of the empty state ──
test("SPEC 2.1 the provider picker cannot return to the empty placeholder and offers no None item", () => {
  const body = commandBody("dualtran.pickProvider");
  assert.ok(body.includes("enabled: Boolean(provider.id)"), "the placeholder row must be disabled");
  assert.ok(!/label:\s*"None"|name:\s*"None"/.test(body), "the picker grew a None item");
  assert.ok(body.includes("if (!pick || !pick.provider.id) return;"), "an empty id must not be written back");
  assert.ok(extensionSource.includes("endpointWasAutofill"), "the endpoint autofill rule is not tracked");
});

/** The 4 provider ids the manifest can name without a network round-trip. */
const MANIFEST_PROVIDERS = ["deepseek", "google-gemini", "moonshot", "ollama", "openai", "zhipu"];
/** The provider API bases the extension must know offline (see providerApi). */
const OFFLINE_ENDPOINTS = {
  deepseek: "https://api.deepseek.com/v1",
  "google-gemini": "https://generativelanguage.googleapis.com/v1beta/openai",
  moonshot: "https://api.moonshot.ai/v1",
  ollama: "http://localhost:11434/v1",
  openai: "https://api.openai.com/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
};

// ── SPEC 2.1: choosing a provider fills the endpoint value with its API base ──
test("SPEC 2.1 the endpoint value becomes the provider API base, and the API base is known offline", () => {
  const extension = loadExtension();
  const list = buildProviderList(catalogue.providers, catalogue.modelsById);
  for (const provider of list) {
    const api = extension.providerApi(provider.id, catalogue);
    assert.equal(typeof api, "string", `${provider.id}: no API base`);
    assert.ok(api.trim().length > 0, `${provider.id}: the endpoint would be left blank after a pick`);
    // The provider's endpoint is whatever the catalogue ships for it, so the value
    // and the API base can never disagree (a built-in keeps its curated endpoint
    // when models.dev has none, as for OpenAI/Anthropic).
    const fromCatalogue = (catalogue.providers.find((entry) => entry.id === provider.id) || {}).api;
    if (fromCatalogue) assert.equal(api, fromCatalogue, `${provider.id}: the catalogue endpoint must win`);
    else if (provider.builtIn) assert.equal(api, provider.api, `${provider.id}: the curated endpoint must win`);
    // With no catalogue at all (offline, cache miss) the curated ids still resolve.
    if (OFFLINE_ENDPOINTS[provider.id]) {
      assert.equal(extension.providerApi(provider.id, null), OFFLINE_ENDPOINTS[provider.id], `${provider.id}: no offline endpoint`);
    }
  }
  assert.equal(extension.providerApi("", catalogue), "", "no provider must not autofill an endpoint");
  assert.equal(extension.providerApi("no-such-provider", catalogue), "", "an unknown provider has no endpoint to offer");
  for (const id of MANIFEST_PROVIDERS) {
    assert.ok(list.some((provider) => provider.id === id), `the manifest names "${id}" but the list does not`);
    assert.ok(extension.providerApi(id, catalogue), `${id}: no API base`);
  }
  // The model step is enabled exactly when a provider is set, and lists that provider's models.
  const step = extension.pickModelStep({ provider: "deepseek", catalog: catalogue });
  const expected = list.find((provider) => provider.id === "deepseek").models.map((model) => model.id);
  assert.equal(step.disabled, false);
  assert.deepEqual(step.options.map((option) => option.value), expected, "the model step must list the provider's models");
  assert.equal(extension.pickModelStep({ provider: "", catalog: catalogue }).disabled, true);
});

// ── SPEC 2.1: an unconfigured AI translation is localized, sends nothing ──
test("SPEC 2.1 runTranslate refuses the unconfigured state with the localized providerRequiredError", async () => {
  const Module = require("node:module");
  const en = readJson("locales/en/messages.json");
  const warnings = [];
  const calls = [];
  const stub = {
    l10n: { t: (message) => (en[message] && en[message].message) || message },
    window: {
      showWarningMessage: (message) => warnings.push(message),
      showErrorMessage: (message) => warnings.push(message),
      showInformationMessage: () => undefined,
      showQuickPick: async () => undefined,
      showInputBox: async () => undefined,
      createTextEditorDecorationType: () => ({ dispose() {} }),
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
      createWebviewPanel: () => ({ webview: {}, reveal() {}, onDidDispose() {} }),
    },
    workspace: {
      // Engine "ai", and every AI setting at its unconfigured default.
      getConfiguration: () => ({ get: (_key, fallback) => (_key === "engine" ? "ai" : fallback), update: async () => {} }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    commands: { registerCommand: (id, fn) => ({ id, fn, dispose() {} }) },
    StatusBarAlignment: { Right: 2 },
    ThemeColor: class {},
    DecorationRangeBehavior: { ClosedClosed: 1 },
    Range: class {},
    ViewColumn: { Beside: -2 },
    ConfigurationTarget: { Global: 1 },
  };
  const original = Module._load;
  const globalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return { ok: true, json: async () => ({}) };
  };
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") return stub;
    return original.apply(this, arguments);
  };
  try {
    const resolved = require.resolve("../extension");
    delete require.cache[resolved];
    const ext = require("../extension");
    const context = { subscriptions: [], secrets: { get: async () => "k", store: async () => {} }, globalStorageUri: { fsPath: "/nonexistent/dualtran-e2e" } };
    ext.activate(context);
    const inline = context.subscriptions.find((sub) => sub.id === "dualtran.translateInline");
    const editor = {
      selection: { isEmpty: false },
      document: { getText: () => "hello", lineAt: () => ({ text: "hello", range: { end: { character: 5 } } }) },
      setDecorations: () => calls.push("decoration"),
    };
    stub.window.activeTextEditor = editor;
    await inline.fn();
    ext.deactivate();
  } finally {
    Module._load = original;
    global.fetch = globalFetch;
  }
  assert.deepEqual(calls, [], "an unconfigured translation must not paint anything");
  assert.deepEqual(warnings, [en.providerRequiredError.message], "the warning must be the localized providerRequiredError");
  assert.equal(fetchCalls, 0, "no network request while unconfigured");
});

// ── the SPEC 2.1 payload contract ─────────────────────────────────────────
async function buildPayload() {
  const extra = readJson("tests/fixtures/conformance/i18n-extra-vscode.json");
  const en = readJson("locales/en/messages.json");
  const packageNls = readJson("package.nls.json");
  const keys = Object.keys(en);
  const locales = fs
    .readdirSync(path.join(ROOT, "locales"))
    .filter((code) => fs.existsSync(path.join(ROOT, "locales", code, "messages.json")))
    .sort();
  const files = {};
  for (const code of locales) {
    const catalogueLocale = readJson(`locales/${code}/messages.json`);
    files[code] = Object.fromEntries(keys.map((key) => [key, catalogueLocale[key]?.message]));
  }

  const extension = loadExtension();
  assert.strictEqual(typeof extension.configDefaults, "function", "extension.js exports no configDefaults()");
  assert.strictEqual(typeof extension.pickModelStep, "function", "extension.js exports no pickModelStep()");

  const target = settings("targetLanguage");
  const providerSetting = settings("ai.provider");
  const reasoningSetting = settings("ai.reasoning");
  const list = buildProviderList(catalogue.providers, catalogue.modelsById);
  const providerOptions = list.map((provider) => ({ value: provider.id, label: provider.name, source: providerSource(provider) }));

  // The unconfigured surface, read from the extension's own defaults.
  const defaults = extension.configDefaults();
  const placeholderLabel = en.providerPlaceholder.message;
  assert.equal(
    providerSetting.enumItemLabels[providerSetting.enum.indexOf("")],
    `%${Object.keys(packageNls).find((key) => packageNls[key] === placeholderLabel) || "providerPlaceholder"}%`,
    "the empty enum item is not labelled with the placeholder string"
  );
  const emptyModel = extension.pickModelStep({ provider: "", catalog: catalogue });
  assert.equal(emptyModel.disabled, true, "the model step must be disabled while unconfigured");
  assert.equal(emptyModel.placeholder, en.providerRequiredForModel.message, "the disabled model step loses its placeholder");

  // The configured surface: anthropic through the same model step.
  // models.dev's own entry for Anthropic carries no `api` (the SDK infers it), so the
  // offline endpoint table src/catalog.js exports is what fills the value.
  const configuredProvider = "anthropic";
  const configuredApi = extension.providerApi(configuredProvider, catalogue);
  assert.ok(/^https?:\/\//.test(configuredApi), "anthropic has no API base the endpoint could be filled with");
  const configuredModel = extension.pickModelStep({ provider: configuredProvider, catalog: catalogue });

  const reasoningOptions = [
    [{ setting: "lowest", options: ["none", "minimal", "low"], value: resolveReasoning("lowest", ["none", "minimal", "low"]) }],
    [{ setting: "lowest", options: ["minimal", "low"], value: resolveReasoning("lowest", ["minimal", "low"]) }],
    [{ setting: "lowest", options: ["low", "medium"], value: resolveReasoning("lowest", ["low", "medium"]) }],
    [{ setting: "lowest", options: [], value: resolveReasoning("lowest", []) }],
  ];
  const resolved = {
    none: reasoningOptions[0],
    minimal: reasoningOptions[1],
    low: reasoningOptions[2],
    "none-declared": reasoningOptions[3],
  };
  const byProvider = Object.fromEntries(
    list.map((provider) => [provider.id, provider.models.map((model) => ({ value: model.id, label: model.label }))])
  );

  return {
    spec: "2.1.0",
    host: "dualtran-vscode",
    language: {
      control: target.enum ? "dropdown" : "text",
      current: target.default,
      options: target.enum.map((code, index) => ({ value: code, label: `${target.enumDescriptions[index]} (${code})` })),
    },
    // Unconfigured: provider.current "" is represented by a disabled, selected placeholder
    // that is NOT part of provider.options.
    provider: {
      control: "select",
      current: defaults.provider,
      placeholder: { value: "", label: placeholderLabel, disabled: true, selected: defaults.provider === "" },
      fallback: "",
      options: providerOptions,
    },
    model: {
      control: "select",
      disabled: emptyModel.disabled,
      selectedProvider: "",
      selectedModel: "",
      options: [],
      byProvider,
    },
    endpoint: {
      control: "input",
      current: defaults.endpoint,
      placeholder: "https://",
      autofill: {
        provider: configuredProvider,
        providerApi: configuredApi,
        before: "",
        // R3: the endpoint *value* becomes the provider API base on a pick.
        after: configuredApi,
        // R3: a user-edited endpoint survives a later provider switch.
        userEdited: "https://proxy.example/v1",
        afterSwitch: "https://proxy.example/v1",
      },
    },
    reasoning: {
      control: "select",
      disabled: true,
      default: reasoningSetting.default,
      resolved,
    },
    // The configured state, from the same settings objects and the same model step.
    configured: {
      provider: { control: "select", current: configuredProvider, placeholder: { value: "", label: placeholderLabel, disabled: true, selected: false }, fallback: "" },
      model: {
        control: "select",
        disabled: configuredModel.disabled,
        selectedProvider: configuredProvider,
        selectedModel: configuredModel.options[0]?.value,
        options: configuredModel.options,
        byProvider,
      },
      endpoint: { control: "input", current: configuredApi, placeholder: "https://" },
      reasoning: { control: "select", disabled: false, default: reasoningSetting.default, resolved },
    },
    i18n: {
      locales,
      sourceLocale: "en",
      keys,
      used: [
        "pickModelTitle",
        "pickModelPlaceholder",
        "pickProviderTitle",
        "pickTargetTitle",
        ...EMPTY_STATE_KEYS,
      ],
      files,
    },
    static: { hits: [] },
  };
}

test("SPEC 2.1 conformance: self-test and the real two-state payload", async () => {
  const validatorUrl = pathToFileURL(path.join(ROOT, "scripts", "conformance", "validate.mjs")).href;
  const { selfTest, validatePayload } = await import(validatorUrl);
  assert.ok(selfTest() >= 15, "the negative controls are not all firing");
  const config = readJson("conformance.json");
  assert.equal(config.spec, "2.1.0", "conformance.json does not target SPEC 2.1.0");
  const payload = await buildPayload();
  const summary = validatePayload(payload, config);
  assert.equal(summary.languages, settings("targetLanguage").enum.length);
  assert.equal(summary.localeCount, 38);
  // The configured half passes the same rules with placeholder.selected = false.
  const { configured } = payload;
  const configuredState = {
    ...payload,
    provider: { ...configured.provider, options: payload.provider.options },
    model: configured.model,
    endpoint: { ...configured.endpoint, autofill: payload.endpoint.autofill },
    reasoning: configured.reasoning,
  };
  delete configuredState.configured;
  const configuredSummary = validatePayload(configuredState, config);
  assert.equal(configuredSummary.providers, payload.provider.options.length);
});

/** `npm run conformance` imports this file and calls `module.default()` (run.mjs). */
module.exports = buildPayload;
module.exports.default = buildPayload;
module.exports.buildPayload = buildPayload;
