#!/usr/bin/env node
/**
 * build-nls.mjs — generate VS Code's native localisation files from our
 * catalogues:
 *
 *   package.nls.json                 → manifest strings (English default)
 *   package.nls.<locale>.json        → the same keys per language
 *   l10n/bundle.l10n.<locale>.json   → runtime strings ({english: translated})
 *
 * VS Code only applies the languages its own UI supports (~a dozen), but every
 * catalogue is emitted so a newly supported language starts working without a
 * code change.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCALES = path.join(ROOT, "locales");
const L10N = path.join(ROOT, "l10n");

/** VS Code's locale ids: lowercase, hyphenated. */
const VSCODE_LOCALE = { zh_CN: "zh-cn", zh_TW: "zh-tw", pt_BR: "pt-br", pt_PT: "pt-pt" };

const catalogues = {};
for (const entry of fs.readdirSync(LOCALES, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const file = path.join(LOCALES, entry.name, "messages.json");
  if (fs.existsSync(file)) catalogues[entry.name] = JSON.parse(fs.readFileSync(file, "utf8"));
}

const en = catalogues.en;
const nls = (catalogue) => {
  const out = {};
  for (const key of Object.keys(en)) out[key] = catalogue[key].message;
  return out;
};

fs.writeFileSync(path.join(ROOT, "package.nls.json"), JSON.stringify(nls(en), null, 2) + "\n");

fs.mkdirSync(L10N, { recursive: true });
let written = 0;
for (const code of Object.keys(catalogues)) {
  if (code === "en") continue;
  const locale = VSCODE_LOCALE[code] || code.toLowerCase();
  const catalogue = catalogues[code];
  fs.writeFileSync(path.join(ROOT, `package.nls.${locale}.json`), JSON.stringify(nls(catalogue), null, 2) + "\n");
  const bundle = {};
  for (const key of Object.keys(en)) bundle[en[key].message] = catalogue[key].message;
  fs.writeFileSync(path.join(L10N, `bundle.l10n.${locale}.json`), JSON.stringify(bundle, null, 2) + "\n");
  written++;
}
console.log(`[build-nls] package.nls.json + ${written} locales → package.nls.<locale>.json + l10n/bundle.l10n.<locale>.json`);
