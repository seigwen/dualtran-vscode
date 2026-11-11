#!/usr/bin/env node
/**
 * Shared runner: host payload generator -> static scan -> spec validation.
 *
 * Every host repo has an identical copy of this file plus validate.mjs/scan.mjs.
 * `npm run conformance` executes it. The host only supplies conformance.json and
 * a payload generator that reads its real settings surface.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SPEC_VERSION, selfTest, validatePayload } from "./validate.mjs";
import { scanFiles } from "./scan.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const configPath = resolve(repoRoot, "conformance.json");

function die(message) {
  console.error(message);
  process.exit(1);
}

let config;
try {
  config = JSON.parse(readFileSync(configPath, "utf8"));
} catch (error) {
  die(`conformance.json is missing or invalid: ${error.message}`);
}
if (config.spec !== SPEC_VERSION) {
  die(`conformance.json targets spec ${config.spec}, this kit is ${SPEC_VERSION} — run scripts/sync-conformance-kit.mjs`);
}

// Negative controls first: a gate that cannot fail is worse than no gate.
try {
  const count = selfTest();
  console.log(`self-test: ${count} negative controls caught`);
} catch (error) {
  die(`conformance self-test failed:\n${error.message}`);
}

let payload;
if (config.payloadCommand) {
  try {
    const output = execFileSync("bash", ["-lc", config.payloadCommand], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    payload = JSON.parse(output);
  } catch (error) {
    die(`payload command failed: ${error.message}`);
  }
} else if (config.payload) {
  const module = await import(pathToFileURL(resolve(repoRoot, config.payload)).href);
  payload = await (module.default ?? module.buildPayload)();
} else {
  die("conformance.json needs payload or payloadCommand");
}

if (config.static) {
  const hits = scanFiles(repoRoot, config.static);
  payload.static = { ...(payload.static || {}), hits };
}

payload.conformance = config;
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
