#!/usr/bin/env node
/**
 * merge-i18n-keys.mjs — add the runtime strings a release introduced to every
 * localisation file, once. The batch is named by the facts file:
 *
 *   node scripts/merge-i18n-keys.mjs spec21        # i18n-extra-spec21.json
 *   node scripts/merge-i18n-keys.mjs --check spec21 # verify only (exit 1 on drift)
 *
 * KEYS is the batch this run introduces; earlier batches (pickModelTitle,
 * pickModelPlaceholder) are already in every catalogue and stay untouched.
 * Key order is the catalogue's own (en comes last: it is the source text).
 *
 * Translations come from tests/fixtures/conformance/i18n-extra-vscode.json (one
 * value per key per locale). Targets, per locale:
 *
 *   locales/<code>/messages.json      { "<key>": { "message": <text>, "description": <en text> } }
 *   package.nls.<vs>.json             "<key>": <text>
 *   l10n/bundle.l10n.<vs>.json       "<English text>": <text>
 *
 * The files are patched *textually*: each new member is spliced in right after
 * an existing anchor key, so key order, line endings and the compact one-line
 * formatting of the English catalogues survive untouched. Every insertion is
 * assertion-guarded — the key must be absent from the parsed object before it
 * is written, and the merged file must re-parse to exactly old + new members.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEYS = [
  "providerPlaceholder",
  "providerRequiredForModel",
  "providerRequiredError",
  "statusTranslateAction",
];
/** Insert after this key: it is what package.nls.json / build-nls.mjs emit right before the new ones. */
const ANCHOR = "pickProviderPlaceholder";
const VSCODE_LOCALE = { zh_CN: "zh-cn", zh_TW: "zh-tw", pt_BR: "pt-br", pt_PT: "pt-pt" };

const checkOnly = process.argv.slice(2).includes("--check");

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const extra = readJson(path.join(ROOT, "tests", "fixtures", "conformance", "i18n-extra-vscode.json"));
const en = readJson(path.join(ROOT, "locales", "en", "messages.json"));
const DESCRIPTION = Object.fromEntries(KEYS.map((key) => [key, en[key] && en[key].message]));

/** English source text → localized text, per runtime key. */
const SOURCE_TEXT = Object.fromEntries(KEYS.map((key) => [key, DESCRIPTION[key]]));

function fail(message) {
  console.error(`[merge-i18n-keys] ${message}`);
  process.exit(1);
}

const TRANSLATED_LOCALES = 37; // every locale but en: English is the source text in locales/en

for (const key of KEYS) {
  if (typeof DESCRIPTION[key] !== "string" || !DESCRIPTION[key].trim()) fail(`locales/en/messages.json has no "${key}"`);
  const locales = extra[key];
  if (!locales || typeof locales !== "object") fail(`facts/i18n-extra-vscode.json has no "${key}"`);
  if (Object.keys(locales).length !== TRANSLATED_LOCALES) {
    fail(`"${key}" covers ${Object.keys(locales).length} translations, expected ${TRANSLATED_LOCALES}`);
  }
  if (Object.prototype.hasOwnProperty.call(locales, "en")) fail(`"${key}" carries an "en" value; English lives in locales/en`);
}

/**
 * Insert `members` (already escaped JSON member text) into a flat JSON object
 * file without re-serialising it. The anchor's member is located first, its
 * end found by walking the object/value braces, and the new members appended:
 * a pretty file gets one `indent`-prefixed member per line, a compact
 * one-line file gets them inline before the following member.
 */
function spliceMembers(text, parsed, members, anchors, label) {
  for (const [key] of members) {
    if (Object.prototype.hasOwnProperty.call(parsed, key)) {
      fail(`${label}: "${key}" already present — refusing to overwrite`);
    }
  }
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  for (const anchor of anchors) {
    const match = new RegExp(`^([ \\t]*)"${escape(anchor)}":[ \\t]*`, "m").exec(text);
    if (!match) continue;
    const indent = match[1];
    const memberStart = match.index;
    const valueStart = memberStart + match[0].length;
    // Walk from the anchor's value to its closing brace (an object) or the
    // first quote that is not escaped (a string).
    let end;
    if (text[valueStart] === "{") {
      let depth = 0;
      let index = valueStart;
      for (; index < text.length; index += 1) {
        if (text[index] === "{") depth += 1;
        else if (text[index] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      end = index + 1;
    } else if (text[valueStart] === '"') {
      let index = valueStart + 1;
      for (; index < text.length; index += 1) {
        if (text[index] === "\\") index += 1;
        else if (text[index] === '"') break;
      }
      end = index + 1;
    } else {
      fail(`${label}: anchor "${anchor}" has an unsupported value`);
    }
    const pretty = /[\r\n]/.test(text.slice(end, end + 8));
    let out;
    if (pretty) {
      // Anchor member ends on its own line: re-terminate it with a comma and
      // append one member per line at the anchor's indent. The last new member
      // inherits whatever terminator the anchor had.
      const lineEnd = text.indexOf(newline, end);
      const after = lineEnd === -1 ? text.length : lineEnd;
      const terminated = /,\s*$/.test(text.slice(end, after));
      const anchorEnd = terminated ? end + text.slice(end, after).indexOf(",") + 1 : end;
      const inserted = members.map(([, snippet]) => `${newline}${indent}${snippet}`).join("");
      out = `${text.slice(0, anchorEnd)}${inserted}${terminated ? "" : ","}${text.slice(after)}`;
    } else {
      // Compact one-line object: insert complete members before the member that
      // follows the anchor.
      const comma = text.indexOf(",", end);
      if (comma === -1) fail(`${label}: anchor "${anchor}" is the last member`);
      const nextMember = text.indexOf('"', comma + 1);
      const at = nextMember === -1 ? comma + 1 : nextMember;
      out = `${text.slice(0, at)}${members.map(([, snippet]) => `${snippet} `).join("")}${text.slice(at)}`;
    }
    return out;
  }
  fail(`${label}: none of the anchors ${anchors.join(", ")} found`);
}

/** RegExp-escaping for the anchor lookup … */
function escape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * … and JSON string escaping for the members we write. They cannot share one
 * helper: a JSON member needs its quotes/backslashes escaped, not its dots.
 */
function jsonString(value) {
  return JSON.stringify(String(value)).slice(1, -1);
}

/** `"key": "value"` for flat nls / bundle files, escaped like JSON.stringify. */
const flatMember = (key, value) => `"${jsonString(key)}": ${JSON.stringify(value)},`;

/** `"key": { "message": "…", "description": "…" }`, one line in every catalogue. */
const catalogueMember = (key, value, description) =>
  `"${jsonString(key)}": { "message": ${JSON.stringify(value)}, "description": ${JSON.stringify(description)} },`;

/** The text for a locale: English comes from locales/en (already merged by hand). */
const textFor = (key, code) => (code === "en" ? DESCRIPTION[key] : extra[key][code]);

const targets = [];

for (const code of fs.readdirSync(path.join(ROOT, "locales")).sort()) {
  const catalogueFile = path.join(ROOT, "locales", code, "messages.json");
  if (!fs.existsSync(catalogueFile)) continue;
  const vs = code === "en" ? null : VSCODE_LOCALE[code] || code;
  targets.push({
    label: `locales/${code}/messages.json`,
    file: catalogueFile,
    kind: "catalogue",
    text: () =>
      KEYS.map((key) => {
        const value = textFor(key, code);
        if (typeof value !== "string" || !value.trim()) throw new Error(`no ${key} for ${code}`);
        return [key, catalogueMember(key, value, DESCRIPTION[key])];
      }),
  });
  if (vs) {
    targets.push({
      label: `package.nls.${vs}.json`,
      file: path.join(ROOT, `package.nls.${vs}.json`),
      kind: "flat",
      text: () =>
        KEYS.map((key) => {
          const value = textFor(key, code);
          if (typeof value !== "string" || !value.trim()) throw new Error(`no ${key} for ${code}`);
          return [key, flatMember(key, value)];
        }),
    });
    targets.push({
      label: `l10n/bundle.l10n.${vs}.json`,
      file: path.join(ROOT, "l10n", `bundle.l10n.${vs}.json`),
      kind: "flat",
      text: () =>
        KEYS.map((key) => {
          const value = textFor(key, code);
          if (typeof value !== "string" || !value.trim()) throw new Error(`no ${key} for ${code}`);
          return [SOURCE_TEXT[key], flatMember(SOURCE_TEXT[key], value)];
        }),
    });
  }
}

let merged = 0;
let already = 0;
for (const target of targets) {
  const text = fs.readFileSync(target.file, "utf8");
  const parsed = JSON.parse(text);
  const members = target.text();
  const missing = members.filter(([key]) => !Object.prototype.hasOwnProperty.call(parsed, key));
  if (missing.length === 0) {
    already += 1;
    continue;
  }
  if (checkOnly) fail(`${target.label}: missing ${missing.map(([key]) => key).join(", ")}`);
  const anchors =
    target.kind === "catalogue"
      ? [ANCHOR, "pickProviderPlaceholder", "pickProviderTitle"]
      : [ANCHOR, "Built-in first, then every provider models.dev knows"];
  const next = spliceMembers(text, parsed, missing, anchors, target.label);
  // The merged file must be exactly the old object plus the new members.
  const mergedJson = JSON.parse(next);
  // Guard: same member count, every pre-existing member byte-for-byte intact,
  // and each new key inserted exactly once.
  const gotKeys = Object.keys(mergedJson);
  if (gotKeys.length !== Object.keys(parsed).length + missing.length) {
    fail(`${target.label}: merged ${gotKeys.length} members, expected ${Object.keys(parsed).length + missing.length}`);
  }
  for (const key of Object.keys(parsed)) {
    if (JSON.stringify(parsed[key]) !== JSON.stringify(mergedJson[key])) fail(`${target.label}: "${key}" changed`);
  }
  for (const [key] of missing) {
    if (gotKeys.filter((candidate) => candidate === key).length !== 1) fail(`${target.label}: "${key}" did not land once`);
  }
  fs.writeFileSync(target.file, next);
  merged += 1;
}

console.log(`[merge-i18n-keys] ${KEYS.join(", ")}: ${merged} files merged, ${already} already complete (${targets.length} targets)`);
