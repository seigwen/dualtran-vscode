# Changelog

## Unreleased (SPEC 2.1)

- A fresh install has **no AI provider**: `dualtran.ai.provider` defaults to `""` and the
  settings dropdown shows a disabled "Select a provider" item (`enumItemLabels`); the endpoint
  and model start empty. Nothing falls back to OpenAI.
- `dualtran.ai.endpoint` / `dualtran.ai.model` are filled by **DualTran: Choose AI Provider**
  (the endpoint gets the provider's API base); a hand-edited endpoint survives a provider switch.
- An AI translation without a provider reports "Choose an AI provider in settings before
  translating." and sends no request; the status-bar translate action is shown disabled with
  that tooltip.
- New catalogue strings `providerPlaceholder`, `providerRequiredForModel`, `providerRequiredError`
  (and `statusTranslateAction`) in all 38 locales; `npm run i18n:merge` adds a release's new keys.
- Conformance kit bumped to 2.1.0 (payload carries both the unconfigured and configured states).

## 0.2.0

- Interface localisation: 38 language catalogues (`locales/<code>/messages.json`), generated into
  `package.nls.<locale>.json` (commands, settings) and `l10n/bundle.l10n.<locale>.json` (notifications,
  status bar, quick picks) — VS Code applies the languages its own UI supports.
- `npm run i18n:sync` / `i18n:check`; `npm run verify` fails when a locale falls behind.

## 0.1.0

- Inline ghost-line translation, side panel, replace-selection.
- Google engine (no key) and AI engine (OpenAI-compatible, key in SecretStorage).
- Target language quick pick; `Esc` clears decorations.
