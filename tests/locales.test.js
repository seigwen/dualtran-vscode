"use strict";
/**
 * Locale guards for the VS Code host (node:test, same runner as the rest).
 *
 * The extension ships the same 38 languages as the browser extension; VS Code
 * itself only *applies* the ones its UI supports, but every catalogue and every
 * package.nls / l10n bundle must exist so a newly supported language works
 * without a code change.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const LOCALES = path.join(ROOT, "locales");
const EXPECTED = [
  "af", "ar", "ca", "cs", "da", "de", "el", "en", "es", "fa", "fi", "fr", "he", "hi", "hr",
  "hu", "is", "it", "ja", "ko", "lv", "nl", "no", "pl", "pt_BR", "pt_PT", "ro", "ru", "sl",
  "sr", "sv", "th", "tr", "ug", "uk", "vi", "zh_CN", "zh_TW",
];
const VSCODE_LOCALE = { zh_CN: "zh-cn", zh_TW: "zh-tw", pt_BR: "pt-br", pt_PT: "pt-pt" };

const read = (code) => JSON.parse(fs.readFileSync(path.join(LOCALES, code, "messages.json"), "utf8"));
const en = read("en");
const enKeys = Object.keys(en);

test("ships the agreed 38 locales", () => {
  const codes = fs.readdirSync(LOCALES).filter((code) => fs.existsSync(path.join(LOCALES, code, "messages.json")));
  assert.deepEqual(codes.sort(), [...EXPECTED].sort());
});

test("every locale carries every key, non-empty", () => {
  for (const code of EXPECTED) {
    const catalogue = read(code);
    assert.deepEqual(Object.keys(catalogue), enKeys, `${code}: key set`);
    for (const key of enKeys) {
      const value = catalogue[key] && catalogue[key].message;
      assert.equal(typeof value === "string" && value.trim().length > 0, true, `${code}: ${key}`);
    }
    if (!code.startsWith("zh") && !code.startsWith("ja")) {
      assert.equal(/[\u4e00-\u9fff]/.test(JSON.stringify(catalogue)), false, `${code}: Chinese left over`);
    }
  }
});

test("package.nls.json and the l10n bundles match the catalogues", () => {
  const nls = JSON.parse(fs.readFileSync(path.join(ROOT, "package.nls.json"), "utf8"));
  assert.deepEqual(Object.keys(nls).sort(), [...enKeys].sort(), "package.nls.json keys");
  for (const code of EXPECTED) {
    if (code === "en") continue;
    const locale = VSCODE_LOCALE[code] || code.toLowerCase();
    const nlsFile = path.join(ROOT, `package.nls.${locale}.json`);
    const bundleFile = path.join(ROOT, "l10n", `bundle.l10n.${locale}.json`);
    assert.ok(fs.existsSync(nlsFile), `missing package.nls.${locale}.json`);
    assert.ok(fs.existsSync(bundleFile), `missing l10n/bundle.l10n.${locale}.json`);
    const catalogue = read(code);
    const nlsLocale = JSON.parse(fs.readFileSync(nlsFile, "utf8"));
    assert.equal(nlsLocale.cmdTranslateInline, catalogue.cmdTranslateInline.message, `${code}: nls drift`);
    const bundle = JSON.parse(fs.readFileSync(bundleFile, "utf8"));
    assert.equal(bundle[en.cmdTranslateInline.message], catalogue.cmdTranslateInline.message, `${code}: bundle drift`);
  }
});

test("manifest strings use %keys% that package.nls defines", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const nls = JSON.parse(fs.readFileSync(path.join(ROOT, "package.nls.json"), "utf8"));
  const referenced = new Set();
  const walk = (node) => {
    if (typeof node === "string") {
      const match = /^%([^%]+)%$/.exec(node);
      if (match) referenced.add(match[1]);
      return;
    }
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === "object") Object.values(node).forEach(walk);
  };
  walk(pkg.contributes);
  assert.ok(referenced.size > 20, `expected translated manifest strings, got ${referenced.size}`);
  for (const key of referenced) assert.ok(nls[key], `package.nls.json is missing "${key}"`);
});
