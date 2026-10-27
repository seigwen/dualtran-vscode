/**
 * translate.js — DualTran engines, framework-free and testable from Node.
 *
 * google(): the public gtx endpoint (CORS-enabled, no key, chunked at ~1.8k chars).
 * ai():     any OpenAI-compatible /chat/completions endpoint with the user's key.
 */
"use strict";

const GTX = "https://translate.googleapis.com/translate_a/single";
const MAX_CHUNK = 1800;

/** Split on sentence boundaries so each request stays under the endpoint's limit. */
function chunk(text, size) {
  const limit = size || MAX_CHUNK;
  const out = [];
  let buf = "";
  for (const part of text.split(/(?<=[.!?。！？\n])/)) {
    if ((buf + part).length > limit && buf) {
      out.push(buf);
      buf = part;
    } else {
      buf += part;
    }
  }
  if (buf) out.push(buf);
  return out.length ? out : [text];
}

/** The gtx reply is [[[translated, original, ...], ...], ...]; join the segments. */
function parseGoogle(data) {
  if (!Array.isArray(data) || !Array.isArray(data[0])) return "";
  return data[0].map((seg) => (Array.isArray(seg) ? seg[0] : "")).join("");
}

async function google(text, sourceLang, targetLang, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const parts = [];
  for (const piece of chunk(text, MAX_CHUNK)) {
    const url =
      `${GTX}?client=gtx&sl=${encodeURIComponent(sourceLang || "auto")}` +
      `&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(piece)}`;
    const res = await doFetch(url);
    if (!res.ok) throw new Error("Google translation failed: HTTP " + res.status);
    parts.push(parseGoogle(await res.json()));
  }
  return parts.join("\n");
}

/** Build the OpenAI-compatible request body; `reasoning` is already resolved. */
function aiBody(text, sourceLang, targetLang, cfg, reasoning) {
  const body = {
    model: cfg.model,
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content:
          `Translate the text into ${targetLang}` +
          (sourceLang && sourceLang !== "auto" ? ` from ${sourceLang}` : "") +
          ". Output only the translation, keep line breaks and code identifiers unchanged.",
      },
      { role: "user", content: text },
    ],
  };
  if (reasoning) body.reasoning_effort = reasoning;
  return body;
}

/**
 * Any OpenAI-compatible /chat/completions endpoint.
 *
 * `cfg.reasoning` is the level to send (already resolved from the "lowest"
 * sentinel). Endpoints differ in what they accept: one that answers 400 and
 * complains about the parameter gets the request again without it, so a strict
 * gateway never turns a working translation into a hard error.
 */
async function ai(text, sourceLang, targetLang, cfg, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  if (!cfg || !cfg.endpoint || !cfg.model || !cfg.key) {
    throw new Error("AI mode needs an endpoint, a model and an API key.");
  }
  const base = cfg.endpoint.replace(/\/+$/, "");
  const url = base + "/chat/completions";
  const post = (body) =>
    doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.key },
      body: JSON.stringify(body),
    });

  let body = aiBody(text, sourceLang, targetLang, cfg, cfg.reasoning);
  let res = await post(body);
  if (!res.ok && res.status === 400 && body.reasoning_effort) {
    const detail = await res.text().catch(() => "");
    if (/reasoning|effort|unsupported|unrecognized/i.test(detail)) {
      delete body.reasoning_effort;
      res = await post(body);
      if (res.ok) return readAnswer(res);
      const again = await res.text().catch(() => "");
      throw new Error("AI translation failed: HTTP " + res.status + (again ? " — " + again.slice(0, 160) : ""));
    }
    throw new Error("AI translation failed: HTTP " + res.status + (detail ? " — " + detail.slice(0, 160) : ""));
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error("AI translation failed: HTTP " + res.status + (detail ? " — " + detail.slice(0, 160) : ""));
  }
  return readAnswer(res);
}

async function readAnswer(res) {
  const data = await res.json();
  const choice = data && data.choices && data.choices[0];
  return ((choice && choice.message && choice.message.content) || "").trim();
}

async function translate(text, opts) {
  const o = opts || {};
  if (o.engine === "ai") return ai(text, o.sourceLanguage, o.targetLanguage, o.ai, o.fetch);
  return google(text, o.sourceLanguage, o.targetLanguage, o.fetch);
}

module.exports = { chunk, parseGoogle, google, ai, aiBody, translate, MAX_CHUNK };
