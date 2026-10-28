#!/usr/bin/env node
/**
 * locale-kit.mjs — keep `_locales/<code>/messages.json` complete for every
 * language the product ships, reusing the browser extension's catalogue as the
 * translation memory.
 *
 *   node scripts/locale-kit.mjs            # fill missing locales/keys
 *   node scripts/locale-kit.mjs --check    # validate only (used by tests/CI)
 *
 * Sources, in order:
 *   1. the extension's catalogue for the same locale, matched by English text
 *      (identical strings reuse the shipped translation);
 *   2. a local OpenAI-compatible model (OLLAMA_* env vars) for the rest.
 *
 * zh_CN / zh_TW are hand-written and never machine-translated.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EN = path.join(ROOT, "locales", "en", "messages.json");
const EXT =
  process.env.EXT_LOCALES || path.resolve(ROOT, "..", "..", "DualTran-extension", "src", "_locales");
const MODEL = process.env.OLLAMA_MODEL || "deepseek-v4.1-flash:cloud";
const BASE = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1").replace(/\/+$/, "");

/** Same 38 languages as the extension — do not add or drop codes here. */
const LANGUAGES = {
  af: "Afrikaans", ar: "Arabic", ca: "Catalan", cs: "Czech", da: "Danish", de: "German",
  el: "Greek", es: "Spanish", fa: "Persian", fi: "Finnish", fr: "French", he: "Hebrew",
  hi: "Hindi", hr: "Croatian", hu: "Hungarian", is: "Icelandic", it: "Italian", ja: "Japanese",
  ko: "Korean", lv: "Latvian", nl: "Dutch", no: "Norwegian", pl: "Polish",
  pt_BR: "Brazilian Portuguese", pt_PT: "European Portuguese", ro: "Romanian", ru: "Russian",
  sl: "Slovenian", sr: "Serbian", sv: "Swedish", th: "Thai", tr: "Turkish", ug: "Uyghur",
  uk: "Ukrainian", vi: "Vietnamese", zh_CN: "Simplified Chinese", zh_TW: "Traditional Chinese",
};
const HANDWRITTEN = new Set(["zh_CN", "zh_TW"]);

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const onlyArg = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const only = onlyArg ? new Set(onlyArg.split(",").map((s) => s.trim())) : null;
const force = args.includes("--force");

const en = JSON.parse(fs.readFileSync(EN, "utf8"));
const enKeys = Object.keys(en);

function readCatalogue(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** english text → translated text, harvested from the extension's catalogue. */
function translationMemory(code) {
  const extEn = readCatalogue(path.join(EXT, "en", "messages.json"));
  const extLocale = readCatalogue(path.join(EXT, code, "messages.json"));
  if (!extEn || !extLocale) return {};
  const memory = {};
  for (const key of Object.keys(extEn)) {
    const source = extEn[key] && extEn[key].message;
    const target = extLocale[key] && extLocale[key].message;
    if (source && target) memory[source] = target;
  }
  return memory;
}

async function translate(languageName, entries) {
  const payload = Object.fromEntries(entries.map(([key, text]) => [key, text]));
  const prompt = [
    `Translate these user-interface strings into ${languageName}.`,
    "Rules:",
    "- Output ONLY a JSON object with exactly the same keys.",
    "- Keep placeholders such as $DETAIL$, $COUNT$, $ERROR$ unchanged.",
    "- Keep product names (Google, OpenAI, uTools, DualTran, models.dev) untranslated.",
    "- Desktop software tone, no extra punctuation.",
    "",
    JSON.stringify(payload, null, 2),
  ].join("\n");
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.1,
      reasoning_effort: "none",
      messages: [
        { role: "system", content: "You are a careful software localizer. You answer with JSON only." },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`model HTTP ${res.status}`);
  const data = await res.json();
  const text = ((data.choices || [])[0]?.message?.content || "").trim();
  return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}

function validate(code, catalogue) {
  const problems = [];
  if (!catalogue) return [`${code}: missing catalogue`];
  const keys = Object.keys(catalogue);
  for (const key of enKeys) {
    const value = catalogue[key] && catalogue[key].message;
    if (typeof value !== "string" || !value.trim()) problems.push(`${code}: "${key}" missing/empty`);
  }
  for (const key of keys) {
    if (!en[key]) problems.push(`${code}: "${key}" is not in en`);
  }
  if (!code.startsWith("zh") && !code.startsWith("ja")) {
    if (/[\u4e00-\u9fff]/.test(JSON.stringify(catalogue))) problems.push(`${code}: Chinese text left over`);
  }
  // Every placeholder that exists in the English source must survive.
  for (const key of enKeys) {
    const placeholders = String(en[key].message).match(/\$[A-Z0-9_]+\$/g) || [];
    for (const token of placeholders) {
      if (!String(catalogue[key].message).includes(token)) problems.push(`${code}: "${key}" lost ${token}`);
    }
  }
  return problems;
}

function withMetadata(code, messages) {
  const out = {};
  for (const key of enKeys) {
    const entry = { message: messages[key] };
    if (en[key].description) entry.description = en[key].description;
    if (en[key].placeholders) entry.placeholders = en[key].placeholders;
    out[key] = entry;
  }
  return out;
}

async function run() {
  const codes = Object.keys(LANGUAGES).filter((code) => (only ? only.has(code) : true));
  let problems = [];

  if (checkOnly) {
    for (const code of codes) {
      const file = path.join(ROOT, "locales", code, "messages.json");
      problems = problems.concat(validate(code, readCatalogue(file)));
    }
    if (problems.length) {
      console.error(problems.join("\n"));
      process.exit(1);
    }
    console.log(`[locale-kit] ${codes.length} locales complete (${enKeys.length} keys each)`);
    return;
  }

  for (const code of codes) {
    const file = path.join(ROOT, "locales", code, "messages.json");
    const existing = readCatalogue(file);
    if (existing && !force) {
      console.log(`- ${code}: exists, skipped (use --force)`);
      continue;
    }
    if (HANDWRITTEN.has(code)) {
      if (!existing) console.log(`! ${code}: handwritten — create ${path.relative(ROOT, file)} by hand`);
      continue;
    }
    const memory = translationMemory(code);
    const messages = {};
    const missing = [];
    for (const key of enKeys) {
      const source = en[key].message;
      if (memory[source]) messages[key] = memory[source];
      else missing.push([key, source]);
    }
    for (let i = 0; i < missing.length; i += 10) {
      const chunk = missing.slice(i, i + 10);
      let got = {};
      for (let attempt = 1; attempt <= 3 && Object.keys(got).length < chunk.length; attempt++) {
        try {
          got = { ...got, ...(await translate(LANGUAGES[code], chunk)) };
        } catch (error) {
          console.warn(`  ${code}: attempt ${attempt} failed — ${error.message}`);
        }
      }
      for (const [key, source] of chunk) {
        messages[key] = typeof got[key] === "string" && got[key].trim() ? got[key].trim() : source;
        if (!got[key]) console.warn(`  ${code}: ${key} fell back to English`);
      }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(withMetadata(code, messages), null, 2) + "\n");
    console.log(`✓ ${code}: ${enKeys.length - missing.length} reused, ${missing.length} translated`);
  }

  // Final gate: nothing may be left incomplete.
  problems = [];
  for (const code of codes) problems = problems.concat(validate(code, readCatalogue(path.join(ROOT, "locales", code, "messages.json"))));
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`[locale-kit] ${codes.length} locales complete`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});