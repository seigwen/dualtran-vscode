# DualTran for VS Code

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/seigwenlee.dualtran?label=VS%20Code&logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=seigwenlee.dualtran)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/seigwenlee.dualtran)](https://marketplace.visualstudio.com/items?itemName=seigwenlee.dualtran)

Translate the selection without leaving the editor. The translation appears **inline at the end of the line**
(press `Esc` to clear it), or **side by side** in a panel.

- **Google** — no account, no key.
- **AI (BYOK)** — any OpenAI-compatible endpoint: OpenAI, Azure OpenAI, OpenRouter, DeepSeek,
  Groq, Together, Ollama, LM Studio, …
- The API key lives in VS Code `SecretStorage` (the OS keychain), never in settings.json.

## Commands

| Command | Shortcut | What it does |
|---|---|---|
| DualTran: Translate Selection (inline) | `Ctrl+Alt+T` / `Cmd+Alt+T` | Ghost line under the selection (or the current line) |
| DualTran: Translate Selection (side panel) | — | Source and translation side by side |
| DualTran: Translate and Replace Selection | — | Overwrite the selection with the translation |
| DualTran: Clear Inline Translations | `Esc` | Remove ghost lines |
| DualTran: Pick Target Language | — | Quick pick, saved to settings |
| DualTran: Choose AI Provider | — | Quick pick: built-in providers, then everything models.dev lists |
| DualTran: Refresh Provider Catalogue (models.dev) | — | Drop the cached catalogue and fetch it again |
| DualTran: Set AI API Key | — | Stored in the OS keychain |

## Settings

```jsonc
{
  "dualtran.engine": "google",          // or "ai"
  "dualtran.sourceLanguage": "auto",
  "dualtran.targetLanguage": "zh-CN",
  "dualtran.ai.endpoint": "https://api.openai.com/v1",
  "dualtran.ai.model": "gpt-4o-mini"
}
```

For a local model with Ollama: endpoint `http://127.0.0.1:11434/v1`, model `qwen2.5-coder:7b`,
any non-empty key.

## Install

From the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=seigwenlee.dualtran):

```bash
code --install-extension seigwenlee.dualtran
```

Or search **DualTran** in the Extensions view. Offline install: download the `.vsix` from
[Releases](https://github.com/seigwen/dualtran-vscode/releases) and run
`code --install-extension dualtran-0.1.0.vsix`.

## Privacy

The extension collects nothing. Text is sent only to the engine you choose (Google, or your own
endpoint). No DualTran server is involved.

## License

MIT.
