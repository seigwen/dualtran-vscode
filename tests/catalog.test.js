const test = require("node:test");
const assert = require("node:assert");
const { projectCatalog, buildProviderList, resolveReasoning, BUILTINS } = require("../src/catalog");

const raw = {
  openai: {
    name: "OpenAI",
    models: {
      "gpt-5": { reasoning_options: [{ type: "effort", values: ["minimal", "low", "medium"] }] },
      "gpt-4o": {},
    },
  },
  moonshot: { name: "Moonshot", api: "https://api.moonshot.cn/v1", models: { "kimi-k2": {} } },
  moonshotai: { name: "Moonshot AI", api: "https://api.moonshot.ai/v1", models: { "kimi-k2": {} } },
  google: {
    name: "Google",
    api: "https://generativelanguage.googleapis.com/v1beta",
    models: { "gemini-2.5-pro": { reasoning_options: [{ type: "effort", values: ["low", "high"] }] } },
  },
  toggleonly: {
    name: "Toggle Only",
    api: "https://toggle.example/v1",
    models: { thinker: { reasoning_options: [{ type: "toggle" }] } },
  },
  "no-api": { name: "No API", models: { m: {} } },
};

test("projectCatalog keeps reachable providers and indexes reasoning for every provider", () => {
  const { providers, modelsById, reasoning } = projectCatalog(raw);
  const ids = providers.map((p) => p.id);
  assert.ok(ids.includes("moonshot"));
  assert.ok(ids.includes("google"));
  assert.ok(!ids.includes("no-api"), "a provider without an api cannot be reached");
  assert.deepStrictEqual(reasoning.openai["gpt-5"], ["minimal", "low", "medium"]);
  assert.deepStrictEqual(reasoning.google["gemini-2.5-pro"], ["low", "high"]);
  assert.deepStrictEqual(reasoning.toggleonly.thinker, ["high"], "toggle models expose the ON switch only");
  assert.deepStrictEqual(reasoning.openai["gpt-4o"], []);
  assert.deepStrictEqual(modelsById.openai.map((m) => m.id), ["gpt-5", "gpt-4o"]);
});

test("buildProviderList puts built-ins first, then the catalogue, without alias twins", () => {
  const { providers, modelsById } = projectCatalog(raw);
  const list = buildProviderList(providers, modelsById);
  assert.strictEqual(list[0].builtIn, true);
  const builtInCount = list.filter((p) => p.builtIn).length;
  assert.strictEqual(builtInCount, BUILTINS.length);
  assert.ok(list.slice(builtInCount).every((p) => p.builtIn === false), "catalogue comes after the divider");
  const moons = list.filter((p) => p.id === "moonshot" || p.id === "moonshotai");
  assert.strictEqual(moons.length, 1, "moonshot ↔ moonshotai must not repeat");
  assert.ok(!list.some((p) => p.id === "no-api"));
  // A built-in pulls its model list from the catalogue entry it aliases.
  const openai = list.find((p) => p.id === "openai");
  assert.ok(openai.models.some((m) => m.id === "gpt-5"));
});

test("resolveReasoning maps the lowest sentinel onto the model's own levels", () => {
  assert.strictEqual(resolveReasoning("lowest", ["minimal", "low", "high"]), "minimal");
  assert.strictEqual(resolveReasoning("lowest", ["low", "high"]), "low");
  assert.strictEqual(resolveReasoning("lowest", ["none", "high"]), "none");
  assert.strictEqual(resolveReasoning("lowest", []), "");
  assert.strictEqual(resolveReasoning("lowest", ["high"]), "", "a toggle is not a low level");
  assert.strictEqual(resolveReasoning("lowest", undefined), "");
  assert.strictEqual(resolveReasoning("medium", ["low", "medium"]), "medium");
  assert.strictEqual(resolveReasoning("default", ["low"]), "");
});
