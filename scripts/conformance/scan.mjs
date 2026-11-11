#!/usr/bin/env node
/**
 * Static anti-pattern scan for host conformance.
 *
 * config: { files: ["src/settings.ts"], patterns: ["providerSeparator", {"token":"target-input","regex":"<input[^>]+id=\"target\""}] }
 * Returns [{file, line, token, text}] so the payload validator can fail on it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function normalizePattern(entry) {
  if (typeof entry === "string") {
    return { token: entry, regex: new RegExp(escapeRegExp(entry), "g") };
  }
  if (entry && typeof entry === "object" && entry.regex) {
    return { token: entry.token || entry.regex, regex: new RegExp(entry.regex, entry.flags || "g") };
  }
  throw new Error(`invalid static pattern: ${JSON.stringify(entry)}`);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function scanFiles(root, config) {
  const files = Array.isArray(config.files) ? config.files : [];
  const patterns = (Array.isArray(config.patterns) ? config.patterns : []).map(normalizePattern);
  const allow = new Set(Array.isArray(config.allow) ? config.allow : []);
  const hits = [];
  for (const relative of files) {
    if (allow.has(relative)) continue;
    let text;
    try {
      text = readFileSync(resolve(root, relative), "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!pattern.regex.test(line)) continue;
        pattern.regex.lastIndex = 0;
        if (allow.has(`${relative}:${index + 1}`)) continue;
        hits.push({
          file: relative,
          line: index + 1,
          token: pattern.token,
          text: line.trim().slice(0, 200),
        });
      }
    }
  }
  return hits;
}
