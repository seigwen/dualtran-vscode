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

async function ai(text, sourceLang, targetLang, cfg, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  if (!cfg || !cfg.endpoint || !cfg.model || !cfg.key) {
    throw new Error("AI mode needs an endpoint, a model and an API key.");
  }
  const base = cfg.endpoint.replace(/\/+$/, "");
  const res = await doFetch(base + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + cfg.key },
    body: JSON.stringify({
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
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error("AI translation failed: HTTP " + res.status + (body ? " — " + body.slice(0, 160) : ""));
  }
  const data = await res.json();
  const choice = data && data.choices && data.choices[0];
  return ((choice && choice.message && choice.message.content) || "").trim();
}

async function translate(text, opts) {
  const o = opts || {};
  if (o.engine === "ai") return ai(text, o.sourceLanguage, o.targetLanguage, o.ai, o.fetch);
  return google(text, o.sourceLanguage, o.targetLanguage, o.fetch);
}

module.exports = { chunk, parseGoogle, google, ai, translate, MAX_CHUNK };
