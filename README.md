# CodeZero

CodeZero is a VS Code extension that scans source files for energy-heavy coding patterns and suggests greener alternatives before they turn into production waste.

## What this MVP does

- Scans the active editor with AST-based static analysis for JavaScript and TypeScript.
- Falls back to heuristic scanning for Python and Java when AST parsing is not available.
- Uses `CO2.js` to estimate the carbon impact of the file plus modeled waste from flagged patterns.
- Adds inline diagnostics, quick fixes, a CodeZero activity bar UI, a findings tree, and a full scan report panel.

## Architecture

- `Carbon library`: `CO2.js` by The Green Web Foundation using the Sustainable Web Design model (`swd`, version `4`).
- `Static analysis`: Babel AST parsing and traversal for JS/TS files, with heuristic fallback for non-AST languages in this MVP.

## Included rules

- `Polling timer`: flags `setInterval(..., 1000)` and faster intervals.
- `Nested loop`: warns on nested loops that often scale poorly.
- `Wildcard import`: flags `import * as ...` because it tends to increase bundle size.
- `Repeated array scan`: flags `.filter(...).length` and recommends `.some(...)`.
- `Verbose logging`: flags frequent `console.log` usage in hot paths.
- `Remote call in loop`: flags likely network or database calls inside loops.

These are heuristics, not full program analysis. The goal is to surface likely waste early and educate the developer while they code.

## Getting started

```powershell
npm.cmd install
npm.cmd run build
```

Then open this folder in VS Code and run the extension with `F5`.

## UI

- `Activity Bar`: open the `CodeZero` icon to view the persistent sidebar.
- `Dashboard`: shows eco score, estimated CO2e, source size, transfer model, and engine details.
- `Findings`: clickable list of sustainability issues that jumps to the matching line in the editor.
- `Status Bar`: shows the current file's eco score.
- `Command Palette`: run `CodeZero: Scan Current File` for a full report webview.
- `AI Refactor`: run `CodeZero: AI Refactor Current File` to request a greener rewrite from the configured CodeZero hosted AI backend. Development fallback providers are still available through `CodeZero: Configure AI Refactor`, but published builds should keep provider API keys on a server, not inside the extension.

## Hosted AI for Marketplace Builds

CodeZero defaults to the `codezero` AI provider, which calls `codezero.hostedAiEndpoint` instead of asking each user for an API key. Deploy the proxy from this repository's `server/refactor-proxy.js` behind HTTPS, set `GEMINI_API_KEY` in the hosting environment, then point `codezero.hostedAiEndpoint` at that URL before publishing.

Do not embed Gemini or OpenAI keys in the extension package. A published `.vsix` can be inspected by users, so shipped keys should be treated as public.

## Demo Files

- `demo/codezero-test.ts`: intentionally inefficient sample to trigger findings.
- `demo/codezero-green.ts`: greener version of the same workflow for side-by-side comparison.

## Example quick fixes

- Replace `items.filter(predicate).length > 0` with `items.some(predicate)`
- Replace `import * as utils from "./utils"` with a named import placeholder
- Replace `setInterval(..., 500)` with `setTimeout(..., 5000)` guidance

## Next steps

- Add ESLint custom rules as an optional export path for CI enforcement.
- Expand AST support to Python and Java with dedicated parsers.
- Connect the dashboard to an AI explanation service for deeper refactoring help.
