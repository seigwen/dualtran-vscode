const test = require("node:test");
const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const BIN = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "vsce.cmd" : "vsce");

/**
 * The e2e suite runs the *source tree* (extensionDevelopmentPath), so it can
 * never catch a packaging mistake: a file excluded by .vscodeignore is present
 * on disk but missing from the .vsix, and the installed extension fails to
 * activate on the user's machine. These tests ask vsce itself what would ship.
 */
function packagedFiles() {
  const out = execFileSync(BIN, ["ls"], { cwd: ROOT, encoding: "utf8" });
  return new Set(
    out
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/\\/g, "/"))
      .filter((line) => line && !line.startsWith("#") && !line.startsWith("DONE"))
  );
}

const shipped = packagedFiles();

test("the vsix contains every module the extension requires at runtime", () => {
  const sources = ["extension.js", ...fs.readdirSync(path.join(ROOT, "src")).map((f) => `src/${f}`)];
  const required = new Set();
  for (const file of sources) {
    const code = fs.readFileSync(path.join(ROOT, file), "utf8");
    for (const match of code.matchAll(/require\("(\.\/[^"]+|\/src\/[^"]+)"\)/g)) {
      const rel = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      // A JSON require (package.json) ships as itself; a script gets its .js extension.
      if (rel.endsWith(".json")) required.add(rel);
      else required.add(rel.endsWith(".js") ? rel : `${rel}.js`);
    }
  }
  for (const rel of required) {
    assert.ok(shipped.has(rel), `${rel} is required at runtime but missing from the .vsix`);
  }
});

test("the vsix contains the localisation bundles VS Code loads", () => {
  assert.ok(shipped.has("package.nls.json"), "package.nls.json missing from the .vsix");
  for (const file of fs.readdirSync(ROOT)) {
    if (/^package\.nls\..+\.json$/.test(file)) {
      assert.ok(shipped.has(file), `${file} missing from the .vsix`);
    }
  }
  for (const file of fs.readdirSync(path.join(ROOT, "l10n"))) {
    assert.ok(shipped.has(`l10n/${file}`), `l10n/${file} missing from the .vsix`);
  }
});

test("the vsix keeps the assets package.json points at", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const field of ["icon", "main", "readme", "changelog"]) {
    if (!pkg[field]) continue;
    const rel = path.posix.normalize(pkg[field].replace(/^\.\//, ""));
    assert.ok(shipped.has(rel), `${pkg[field]} is referenced by package.json but missing from the .vsix`);
  }
});
