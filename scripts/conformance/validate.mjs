#!/usr/bin/env node
/**
 * DualTran host conformance validator (SPEC 2.0.0).
 *
 * Usage:
 *   node validate.mjs <payload.json>
 *   cat payload.json | node validate.mjs
 *   node validate.mjs --self-test
 *   node validate.mjs --print-schema
 *
 * The validator is deliberately dependency-free and stack-agnostic: every host
 * emits the same JSON contract from its real settings surface, and this file is
 * the only place the product rules live. Keep the SHA256 identical in every
 * repository (DualTran-manage/scripts/sync-conformance-kit.mjs enforces it).
 */

export const SPEC_VERSION = "2.0.0";

const PICKERS = new Set([
  "select",
  "dropdown",
  "quickpick",
  "list",
  "native-picker",
  "manifest-dropdown",
]);
const TEXT_CONTROLS = new Set(["text", "input", "textfield"]);
const CUSTOM_LABEL = /custom|自定义|自訂|カスタム|사용자/i;
const DIVIDER_LABEL = /(^|\s)(more|其他|更多|その他|기타)(\s|$)|\u2500{2,}|separator|divider/i;

export class ConformanceError extends Error {
  constructor(rule, message, detail) {
    super(`[${rule}] ${message}`);
    this.name = "ConformanceError";
    this.rule = rule;
    this.detail = detail;
  }
}

function fail(rule, message, detail) {
  throw new ConformanceError(rule, message, detail);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function labelOf(option) {
  return String(option?.label ?? option?.text ?? option?.title ?? option?.value ?? "").trim();
}

function valueOf(option) {
  return String(option?.value ?? option?.id ?? "").trim();
}

/** The free-text model entry is an action, not a catalogue row: it belongs last. */
function isCustomModelOption(option) {
  return /^__custom/i.test(valueOf(option)) || /^custom( model)?$/i.test(labelOf(option));
}

function uniqueBy(list, keyOf, rule, what) {
  const seen = new Set();
  for (const item of list) {
    const key = keyOf(item);
    if (!key) fail(rule, `${what} has an empty value`, item);
    if (seen.has(key)) fail(rule, `${what} contains duplicate value "${key}"`, { key });
    seen.add(key);
  }
}

function collator() {
  return new Intl.Collator("en", { numeric: true, sensitivity: "base" });
}

function assertSortedByLabel(list, rule, what) {
  const compare = collator();
  for (let i = 1; i < list.length; i += 1) {
    const previous = labelOf(list[i - 1]);
    const current = labelOf(list[i]);
    if (compare.compare(previous, current) > 0) {
      fail(rule, `${what} is not alphabetical: "${previous}" appears before "${current}"`, {
        index: i,
      });
    }
  }
}

function normalizeBase(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/+$/, "");
}

function placeholderTokens(text) {
  return new Set([...String(text).matchAll(/\{([A-Z][A-Z0-9_]*)\}/g)].map((match) => match[1]));
}

function isCjk(text) {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(String(text));
}

const PICKER_RULES = {
  language: "R1",
  provider: "R2",
  model: "R2",
  reasoning: "R4",
};

function limitsFor(config, rule) {
  const limits = asArray(config?.platformLimits).filter((entry) => entry?.rule === rule);
  return limits.reduce((merged, entry) => ({ ...merged, ...entry }), {});
}

export function validatePayload(payload, config = {}) {
  if (!isObject(payload)) fail("SPEC", "payload is not an object");
  if (payload.spec !== SPEC_VERSION) {
    fail("SPEC", `payload spec ${JSON.stringify(payload.spec)} does not match ${SPEC_VERSION}`);
  }
  if (!String(payload.host || "").trim()) fail("SPEC", "payload.host is required");

  // ── R1: target language picker ────────────────────────────────────────────
  const language = payload.language;
  if (!isObject(language)) fail("R1", "language section is missing");
  const languageLimit = limitsFor(config, "R1");
  if (!PICKERS.has(language.control)) {
    fail("R1", `target language must be a picker, got "${language.control}"`, { control: language.control });
  }
  const languageOptions = asArray(language.options);
  const minLanguages = Number(languageLimit.minOptions ?? 30);
  if (languageOptions.length < minLanguages) {
    fail("R1", `target language picker has ${languageOptions.length} options (< ${minLanguages})`);
  }
  uniqueBy(languageOptions, valueOf, "R1", "language options");
  if (!languageOptions.some((option) => valueOf(option) === String(language.current ?? "").trim())) {
    fail("R1", `current target language "${language.current}" is not in the picker`);
  }
  const readable = languageOptions.filter((option) => labelOf(option) !== valueOf(option)).length;
  if (readable < Math.ceil(languageOptions.length * 0.9)) {
    fail("R1", "language options expose raw codes instead of human-readable labels");
  }
  if (languageOptions.some((option) => /^auto$/i.test(valueOf(option)) && labelOf(option) === "auto")) {
    // "auto" is a source-language concept; a target list may not start with it.
    fail("R1", "target language list must not offer auto");
  }

  // ── R2: one alphabetical provider list, no divider ───────────────────────
  const provider = payload.provider;
  if (!isObject(provider)) fail("R2", "provider section is missing");
  if (!PICKERS.has(provider.control)) {
    fail("R2", `provider must be a picker, got "${provider.control}"`);
  }
  const providerOptions = asArray(provider.options);
  if (providerOptions.length < 5) fail("R2", `provider picker has only ${providerOptions.length} options`);
  uniqueBy(providerOptions, valueOf, "R2", "provider options");
  for (const option of providerOptions) {
    if (option.disabled === true) {
      fail("R2", `provider picker contains a disabled entry "${labelOf(option)}" (divider or placeholder)`);
    }
    if (DIVIDER_LABEL.test(labelOf(option))) {
      fail("R2", `provider picker contains a divider label "${labelOf(option)}"`);
    }
  }
  const nonCustom = providerOptions.filter((option) => option.source !== "custom");
  const custom = providerOptions.filter((option) => option.source === "custom");
  if (custom.length) {
    const tail = providerOptions.slice(-custom.length).map(valueOf);
    if (tail.some((value, index) => value !== valueOf(custom[index]))) {
      fail("R2", "custom providers must be the last entries");
    }
  }
  if (custom.some((option) => nonCustom.some((entry) => valueOf(entry) === valueOf(option)))) {
    fail("R2", "custom provider ids overlap catalogue ids");
  }
  assertSortedByLabel(nonCustom, "R2", "provider list");
  if (!nonCustom.some((option) => option.source === "built-in")) {
    fail("R2", "provider list has no built-in provider");
  }
  const providerSourceLimit = limitsFor(config, "R2");
  if (!providerSourceLimit.allowBuiltInOnly && !nonCustom.some((option) => option.source === "models.dev")) {
    fail("R2", "provider list has no models.dev provider (catalogue not merged)");
  }

  const model = payload.model;
  if (!isObject(model)) fail("R2", "model section is missing");
  if (!PICKERS.has(model.control)) fail("R2", `model must be a picker, got "${model.control}"`);
  const byProvider = model.byProvider;
  if (!isObject(byProvider) || Object.keys(byProvider).length === 0) {
    fail("R2", "model.byProvider is empty");
  }
  for (const [providerId, options] of Object.entries(byProvider)) {
    const list = asArray(options);
    if (list.length === 0) fail("R2", `provider "${providerId}" has an empty model list`);
    uniqueBy(list, valueOf, "R2", `models for ${providerId}`);
    const customModels = list.filter(isCustomModelOption);
    const catalogueModels = list.filter((option) => !isCustomModelOption(option));
    assertSortedByLabel(catalogueModels, "R2", `models for ${providerId}`);
    if (customModels.length) {
      const tail = list.slice(-customModels.length).map(valueOf);
      if (tail.some((value, index) => value !== valueOf(customModels[index]))) {
        fail("R2", `custom model entries must be last for "${providerId}"`);
      }
    }
    const providerEntry = providerOptions.find((option) => valueOf(option) === providerId);
    if (!providerEntry) {
      fail("R2", `model.byProvider has "${providerId}" but the provider picker does not`);
    }
  }
  if (model.selectedProvider && !byProvider[model.selectedProvider]) {
    fail("R2", `selected provider "${model.selectedProvider}" has no model list`);
  }
  if (model.selectedProvider && model.selectedModel) {
    const selected = asArray(byProvider[model.selectedProvider]);
    if (!selected.some((option) => valueOf(option) === String(model.selectedModel))) {
      const customAllowed = selected.some((option) => /^__custom/.test(valueOf(option)));
      if (!customAllowed) {
        fail("R2", `selected model "${model.selectedModel}" is absent and no custom entry exists`);
      }
    }
  }

  // ── R3: endpoint autofill, editable ──────────────────────────────────────
  const endpoint = payload.endpoint;
  if (!isObject(endpoint)) fail("R3", "endpoint section is missing");
  if (!TEXT_CONTROLS.has(endpoint.control)) {
    fail("R3", `endpoint must remain an editable text input, got "${endpoint.control}"`);
  }
  const autofill = endpoint.autofill;
  if (!isObject(autofill)) fail("R3", "endpoint.autofill is missing");
  const after = normalizeBase(autofill.after);
  if (!/^https?:\/\//i.test(after)) {
    fail("R3", `endpoint was not filled with a URL after choosing a provider (got "${autofill.after}")`);
  }
  if (autofill.providerApi && normalizeBase(autofill.providerApi) !== after) {
    fail("R3", `endpoint "${after}" does not match provider API "${normalizeBase(autofill.providerApi)}"`);
  }
  if (autofill.userEdited) {
    if (normalizeBase(autofill.afterSwitch) !== normalizeBase(autofill.userEdited)) {
      fail("R3", "switching provider overwrote the user's endpoint override");
    }
  }

  // ── R4: reasoning sentinel ───────────────────────────────────────────────
  const reasoning = payload.reasoning;
  if (!isObject(reasoning)) fail("R4", "reasoning section is missing");
  if (!PICKERS.has(reasoning.control)) fail("R4", `reasoning must be a picker, got "${reasoning.control}"`);
  const sentinel = String(reasoning.default ?? "");
  const allowedSentinels = new Set(["lowest", "__lowest__"]);
  if (limitsFor(config, "R4").sentinel) allowedSentinels.add(limitsFor(config, "R4").sentinel);
  if (!allowedSentinels.has(sentinel)) {
    fail("R4", `reasoning default is "${sentinel}", expected the lowest sentinel`);
  }
  const resolved = reasoning.resolved;
  if (!isObject(resolved)) fail("R4", "reasoning.resolved is missing");
  const expectations = {
    none: "none",
    minimal: "minimal",
    low: "low",
    "none-declared": "",
  };
  for (const [key, expected] of Object.entries(expectations)) {
    const cases = asArray(resolved[key]);
    if (cases.length === 0) fail("R4", `reasoning.resolved.${key} has no cases`);
    for (const testCase of cases) {
      const actual = testCase.value;
      if (String(actual ?? "") !== expected) {
        fail("R4", `reasoning resolution ${key} returned "${actual}", expected "${expected}"`, testCase);
      }
    }
  }

  // ── R5: i18n matrix ──────────────────────────────────────────────────────
  const i18n = payload.i18n;
  if (!isObject(i18n)) fail("R5", "i18n section is missing");
  const i18nLimit = limitsFor(config, "R5");
  const expectedLocales = Number(i18nLimit.locales ?? 38);
  const locales = asArray(i18n.locales).map(String);
  if (locales.length < expectedLocales) {
    fail("R5", `only ${locales.length} locales, expected >= ${expectedLocales}`);
  }
  uniqueBy(locales, (locale) => locale, "R5", "locale list");
  const keys = asArray(i18n.keys).map(String);
  if (keys.length === 0) fail("R5", "i18n.keys is empty");
  uniqueBy(keys, (key) => key, "R5", "i18n key list");
  const used = asArray(i18n.used).map(String);
  for (const key of used) {
    if (!keys.includes(key)) fail("R5", `UI references missing i18n key "${key}"`);
  }
  if (isObject(i18n.files)) {
    const sourceLocale = i18n.sourceLocale || locales[0] || "en";
    const source = i18n.files[sourceLocale] || {};
    for (const locale of locales) {
      const file = i18n.files[locale];
      if (!isObject(file)) fail("R5", `locale "${locale}" has no message file`);
      for (const key of keys) {
        if (typeof file[key] !== "string" || file[key].trim() === "") {
          fail("R5", `locale "${locale}" is missing a non-empty value for "${key}"`);
        }
      }
      if (locale !== sourceLocale && !/^zh|^ja/.test(locale)) {
        const cjk = Object.entries(file).find(([, value]) => isCjk(value));
        if (cjk) fail("R5", `locale "${locale}" contains CJK text in "${cjk[0]}"`);
      }
      if (locale !== sourceLocale && source) {
        for (const key of keys) {
          const expected = placeholderTokens(source[key] ?? "");
          const actual = placeholderTokens(file[key] ?? "");
          const missing = [...expected].filter((token) => !actual.has(token));
          if (missing.length) {
            fail("R5", `locale "${locale}" key "${key}" lost placeholder(s) ${missing.join(", ")}`);
          }
        }
      }
    }
  }

  // ── static anti-pattern scan supplied by the host ────────────────────────
  if (isObject(payload.static)) {
    const hits = asArray(payload.static.hits);
    if (hits.length) {
      fail("STATIC", `banned token(s) found: ${hits.map((hit) => hit.token || hit).join(", ")}`, hits);
    }
  }

  return {
    spec: SPEC_VERSION,
    host: payload.host,
    languages: languageOptions.length,
    providers: providerOptions.length,
    localeCount: locales.length,
  };
}

// ── Self-test: every bad payload must be caught by the named rule ──────────
function cleanPayload() {
  const languageOptions = [
    ["en", "English (en)"],
    ["zh-CN", "Chinese (Simplified) (zh-CN)"],
    ["ja", "Japanese (ja)"],
  ];
  for (let i = 0; i < 30; i += 1) languageOptions.push([`l${i}`, `Language ${i} (l${i})`]);
  const providerOptions = [
    { value: "anthropic", label: "Anthropic", source: "models.dev" },
    { value: "deepseek", label: "DeepSeek", source: "models.dev" },
    { value: "google-gemini", label: "Google Gemini", source: "built-in" },
    { value: "groq", label: "Groq", source: "models.dev" },
    { value: "openai", label: "OpenAI", source: "built-in" },
  ];
  return {
    spec: SPEC_VERSION,
    host: "fixture",
    language: {
      control: "select",
      current: "zh-CN",
      options: languageOptions.map(([value, label]) => ({ value, label })),
    },
    provider: { control: "select", current: "openai", options: providerOptions },
    model: {
      control: "select",
      byProvider: {
        openai: [{ value: "gpt-4.1", label: "GPT-4.1" }],
        anthropic: [{ value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" }],
        deepseek: [{ value: "deepseek-chat", label: "DeepSeek Chat" }],
      },
    },
    endpoint: {
      control: "text",
      autofill: {
        provider: "openai",
        providerApi: "https://api.openai.com/v1",
        before: "",
        after: "https://api.openai.com/v1",
        userEdited: "https://proxy.example/v1",
        afterSwitch: "https://proxy.example/v1",
      },
    },
    reasoning: {
      control: "select",
      default: "lowest",
      resolved: {
        none: [{ setting: "lowest", options: ["none", "minimal", "low"], value: "none" }],
        minimal: [{ setting: "lowest", options: ["minimal", "low"], value: "minimal" }],
        low: [{ setting: "lowest", options: ["low", "medium"], value: "low" }],
        "none-declared": [{ setting: "lowest", options: [], value: "" }],
      },
    },
    i18n: {
      locales: ["en"],
      keys: ["settingProvider"],
      sourceLocale: "en",
      files: { en: { settingProvider: "Provider" } },
      used: ["settingProvider"],
    },
    static: { hits: [] },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function selfTest() {
  const config = { platformLimits: [{ rule: "R5", locales: 1 }] };
  const failures = [];
  const expectFail = (rule, name, mutate, configOverride = config) => {
    const payload = clone(cleanPayload());
    mutate(payload);
    try {
      validatePayload(payload, configOverride);
      failures.push(`${name}: expected ${rule}, validator accepted the payload`);
    } catch (error) {
      if (!(error instanceof ConformanceError) || error.rule !== rule) {
        failures.push(`${name}: expected ${rule}, got ${error.rule || error.name}: ${error.message}`);
      }
    }
  };

  // The clean fixture must pass — otherwise every negative test below is meaningless.
  try {
    validatePayload(cleanPayload(), config);
  } catch (error) {
    failures.push(`clean fixture failed: ${error.message}`);
  }

  expectFail("R1", "target language is a text input", (p) => {
    p.language.control = "text";
  });
  expectFail("R1", "raw language codes", (p) => {
    p.language.options = p.language.options.map(({ value }) => ({ value, label: value }));
  });
  expectFail("R2", "divider in provider list", (p) => {
    p.provider.options.splice(2, 0, { value: "__more__", label: "──── More ────", disabled: true });
  });
  expectFail("R2", "unsorted provider list", (p) => {
    p.provider.options = [p.provider.options[2], p.provider.options[0], p.provider.options[1]];
  });
  expectFail("R2", "built-in only", (p) => {
    p.provider.options = [{ value: "openai", label: "OpenAI", source: "built-in" }];
  });
  expectFail("R2", "custom model entry not last", (p) => {
    const list = p.model.byProvider.openai;
    list.push({ value: "gpt-4.1-mini", label: "GPT-4.1 Mini" });
    list.unshift({ value: "__custom__", label: "Custom model" });
  });
  expectFail("R3", "endpoint unchanged after provider pick", (p) => {
    p.endpoint.autofill.after = "";
  });
  expectFail("R3", "provider switch clobbers the override", (p) => {
    p.endpoint.autofill.afterSwitch = "https://api.openai.com/v1";
  });
  expectFail("R4", "concrete default instead of sentinel", (p) => {
    p.reasoning.default = "low";
  });
  expectFail("R4", "none not preferred", (p) => {
    p.reasoning.resolved.none[0].value = "minimal";
  });
  expectFail("R5", "missing locale key", (p) => {
    p.i18n.keys.push("settingModel");
  });
  expectFail("STATIC", "banned divider token", (p) => {
    p.static.hits = [{ token: "providerSeparator" }];
  });

  if (failures.length) {
    const error = new Error(`self-test failed:\n- ${failures.join("\n- ")}`);
    error.failures = failures;
    throw error;
  }
  return 12;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--print-schema")) {
    console.log(JSON.stringify(SCHEMA, null, 2));
    return;
  }
  if (args.includes("--self-test")) {
    try {
      const count = selfTest();
      console.log(`OK conformance self-test: ${count} negative controls caught`);
      process.exit(0);
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  }

  const fs = require("node:fs");
  const file = args.find((arg) => !arg.startsWith("--"));
  let raw;
  try {
    raw = file ? fs.readFileSync(file, "utf8") : fs.readFileSync(0, "utf8");
  } catch (error) {
    console.error(`cannot read payload: ${error.message}`);
    process.exit(2);
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    console.error(`payload is not JSON: ${error.message}`);
    process.exit(2);
  }
  const config = payload.conformance || {};
  try {
    const summary = validatePayload(payload, config);
    console.log(
      `PASS ${summary.host}: ${summary.languages} languages, ${summary.providers} providers, ${summary.localeCount} locales (spec ${summary.spec})`
    );
  } catch (error) {
    console.error(error.message);
    if (error.detail) console.error(JSON.stringify(error.detail));
    process.exit(1);
  }
}

const SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "DualTran host conformance payload",
  required: ["spec", "host", "language", "provider", "model", "endpoint", "reasoning", "i18n"],
  properties: {
    spec: { const: SPEC_VERSION },
    host: { type: "string" },
    language: {
      type: "object",
      required: ["control", "current", "options"],
      properties: {
        control: { enum: [...PICKERS] },
        current: { type: "string" },
        options: {
          type: "array",
          items: { type: "object", required: ["value", "label"] },
        },
      },
    },
    provider: {
      type: "object",
      required: ["control", "options"],
      properties: {
        control: { enum: [...PICKERS] },
        options: {
          type: "array",
          items: {
            type: "object",
            required: ["value", "label", "source"],
            properties: { source: { enum: ["built-in", "models.dev", "custom"] } },
          },
        },
      },
    },
    model: { type: "object", required: ["control", "byProvider"] },
    endpoint: { type: "object", required: ["control", "autofill"] },
    reasoning: { type: "object", required: ["control", "default", "resolved"] },
    i18n: { type: "object", required: ["locales", "keys"] },
  },
};

// ESM + CJS: `require` is only needed in the CLI path; create it for ESM.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
