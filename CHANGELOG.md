# Changelog

## 0.2.0

- Interface localisation: 38 language catalogues (`locales/<code>/messages.json`), generated into
  `package.nls.<locale>.json` (commands, settings) and `l10n/bundle.l10n.<locale>.json` (notifications,
  status bar, quick picks) — VS Code applies the languages its own UI supports.
- `npm run i18n:sync` / `i18n:check`; `npm run verify` fails when a locale falls behind.

## 0.1.0

- Inline ghost-line translation, side panel, replace-selection.
- Google engine (no key) and AI engine (OpenAI-compatible, key in SecretStorage).
- Target language quick pick; `Esc` clears decorations.
