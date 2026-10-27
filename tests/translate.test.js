const test = require("node:test");
const assert = require("node:assert");
const { chunk, parseGoogle, google, ai, translate } = require("../src/translate");

test("chunk keeps short text whole", () => {
  assert.deepStrictEqual(chunk("Hello world.", 1800), ["Hello world."]);
});

test("chunk splits long text on sentence boundaries and loses nothing", () => {
  const text = "This is a sentence. ".repeat(200);
  const parts = chunk(text, 1800);
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.ok(p.length <= 1800, "chunk too large: " + p.length);
  assert.strictEqual(parts.join(""), text);
});

test("parseGoogle joins the translated segments", () => {
  const data = [[["你好世界", "Hello world", null, null, 10], ["再见", "Bye"]], null, "en"];
  assert.strictEqual(parseGoogle(data), "你好世界再见");
  assert.strictEqual(parseGoogle(null), "");
});

test("google sends one request per chunk and encodes the text", async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => [[["X", "x"]]] };
  };
  const out = await google("a. b.", "auto", "zh-CN", fakeFetch);
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].includes("tl=zh-CN"));
  assert.ok(calls[0].includes("q=a.%20b."));
  assert.strictEqual(out, "X");
});

test("google surfaces HTTP failures", async () => {
  await assert.rejects(
    () => google("x", "auto", "en", async () => ({ ok: false, status: 429 })),
    /HTTP 429/
  );
});

test("ai refuses to run without credentials", async () => {
  await assert.rejects(() => ai("x", "auto", "en", { endpoint: "https://x/v1", model: "m" }, async () => ({})), /API key/);
});

test("ai posts an OpenAI-compatible body and trims the answer", async () => {
  let body;
  const fakeFetch = async (url, init) => {
    assert.ok(url.endsWith("/chat/completions"));
    body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: "  译文  " } }] }) };
  };
  const out = await ai("hello", "auto", "zh-CN", { endpoint: "https://api.test/v1/", model: "m", key: "k" }, fakeFetch);
  assert.strictEqual(out, "译文");
  assert.strictEqual(body.model, "m");
  assert.match(body.messages[0].content, /zh-CN/);
});

test("translate routes by engine", async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => [[["G"]]] });
  assert.strictEqual(await translate("x", { engine: "google", targetLanguage: "en", fetch: fakeFetch }), "G");
  await assert.rejects(() => translate("x", { engine: "ai", targetLanguage: "en", ai: {}, fetch: fakeFetch }), /API key/);
});

test("ai sends reasoning_effort when the caller resolved one", async () => {
  let body;
  const fakeFetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
  };
  await ai("hello", "auto", "zh-CN", { endpoint: "https://api.test/v1", model: "m", key: "k", reasoning: "minimal" }, fakeFetch);
  assert.strictEqual(body.reasoning_effort, "minimal");
});

test("ai omits reasoning_effort when the setting resolves to nothing", async () => {
  let body;
  const fakeFetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
  };
  await ai("hello", "auto", "zh-CN", { endpoint: "https://api.test/v1", model: "m", key: "k", reasoning: "" }, fakeFetch);
  assert.ok(!("reasoning_effort" in body));
});

test("ai retries without reasoning_effort when the endpoint rejects it", async () => {
  const bodies = [];
  const fakeFetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if ("reasoning_effort" in body) {
      return {
        ok: false,
        status: 400,
        text: async () => '{"error":{"message":"Unsupported parameter: reasoning_effort"}}',
      };
    }
    return { ok: true, json: async () => ({ choices: [{ message: { content: "retried" } }] }) };
  };
  const out = await ai("hello", "auto", "zh-CN", { endpoint: "https://api.test/v1", model: "m", key: "k", reasoning: "low" }, fakeFetch);
  assert.strictEqual(out, "retried");
  assert.strictEqual(bodies.length, 2);
  assert.strictEqual(bodies[0].reasoning_effort, "low");
  assert.ok(!("reasoning_effort" in bodies[1]));
});

test("ai does not retry an unrelated 400", async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return { ok: false, status: 400, text: async () => '{"error":{"message":"bad model"}}' };
  };
  await assert.rejects(
    () => ai("hello", "auto", "zh-CN", { endpoint: "https://api.test/v1", model: "m", key: "k", reasoning: "low" }, fakeFetch),
    /HTTP 400/
  );
  assert.strictEqual(calls, 1);
});
