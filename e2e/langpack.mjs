/**
 * langpack.mjs — fetch and install a VS Code language pack into the E2E
 * instance, so `--locale=<lang>` actually switches the host (VS Code refuses to
 * switch without a pack, whatever `--locale` says).
 *
 * The VSIX is cached under .vscode-test/langpacks/ and extracted into the test
 * extensions dir; no network is needed on later runs.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/** Our catalogue code → {publisher, name, tag}. */
const PACKS = {
  de: { publisher: "MS-CEINTL", name: "vscode-language-pack-de" },
  "zh-cn": { publisher: "MS-CEINTL", name: "vscode-language-pack-zh-hans" },
  "zh-tw": { publisher: "MS-CEINTL", name: "vscode-language-pack-zh-hant" },
  ja: { publisher: "MS-CEINTL", name: "vscode-language-pack-ja" },
  fr: { publisher: "MS-CEINTL", name: "vscode-language-pack-fr" },
  es: { publisher: "MS-CEINTL", name: "vscode-language-pack-es" },
  "pt-br": { publisher: "MS-CEINTL", name: "vscode-language-pack-pt-br" },
  ru: { publisher: "MS-CEINTL", name: "vscode-language-pack-ru" },
  ko: { publisher: "MS-CEINTL", name: "vscode-language-pack-ko" },
  it: { publisher: "MS-CEINTL", name: "vscode-language-pack-it" },
};

const CACHE = path.join(ROOT, ".vscode-test", "langpacks");

/** Download (once) and return the path to an unpacked language pack. */
export async function ensureLanguagePack(locale, extensionsDir) {
  const pack = PACKS[locale];
  if (!pack) throw new Error(`no language pack mapping for "${locale}"`);
  fs.mkdirSync(CACHE, { recursive: true });

  const vsix = path.join(CACHE, `${pack.name}.vsix`);
  if (!fs.existsSync(vsix)) {
    const url =
      `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/${pack.publisher}` +
      `/vsextensions/${pack.name}/latest/vspackage`;
    const response = await fetch(url, { headers: { "user-agent": "dualtran-e2e" } });
    if (!response.ok) throw new Error(`language pack download failed: HTTP ${response.status}`);
    let bytes = Buffer.from(await response.arrayBuffer());
    // The marketplace serves the VSIX gzipped; unzip needs a real zip.
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = zlib.gunzipSync(bytes);
    fs.writeFileSync(vsix, bytes);
  }

  const tmp = fs.mkdtempSync(path.join(CACHE, "unpack-"));
  execFileSync("unzip", ["-q", "-o", vsix, "extension/*", "-d", tmp]);
  const manifest = JSON.parse(fs.readFileSync(path.join(tmp, "extension", "package.json"), "utf8"));
  const target = path.join(extensionsDir, `${pack.publisher.toLowerCase()}.${pack.name}-${manifest.version}`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(extensionsDir, { recursive: true });
  fs.renameSync(path.join(tmp, "extension"), target);
  fs.rmSync(tmp, { recursive: true, force: true });
  return target;
}
