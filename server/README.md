# CodeZero AI Proxy

This proxy keeps provider API keys off the published VS Code extension. The extension sends its refactor prompt to `/v1/refactor`; this server calls Gemini and returns the model text as `{ "content": "..." }`.

## Local run

```powershell
$env:GEMINI_API_KEY="your-gemini-key"
node .\server\refactor-proxy.js
```

For local extension testing, set:

```json
{
  "codezero.aiProvider": "codezero",
  "codezero.hostedAiEndpoint": "http://localhost:8787/v1/refactor",
  "codezero.aiModel": "gemini-2.5-flash"
}
```

## Publish setup

Deploy this behind HTTPS, set `GEMINI_API_KEY` in the hosting environment, then update the extension's default `codezero.hostedAiEndpoint` before publishing.

Do not put `GEMINI_API_KEY` in `package.json`, `src`, webview HTML, bundled assets, or the `.vsix`. Anything shipped with the extension is visible to users.
