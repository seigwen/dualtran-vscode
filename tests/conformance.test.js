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
  const l10n = { t: (message) => message };
  const stub = {
    l10n,
    window: { showQuickPick: async () => undefined, showInputBox: async () => undefined },
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback, update: async () => {} }) },
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
  const endpointWrites = (body.match(/update\(\s*"ai\.endpoint"/g) || []).length;
  assert.equal(endpointWrites, 1, `ai.endpoint is written ${endpointWrites} times; only the provider step may write it`);
  const modelPart = body.slice(body.indexOf("showQuickPick(") + 1);
  assert.ok(!/update\(\s*"ai\.endpoint"/.test(modelPart.slice(modelPart.indexOf("showQuickPick("))), "the model step clobbers the endpoint");
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
test("R5 pickModelTitle / pickModelPlaceholder ship in all 38 locales", () => {
  const extra = readJson("tests/fixtures/conformance/i18n-extra-vscode.json");
  const en = readJson("locales/en/messages.json");
  for (const key of ["pickModelTitle", "pickModelPlaceholder"]) {
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
});

// ── the SPEC 2.0.0 payload contract ───────────────────────────────────────
async function buildPayload() {
  const extra = readJson("tests/fixtures/conformance/i18n-extra-vscode.json");
  const en = readJson("locales/en/messages.json");
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

  const target = settings("targetLanguage");
  const list = buildProviderList(catalogue.providers, catalogue.modelsById);
  const currentProvider = "openai";
  const currentProviderEntry = list.find((provider) => provider.id === currentProvider);

  const reasoningOptions = [
    [{ setting: "lowest", options: ["none", "minimal", "low"], value: resolveReasoning("lowest", ["none", "minimal", "low"]) }],
    [{ setting: "lowest", options: ["minimal", "low"], value: resolveReasoning("lowest", ["minimal", "low"]) }],
    [{ setting: "lowest", options: ["low", "medium"], value: resolveReasoning("lowest", ["low", "medium"]) }],
    [{ setting: "lowest", options: [], value: resolveReasoning("lowest", []) }],
  ];

  return {
    spec: "2.0.0",
    host: "dualtran-vscode",
    language: {
      control: target.enum ? "dropdown" : "text",
      current: target.default,
      options: target.enum.map((code, index) => ({ value: code, label: `${target.enumDescriptions[index]} (${code})` })),
    },
    provider: {
      control: "quickpick",
      current: currentProvider,
      // The rendered order: one list, built-ins and models.dev interleaved by name.
      options: list.map((provider) => ({ value: provider.id, label: provider.name, source: providerSource(provider) })),
    },
    model: {
      control: "quickpick",
      selectedProvider: currentProvider,
      selectedModel: currentProviderEntry && currentProviderEntry.models[0]?.id,
      byProvider: Object.fromEntries(
        list.map((provider) => [provider.id, provider.models.map((model) => ({ value: model.id, label: model.label }))])
      ),
    },
    endpoint: {
      control: "text",
      autofill: {
        provider: currentProvider,
        providerApi: currentProviderEntry?.api,
        before: "",
        after: currentProviderEntry?.api,
        // R3: a user-edited endpoint survives a later provider switch.
        userEdited: "https://proxy.example/v1",
        afterSwitch: "https://proxy.example/v1",
      },
    },
    reasoning: {
      control: "dropdown",
      default: settings("ai.reasoning").default,
      resolved: {
        none: reasoningOptions[0],
        minimal: reasoningOptions[1],
        low: reasoningOptions[2],
        "none-declared": reasoningOptions[3],
      },
    },
    i18n: {
      locales,
      sourceLocale: "en",
      keys,
      used: ["pickModelTitle", "pickModelPlaceholder", "pickProviderTitle", "pickTargetTitle"],
      files,
    },
    static: { hits: [] },
  };
}

test("SPEC 2.0.0 conformance: self-test and the real payload", async () => {
  const validatorUrl = pathToFileURL(path.join(ROOT, "scripts", "conformance", "validate.mjs")).href;
  const { selfTest, validatePayload } = await import(validatorUrl);
  assert.ok(selfTest() >= 10, "the negative controls are not all firing");
  const config = readJson("conformance.json");
  const payload = await buildPayload();
  const summary = validatePayload(payload, config);
  assert.equal(summary.languages, settings("targetLanguage").enum.length);
  assert.equal(summary.localeCount, 38);
});

/** `npm run conformance` imports this file and calls `module.default()` (run.mjs). */
module.exports = buildPayload;
module.exports.default = buildPayload;
module.exports.buildPayload = buildPayload;
