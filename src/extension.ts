import * as vscode from "vscode";
import { analyzeDocument, RuleMatch, ScanReport } from "./analyzer";
import { AiRefactorSuggestion, generateAiIssueSuggestions, saveAiApiKey, validateAiFullReplacement, validateAiReplacement } from "./ai";

const diagnosticCollection = vscode.languages.createDiagnosticCollection("codezero");

export function activate(context: vscode.ExtensionContext): void {
  const findingsProvider = new FindingsProvider();
  const dashboardProvider = new DashboardProvider(context.extensionUri);
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  let activeRefactorAbort: AbortController | undefined;
  statusBarItem.command = "codezero.scanCurrentFile";
  statusBarItem.name = "CodeZero Eco Score";

  context.subscriptions.push(
    diagnosticCollection,
    statusBarItem,
    vscode.window.registerTreeDataProvider("codezero.findings", findingsProvider),
    vscode.window.registerWebviewViewProvider("codezero.dashboard", dashboardProvider)
  );

  const refreshFromDocument = (document: vscode.TextDocument | undefined): void => {
    void refreshDiagnosticsForDocument(document);
  };

  const refreshDiagnosticsForDocument = async (document: vscode.TextDocument | undefined): Promise<void> => {
    if (!document || !isSupportedDocument(document)) {
      findingsProvider.setReport(undefined);
      dashboardProvider.setReport(undefined);
      statusBarItem.hide();
      return;
    }

    const report = await analyzeDocument(document);
    diagnosticCollection.set(
      document.uri,
      report.findings.filter((finding) => shouldIncludeSeverity(finding.severity)).map(toDiagnostic)
    );

    findingsProvider.setReport(report);
    dashboardProvider.setReport(report);
    statusBarItem.text = `$(leaf) CodeZero ${report.ecoScore}`;
    statusBarItem.tooltip = `${report.findings.length} finding(s), estimated ${formatCarbon(report.estimatedCarbonGrams)} CO2e`;
    statusBarItem.show();
  };

  if (vscode.window.activeTextEditor) {
    refreshFromDocument(vscode.window.activeTextEditor.document);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => refreshFromDocument(document)),
    vscode.workspace.onDidChangeTextDocument((event) => refreshFromDocument(event.document)),
    vscode.window.onDidChangeActiveTextEditor((editor) => refreshFromDocument(editor?.document)),
    vscode.workspace.onDidCloseTextDocument((document) => {
      diagnosticCollection.delete(document.uri);
      if (vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString()) {
        refreshFromDocument(undefined);
      }
    })
  );

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider({ scheme: "file" }, new CodeZeroActionProvider(), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
    }),
    vscode.commands.registerCommand("codezero.scanCurrentFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage("CodeZero needs an open editor to scan.");
        return;
      }

      const report = await analyzeDocument(editor.document);
      refreshFromDocument(editor.document);
      await showReportPanel(editor.document, report);
    }),
    vscode.commands.registerCommand("codezero.aiRefactorCurrentFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        void vscode.window.showInformationMessage("CodeZero needs an open editor to generate an AI refactor.");
        return;
      }

      const report = await analyzeDocument(editor.document);
      if (report.findings.length === 0) {
        void vscode.window.showInformationMessage("CodeZero found nothing to refactor in the current file.");
        return;
      }

      if (activeRefactorAbort) {
        const stopCurrent = "Stop current refactor";
        const choice = await vscode.window.showWarningMessage(
          "CodeZero is already generating a refactor.",
          stopCurrent
        );
        if (choice === stopCurrent) {
          activeRefactorAbort.abort();
        }
        return;
      }

      const abortController = new AbortController();
      activeRefactorAbort = abortController;
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "CodeZero is generating a green refactor",
          cancellable: true
        },
        async (_progress, token) => {
          token.onCancellationRequested(() => abortController.abort());
          try {
            const suggestions = await generateAiIssueSuggestions(editor.document, report, context.secrets, abortController.signal);
            const panel = vscode.window.createWebviewPanel("codezeroAiRefactor", "CodeZero AI Refactor", vscode.ViewColumn.Beside, {
              enableFindWidget: true,
              enableScripts: true
            });
            const documentUri = editor.document.uri;
            const originalFullText = editor.document.getText();
            const originalSnippets = report.findings.map((finding) => editor.document.getText(finding.range));
            panel.webview.html = renderAiSuggestionHtml(editor.document.fileName, report, suggestions);
            panel.webview.onDidReceiveMessage(async (message: { command?: string; findingIndex?: number; replacement?: string }) => {
              if (message.command === "replaceDocument" && typeof message.replacement === "string") {
                const currentDocument = await vscode.workspace.openTextDocument(documentUri);
                if (currentDocument.getText() !== originalFullText) {
                  void vscode.window.showWarningMessage("This file changed since the AI suggestions were generated. Run CodeZero AI Refactor again before replacing the whole file.");
                  return;
                }

                const validation = await validateAiFullReplacement(currentDocument, message.replacement);
                if (!validation.ok) {
                  void vscode.window.showErrorMessage(`CodeZero did not apply the full AI refactor because validation failed. ${validation.message ?? ""}`);
                  return;
                }

                const edit = new vscode.WorkspaceEdit();
                const fullRange = new vscode.Range(
                  currentDocument.positionAt(0),
                  currentDocument.positionAt(currentDocument.getText().length)
                );
                edit.replace(documentUri, fullRange, message.replacement);
                const applied = await vscode.workspace.applyEdit(edit);
                if (applied) {
                  void vscode.window.showInformationMessage("CodeZero applied the full AI refactor.");
                } else {
                  void vscode.window.showErrorMessage("CodeZero could not apply the full AI refactor.");
                }
                return;
              }

              if (message.command !== "replaceFinding" || typeof message.findingIndex !== "number" || typeof message.replacement !== "string") {
                return;
              }

              const finding = report.findings[message.findingIndex];
              if (!finding) {
                return;
              }

              const currentDocument = await vscode.workspace.openTextDocument(documentUri);
              if (currentDocument.getText(finding.range) !== originalSnippets[message.findingIndex]) {
                void vscode.window.showWarningMessage("This file changed since the AI suggestions were generated. Run CodeZero AI Refactor again before applying more changes.");
                return;
              }

              const validation = await validateAiReplacement(currentDocument, message.replacement, finding.range);
              if (!validation.ok) {
                void vscode.window.showErrorMessage(`CodeZero did not apply this AI replacement because validation failed. ${validation.message ?? ""}`);
                return;
              }

              const edit = new vscode.WorkspaceEdit();
              edit.replace(documentUri, finding.range, message.replacement);
              const applied = await vscode.workspace.applyEdit(edit);
              if (applied) {
                void vscode.window.showInformationMessage(`CodeZero applied: ${finding.title}`);
              } else {
                void vscode.window.showErrorMessage(`CodeZero could not apply: ${finding.title}`);
              }
            });
          } catch (error) {
            if (abortController.signal.aborted) {
              void vscode.window.showInformationMessage("CodeZero AI refactor stopped.");
              return;
            }
            const message = error instanceof Error ? error.message : "Unknown AI refactor error.";
            void vscode.window.showErrorMessage(message);
          } finally {
            if (activeRefactorAbort === abortController) {
              activeRefactorAbort = undefined;
            }
          }
        }
      );
    }),
    vscode.commands.registerCommand("codezero.stopAiRefactor", () => {
      if (!activeRefactorAbort) {
        void vscode.window.showInformationMessage("CodeZero is not currently generating a refactor.");
        return;
      }
      activeRefactorAbort.abort();
    }),
    vscode.commands.registerCommand("codezero.configureAi", async () => {
      await configureAiRefactor(context);
    }),
    vscode.commands.registerCommand("codezero.refresh", () => refreshFromDocument(vscode.window.activeTextEditor?.document)),
    vscode.commands.registerCommand("codezero.openFinding", async (finding: RuleMatch) => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }

      editor.selection = new vscode.Selection(finding.range.start, finding.range.end);
      editor.revealRange(finding.range, vscode.TextEditorRevealType.InCenter);
    })
  );
}

async function configureAiRefactor(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration("codezero");
  const provider = await vscode.window.showQuickPick(
    [
      { label: "CodeZero Hosted AI", value: "codezero" as const, model: "gemini-2.5-flash" },
      { label: "OpenAI", value: "openai" as const, model: "gpt-4o-mini" },
      { label: "Gemini", value: "gemini" as const, model: "gemini-2.5-flash" }
    ],
    {
      placeHolder: "Choose the AI provider for CodeZero refactors"
    }
  );

  if (!provider) {
    return;
  }

  const defaultModel = config.get<string>("aiProvider") === provider.value ? config.get<string>("aiModel", provider.model) : provider.model;
  const model = await vscode.window.showInputBox({
    title: "CodeZero AI model",
    prompt: `Model to use for ${provider.label}`,
    value: defaultModel,
    ignoreFocusOut: true
  });

  if (model === undefined) {
    return;
  }

  if (provider.value === "codezero") {
    const endpoint = await vscode.window.showInputBox({
      title: "CodeZero hosted AI endpoint",
      prompt: "The published extension calls this backend. Keep Gemini/OpenAI keys on the server.",
      value: config.get<string>("hostedAiEndpoint", "https://api.codezero.dev/v1/refactor"),
      ignoreFocusOut: true
    });

    if (endpoint === undefined) {
      return;
    }

    await config.update("aiProvider", provider.value, vscode.ConfigurationTarget.Global);
    await config.update("aiModel", model.trim() || provider.model, vscode.ConfigurationTarget.Global);
    await config.update("hostedAiEndpoint", endpoint.trim(), vscode.ConfigurationTarget.Global);

    void vscode.window.showInformationMessage("CodeZero AI refactor is configured for the hosted backend.");
    return;
  }

  const apiKey = await vscode.window.showInputBox({
    title: `${provider.label} API key`,
    prompt: "Stored securely in VS Code Secret Storage for this extension.",
    password: true,
    ignoreFocusOut: true
  });

  if (apiKey === undefined) {
    return;
  }

  await config.update("aiProvider", provider.value, vscode.ConfigurationTarget.Global);
  await config.update("aiModel", model.trim() || provider.model, vscode.ConfigurationTarget.Global);
  if (apiKey.trim()) {
    await saveAiApiKey(provider.value, apiKey, context.secrets);
  }

  void vscode.window.showInformationMessage(`CodeZero AI refactor is configured for ${provider.label}.`);
}

export function deactivate(): void {
  diagnosticCollection.dispose();
}

class FindingsProvider implements vscode.TreeDataProvider<FindingTreeItem> {
  private readonly emitter = new vscode.EventEmitter<FindingTreeItem | void>();
  private report: ScanReport | undefined;

  readonly onDidChangeTreeData = this.emitter.event;

  setReport(report: ScanReport | undefined): void {
    this.report = report;
    this.emitter.fire();
  }

  getTreeItem(element: FindingTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): FindingTreeItem[] {
    if (!this.report) {
      return [new FindingTreeItem("Open a supported file to scan with CodeZero.", undefined, "empty")];
    }

    const findings = this.report.findings.filter((finding) => shouldIncludeSeverity(finding.severity));
    if (findings.length === 0) {
      return [new FindingTreeItem(`Eco score ${this.report.ecoScore}: no issues found.`, undefined, "empty")];
    }

    return findings.map(
      (finding) => new FindingTreeItem(`${finding.title}  L${finding.range.start.line + 1}`, finding, finding.severity)
    );
  }
}

class FindingTreeItem extends vscode.TreeItem {
  constructor(label: string, finding: RuleMatch | undefined, contextValue: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = contextValue;

    if (finding) {
      this.description = finding.severity === "warning" ? "warning" : "info";
      this.tooltip = `${finding.message}\n\nSuggestion: ${finding.suggestion ?? "No automatic suggestion available."}`;
      this.command = {
        command: "codezero.openFinding",
        title: "Open finding",
        arguments: [finding]
      };
      this.iconPath = new vscode.ThemeIcon(finding.severity === "warning" ? "warning" : "info");
    }
  }
}

class DashboardProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private report: ScanReport | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: false,
      enableCommandUris: true,
      localResourceRoots: [this.extensionUri]
    };
    this.render();
  }

  setReport(report: ScanReport | undefined): void {
    this.report = report;
    this.render();
  }

  private render(): void {
    if (!this.view) {
      return;
    }

    this.view.webview.html = renderDashboardHtml(this.report);
  }
}

class CodeZeroActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): Thenable<vscode.CodeAction[]> {
    return this.buildActions(document, range, context);
  }

  private async buildActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): Promise<vscode.CodeAction[]> {
    const report = await analyzeDocument(document);
    const sourceDiagnostics = context.diagnostics.filter(
      (diagnostic) =>
        diagnostic.source === "CodeZero" &&
        diagnostic.range.intersection(range) &&
        typeof diagnostic.code === "string"
    );

    const actions: vscode.CodeAction[] = [];

    for (const diagnostic of sourceDiagnostics) {
      const finding = report.findings.find(
        (candidate) => candidate.id === diagnostic.code && candidate.range.isEqual(diagnostic.range)
      );

      if (!finding) {
        continue;
      }

      if (finding.replacement) {
        const fix = new vscode.CodeAction("CodeZero: Replace with greener alternative", vscode.CodeActionKind.QuickFix);
        fix.edit = new vscode.WorkspaceEdit();
        fix.edit.replace(document.uri, finding.range, finding.replacement);
        fix.diagnostics = [diagnostic];
        actions.push(fix);
      }

      const explain = new vscode.CodeAction("CodeZero: Show scan dashboard", vscode.CodeActionKind.QuickFix);
      explain.command = {
        command: "codezero.scanCurrentFile",
        title: "Scan Current File"
      };
      explain.diagnostics = [diagnostic];
      actions.push(explain);

      const aiRefactor = new vscode.CodeAction("CodeZero: AI Refactor Current File", vscode.CodeActionKind.QuickFix);
      aiRefactor.command = {
        command: "codezero.aiRefactorCurrentFile",
        title: "AI Refactor Current File"
      };
      aiRefactor.diagnostics = [diagnostic];
      actions.push(aiRefactor);
    }

    return actions;
  }
}

function toDiagnostic(match: RuleMatch): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(match.range, match.message, toVscodeSeverity(match.severity));
  diagnostic.source = "CodeZero";
  diagnostic.code = match.id;
  return diagnostic;
}

function toVscodeSeverity(severity: RuleMatch["severity"]): vscode.DiagnosticSeverity {
  return severity === "warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information;
}

function isSupportedDocument(document: vscode.TextDocument): boolean {
  return !document.isUntitled && document.uri.scheme === "file" && document.lineCount > 0;
}

function shouldIncludeSeverity(severity: RuleMatch["severity"]): boolean {
  const configured = vscode.workspace.getConfiguration("codezero").get<"info" | "warning">("minimumSeverity", "info");
  return configured === "info" || severity === "warning";
}

async function showReportPanel(document: vscode.TextDocument, report: ScanReport): Promise<void> {
  const panel = vscode.window.createWebviewPanel("codezeroSummary", "CodeZero Scan Report", vscode.ViewColumn.Beside, {
    enableFindWidget: true
  });
  panel.webview.html = renderFullReportHtml(document, report);
}

function renderDashboardHtml(report: ScanReport | undefined): string {
  if (!report) {
    return `<!DOCTYPE html><html lang="en"><body style="font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif); padding: 16px; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background);">
      <section style="border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.12)); border-radius: 8px; padding: 16px; background: var(--vscode-sideBar-background);">
        <h2 style="margin: 0 0 8px; font-size: 1.1rem;">CodeZero</h2>
        <p style="margin: 0 0 8px; color: var(--vscode-descriptionForeground); line-height: 1.45;">Open a file to see its sustainability profile.</p>
        <p style="margin: 0; color: var(--vscode-descriptionForeground); line-height: 1.45;">Architecture: Babel AST analysis with CO2.js estimation.</p>
      </section>
    </body></html>`;
  }

  const warningCount = report.findings.filter((item) => item.severity === "warning").length;
  const infoCount = report.findings.length - warningCount;

  return `<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <style>
        :root {
          color-scheme: dark;
          --bg: var(--vscode-editor-background, #111315);
          --panel: var(--vscode-sideBar-background, #181b1f);
          --panel-strong: var(--vscode-editorWidget-background, #20242a);
          --text: var(--vscode-editor-foreground, #e8eaed);
          --muted: var(--vscode-descriptionForeground, #9aa4ad);
          --border: var(--vscode-panel-border, rgba(255,255,255,0.12));
          --accent: var(--vscode-button-background, #2f7d62);
          --accent-text: var(--vscode-button-foreground, #ffffff);
          --warning: var(--vscode-editorWarning-foreground, #f2cc60);
          --info: var(--vscode-editorInfo-foreground, #75beff);
        }
        * { box-sizing: border-box; }
        body {
          margin: 0;
          padding: 16px;
          font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
          background: var(--bg);
          color: var(--text);
        }
        .hero, .card {
          background: var(--panel);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 16px;
          margin-bottom: 12px;
        }
        .hero {
          background: linear-gradient(135deg, rgba(47, 125, 98, 0.16), rgba(117, 190, 255, 0.06)), var(--panel);
        }
        .hero h2, .card h3, p {
          margin: 0;
        }
        .hero h2 {
          font-size: 1.25rem;
          line-height: 1.25;
          margin: 8px 0 10px;
        }
        .card h3 {
          font-size: 0.98rem;
          margin-bottom: 10px;
        }
        .grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
          margin-top: 14px;
        }
        .metric {
          border: 1px solid var(--border);
          border-radius: 7px;
          padding: 9px 10px;
          background: var(--panel-strong);
        }
        .metric strong {
          display: block;
          font-size: 1.05rem;
          line-height: 1.25;
        }
        .metric span, .muted { color: var(--muted); }
        .pill {
          display: inline-block;
          padding: 3px 9px;
          border-radius: 999px;
          font-size: 0.76rem;
          color: var(--accent-text);
          background: var(--accent);
          border: 1px solid transparent;
        }
        .actions {
          display: grid;
          gap: 8px;
          margin-top: 14px;
        }
        .action-button {
          display: block;
          width: 100%;
          border-radius: 6px;
          padding: 9px 11px;
          color: var(--accent-text);
          background: var(--accent);
          text-decoration: none;
          text-align: center;
          font-weight: 600;
        }
        .action-button:hover {
          filter: brightness(1.08);
        }
        .action-button.secondary {
          color: var(--text);
          background: var(--panel-strong);
          border: 1px solid var(--border);
        }
        ul {
          display: grid;
          gap: 8px;
          padding-left: 18px;
          margin: 0;
          color: var(--muted);
          line-height: 1.45;
        }
        code {
          padding: 1px 5px;
          border-radius: 4px;
          background: var(--panel-strong);
          color: var(--text);
        }
      </style>
    </head>
    <body>
      <section class="hero">
        <span class="pill">Eco score ${report.ecoScore}</span>
        <h2>${escapeHtml(baseName(report.fileName))}</h2>
        <p class="muted">Engine: ${report.engine === "ast" ? "Babel AST" : report.engine === "parser" ? "Language Parser" : "Heuristic fallback"} &middot; Carbon model: CO2.js SWD v4</p>
        <div class="grid">
          <div class="metric"><strong>${report.findings.length}</strong><span class="muted">Total findings</span></div>
          <div class="metric"><strong>${formatCarbon(report.estimatedCarbonGrams)}</strong><span class="muted">Estimated CO2e</span></div>
          <div class="metric"><strong>${formatCarbon(report.potentialSavingsGrams)}</strong><span class="muted">Potential savings</span></div>
          <div class="metric"><strong>${formatBytes(report.sourceBytes)}</strong><span class="muted">Source size</span></div>
          <div class="metric"><strong>${formatBytes(report.estimatedTransferredBytes)}</strong><span class="muted">Modeled transfer</span></div>
        </div>
        <div class="actions">
          <a class="action-button" href="command:codezero.aiRefactorCurrentFile">AI Refactor Current File</a>
          <a class="action-button secondary" href="command:codezero.scanCurrentFile">Open Full Report</a>
        </div>
      </section>
      <section class="card">
        <h3>Breakdown</h3>
        <ul>
          <li>${warningCount} warnings</li>
          <li>${infoCount} infos</li>
          <li>Static analysis architecture: AST parser with fallback heuristics</li>
          <li>AI refactor models: <code>gpt-4o-mini</code> or <code>gemini-2.5-flash</code> by configuration</li>
        </ul>
      </section>
      <section class="card">
        <h3>Top findings</h3>
        <ul>${report.findings.slice(0, 5).map((finding) => `<li>${escapeHtml(finding.title)} on line ${finding.range.start.line + 1}</li>`).join("") || "<li>No findings.</li>"}</ul>
      </section>
    </body>
  </html>`;
}

function renderFullReportHtml(document: vscode.TextDocument, report: ScanReport): string {
  const rows = report.findings
    .map((finding) => {
      const suggestion = finding.suggestion ? `<p>${escapeHtml(finding.suggestion)}</p>` : "";
      return `
        <article class="card ${finding.severity}">
          <div class="meta">
            <span>${finding.severity.toUpperCase()}</span>
            <span>Line ${finding.range.start.line + 1}</span>
            <span>${escapeHtml(finding.category)}</span>
          </div>
          <h3>${escapeHtml(finding.title)}</h3>
          <p>${escapeHtml(finding.message)}</p>
          <p>Estimated waste model: ${formatBytes(finding.estimatedBytes)}</p>
          <p>Estimated savings if fixed: ${formatCarbon(finding.estimatedSavingsGrams)}</p>
          ${suggestion}
        </article>
      `;
    })
    .join("");

  return `<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>CodeZero Report</title>
      <style>
        :root {
          color-scheme: dark;
          --text: #eef6ef;
          --muted: #9eb7a4;
          --info: #92c9ff;
          --warn: #ffd166;
        }
        body {
          margin: 0;
          font-family: Georgia, "Times New Roman", serif;
          background:
            radial-gradient(circle at top left, rgba(97, 208, 149, 0.16), transparent 32%),
            linear-gradient(160deg, #09110c 0%, #102117 100%);
          color: var(--text);
        }
        main {
          max-width: 980px;
          margin: 0 auto;
          padding: 32px 20px 40px;
        }
        h1 { margin-bottom: 6px; font-size: 2rem; }
        .lede { color: var(--muted); margin-top: 0; margin-bottom: 24px; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
        .stat, .card {
          border: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(20, 35, 26, 0.88);
          border-radius: 16px;
          padding: 16px;
        }
        .stat strong { display: block; font-size: 1.8rem; margin-bottom: 4px; }
        .results { display: grid; gap: 12px; }
        .meta { display: flex; gap: 12px; color: var(--muted); font-size: 0.9rem; }
        .warning .meta span:first-child { color: var(--warn); }
        .info .meta span:first-child { color: var(--info); }
      </style>
    </head>
    <body>
      <main>
        <h1>CodeZero Sustainability Report</h1>
        <p class="lede">${escapeHtml(document.fileName)}</p>
        <section class="stats">
          <div class="stat"><strong>${report.findings.length}</strong>Total findings</div>
          <div class="stat"><strong>${report.ecoScore}</strong>Eco score</div>
          <div class="stat"><strong>${formatCarbon(report.estimatedCarbonGrams)}</strong>Estimated CO2e</div>
          <div class="stat"><strong>${formatCarbon(report.potentialSavingsGrams)}</strong>Potential savings</div>
          <div class="stat"><strong>${report.engine === "ast" ? "AST" : report.engine === "parser" ? "Parser" : "Fallback"}</strong>Analysis engine</div>
        </section>
        <section class="results">${rows || "<div class='card'><h3>No findings</h3><p>No obvious energy-heavy patterns were detected.</p></div>"}</section>
      </main>
    </body>
  </html>`;
}

function renderAiSuggestionHtml(fileName: string, report: ScanReport, suggestions: AiRefactorSuggestion): string {
  const nonce = createNonce();
  const warningCount = report.findings.filter((finding) => finding.severity === "warning").length;
  const findingHtml = report.findings
    .map(
      (finding, index) => `
        <button type="button" class="finding-row ${finding.severity}" data-scroll-target="issue-${index}">
          <span class="severity">${finding.severity === "warning" ? "Warning" : "Info"}</span>
          <span class="finding-name">${escapeHtml(finding.title)}</span>
          <span class="finding-line">L${finding.range.start.line + 1}</span>
        </button>
      `
    )
    .join("");
  const issueCards = report.findings
    .map(
      (finding, index) => {
        const suggestion = suggestions.items.find((item) => item.findingIndex === index);
        const replacement = suggestion?.replacement ?? finding.replacement;
        const replacementId = `replacement-${index}`;
        return `
        <article id="issue-${index}" class="issue-card ${finding.severity}">
          <header class="issue-header">
            <div>
              <div class="issue-meta">
                <span class="severity">${finding.severity === "warning" ? "Warning" : "Info"}</span>
                <span>Line ${finding.range.start.line + 1}</span>
                <span>${escapeHtml(finding.category)}</span>
              </div>
              <h2>${escapeHtml(finding.title)}</h2>
            </div>
            <span class="confidence">${escapeHtml(suggestion?.confidence ?? "medium")} confidence</span>
          </header>
          <div class="issue-body">
            <p>${escapeHtml(suggestion?.action ?? finding.suggestion ?? finding.message)}</p>
            ${
              replacement
                ? `<div class="replacement">
                    <div class="replacement-bar">
                      <span>Replacement</span>
                      <div class="actions">
                        <button type="button" class="ghost-button" data-copy-target="${replacementId}">Copy</button>
                        <button type="button" class="primary-button" data-replace-index="${index}" data-replacement-id="${replacementId}">Apply</button>
                      </div>
                    </div>
                    <pre id="${replacementId}" class="code"><code>${escapeHtml(replacement)}</code></pre>
                  </div>`
                : `<div class="guidance">No safe one-click replacement for this issue. Use the recommendation above as guidance.</div>`
            }
          </div>
        </article>`;
      }
    )
    .join("");
  const fullReplacementHtml = suggestions.fullReplacement
    ? `
      <section class="panel full-code-panel">
        <div class="panel-heading">
          <div>
            <span class="eyebrow">Apply everything</span>
            <h2>Complete Refactor</h2>
          </div>
          <div class="actions">
            <button type="button" class="ghost-button" data-copy-target="full-replacement">Copy full code</button>
            <button type="button" class="primary-button" data-replace-document="full-replacement">Replace whole file</button>
          </div>
        </div>
        <pre id="full-replacement" class="code full-code"><code>${escapeHtml(suggestions.fullReplacement)}</code></pre>
      </section>
    `
    : "";

  return `<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <style>
        :root {
          color-scheme: dark;
          --bg: var(--vscode-editor-background, #111315);
          --panel: var(--vscode-sideBar-background, #181b1f);
          --panel-strong: var(--vscode-editorWidget-background, #20242a);
          --text: var(--vscode-editor-foreground, #e8eaed);
          --muted: var(--vscode-descriptionForeground, #9aa4ad);
          --border: var(--vscode-panel-border, rgba(255,255,255,0.12));
          --accent: var(--vscode-button-background, #2f7d62);
          --accent-text: var(--vscode-button-foreground, #ffffff);
          --warning: var(--vscode-editorWarning-foreground, #f2cc60);
          --info: var(--vscode-editorInfo-foreground, #75beff);
          --code-bg: var(--vscode-textCodeBlock-background, #0f1215);
        }
        * {
          box-sizing: border-box;
        }
        body {
          margin: 0;
          font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
          background: var(--bg);
          color: var(--text);
        }
        main {
          max-width: 1180px;
          margin: 0 auto;
          padding: 22px;
        }
        .hero {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
          gap: 18px;
          align-items: start;
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 20px;
          background: linear-gradient(135deg, rgba(47, 125, 98, 0.18), rgba(117, 190, 255, 0.08)), var(--panel);
          margin-bottom: 14px;
        }
        .title-row {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 8px;
        }
        .mark {
          display: grid;
          place-items: center;
          width: 34px;
          height: 34px;
          border-radius: 7px;
          background: var(--accent);
          color: var(--accent-text);
          font-weight: 800;
        }
        h1, h2, h3, p {
          margin: 0;
        }
        h1 {
          font-size: 1.35rem;
          font-weight: 700;
        }
        h2 {
          font-size: 0.98rem;
          font-weight: 700;
        }
        .subtle {
          color: var(--muted);
          line-height: 1.5;
          margin-top: 6px;
        }
        .stats {
          display: grid;
          grid-template-columns: repeat(3, minmax(92px, 1fr));
          gap: 8px;
          min-width: 330px;
        }
        .stat {
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 10px 12px;
          background: rgba(0, 0, 0, 0.16);
        }
        .stat strong {
          display: block;
          font-size: 1.15rem;
          line-height: 1.2;
        }
        .stat span {
          color: var(--muted);
          font-size: 0.78rem;
        }
        .layout {
          display: grid;
          grid-template-columns: minmax(260px, 0.82fr) minmax(0, 1.35fr);
          gap: 14px;
          align-items: start;
        }
        .issue-list {
          display: grid;
          gap: 12px;
          padding: 14px;
        }
        .issue-card {
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--panel);
          overflow: hidden;
        }
        .issue-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
          padding: 14px 16px;
          border-bottom: 1px solid var(--border);
          background: rgba(255, 255, 255, 0.025);
        }
        .issue-meta {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          color: var(--muted);
          font-size: 0.78rem;
          margin-bottom: 7px;
        }
        .severity {
          color: #071926;
          border-radius: 999px;
          padding: 1px 7px;
          background: var(--info);
        }
        .issue-card.warning .severity {
          color: #1f1a06;
          background: var(--warning);
        }
        .confidence {
          flex: 0 0 auto;
          color: var(--muted);
          border: 1px solid var(--border);
          border-radius: 999px;
          padding: 4px 9px;
          font-size: 0.76rem;
          text-transform: capitalize;
        }
        .issue-body {
          display: grid;
          gap: 12px;
          padding: 14px 16px 16px;
        }
        .issue-body p {
          color: var(--text);
          line-height: 1.5;
        }
        .replacement {
          border: 1px solid var(--border);
          border-radius: 7px;
          overflow: hidden;
          background: var(--code-bg);
        }
        .replacement-bar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          padding: 10px 12px;
          border-bottom: 1px solid var(--border);
          color: var(--muted);
          background: rgba(255, 255, 255, 0.035);
        }
        .actions {
          display: flex;
          gap: 8px;
          align-items: center;
        }
        .primary-button, .ghost-button {
          border: 0;
          border-radius: 5px;
          padding: 7px 11px;
          font: inherit;
          cursor: pointer;
        }
        .primary-button {
          background: var(--accent);
          color: var(--accent-text);
        }
        .ghost-button {
          color: var(--text);
          background: var(--panel-strong);
          border: 1px solid var(--border);
        }
        .primary-button:hover, .ghost-button:hover {
          filter: brightness(1.08);
        }
        .guidance {
          color: var(--muted);
          border: 1px dashed var(--border);
          border-radius: 7px;
          padding: 11px 12px;
          line-height: 1.45;
          background: rgba(255, 255, 255, 0.025);
        }
        .finding-list {
          display: grid;
          gap: 8px;
        }
        .finding-row {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) auto;
          gap: 8px;
          align-items: center;
          width: 100%;
          border: 1px solid var(--border);
          border-radius: 7px;
          padding: 9px 10px;
          color: var(--text);
          background: var(--panel-strong);
          font: inherit;
          text-align: left;
          cursor: pointer;
        }
        .finding-row:hover {
          border-color: var(--accent);
        }
        .finding-row.warning .severity {
          color: #1f1a06;
          background: var(--warning);
        }
        .finding-name {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .full-code {
          max-height: 460px;
          overflow: auto;
        }
        .stack {
          display: grid;
          gap: 14px;
        }
        .panel {
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--panel);
          overflow: hidden;
        }
        .panel-heading {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 14px 16px;
          border-bottom: 1px solid var(--border);
          background: rgba(255, 255, 255, 0.025);
        }
        .panel-body {
          padding: 14px 16px 16px;
        }
        .eyebrow {
          display: block;
          color: var(--muted);
          font-size: 0.72rem;
          letter-spacing: 0;
          text-transform: uppercase;
          margin-bottom: 4px;
        }
        .plan-list {
          margin: 0;
          padding-left: 22px;
          display: grid;
          gap: 10px;
          line-height: 1.45;
        }
        .plan-list li::marker {
          color: var(--accent);
          font-weight: 700;
        }
        code.inline {
          padding: 1px 5px;
          border-radius: 4px;
          background: var(--code-bg);
          font-family: var(--vscode-editor-font-family, Consolas, monospace);
          font-size: 0.92em;
        }
        .findings {
          list-style: none;
          margin: 0;
          padding: 0;
          display: grid;
          gap: 8px;
        }
        .finding {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) auto;
          gap: 8px;
          align-items: center;
          border: 1px solid var(--border);
          border-radius: 7px;
          padding: 9px 10px;
          background: var(--panel-strong);
        }
        .finding-kind {
          color: var(--text);
          border-radius: 999px;
          padding: 2px 7px;
          font-size: 0.72rem;
          background: rgba(255, 255, 255, 0.08);
        }
        .finding.warning .finding-kind {
          color: #1f1a06;
          background: var(--warning);
        }
        .finding.info .finding-kind {
          color: #071926;
          background: var(--info);
        }
        .finding-title {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .finding-line {
          color: var(--muted);
          font-family: var(--vscode-editor-font-family, Consolas, monospace);
          font-size: 0.82rem;
        }
        .copy-button {
          border: 0;
          border-radius: 5px;
          padding: 7px 11px;
          background: var(--accent);
          color: var(--accent-text);
          font: inherit;
          cursor: pointer;
        }
        .copy-button:hover {
          filter: brightness(1.08);
        }
        pre {
          margin: 0;
        }
        .code {
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          padding: 16px;
          background: var(--code-bg);
          font-family: var(--vscode-editor-font-family, Consolas, monospace);
          font-size: var(--vscode-editor-font-size, 13px);
          line-height: 1.55;
          tab-size: 2;
        }
        .empty {
          color: var(--muted);
          line-height: 1.5;
        }
        @media (max-width: 860px) {
          main {
            padding: 14px;
          }
          .hero, .layout {
            grid-template-columns: 1fr;
          }
          .stats {
            min-width: 0;
          }
        }
        @media (max-width: 520px) {
          .stats {
            grid-template-columns: 1fr;
          }
        }
      </style>
    </head>
    <body>
      <main>
        <section class="hero">
          <div>
            <div class="title-row">
              <div class="mark">CZ</div>
              <div>
                <h1>AI Refactor Review</h1>
                <p class="subtle">${escapeHtml(baseName(fileName))}</p>
              </div>
            </div>
            <p class="subtle">First review the flagged issues, then choose a focused fix or apply the complete rewritten file.</p>
          </div>
          <div class="stats" aria-label="Refactor summary">
            <div class="stat"><strong>${report.findings.length}</strong><span>Total findings</span></div>
            <div class="stat"><strong>${warningCount}</strong><span>Warnings</span></div>
            <div class="stat"><strong>${formatCarbon(report.potentialSavingsGrams)}</strong><span>Potential savings</span></div>
          </div>
        </section>
        <div class="layout">
          <aside class="stack">
            <section class="panel">
              <div class="panel-heading">
                <div>
                  <span class="eyebrow">Flagged first</span>
                  <h2>Issues Found</h2>
                </div>
              </div>
              <div class="panel-body">
                <div class="finding-list">${findingHtml || "<p class='empty'>No issues were available.</p>"}</div>
              </div>
            </section>
          </aside>
          <section class="stack">
            <section class="panel">
              <div class="panel-heading">
                <div>
                  <span class="eyebrow">Where to change what</span>
                  <h2>Suggested Edits</h2>
                </div>
              </div>
              <div class="issue-list">
                ${issueCards || "<p class='empty'>No issues were available for refactoring.</p>"}
              </div>
            </section>
            ${fullReplacementHtml}
          </section>
        </div>
      </main>
      <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const buttons = document.querySelectorAll("[data-copy-target]");
        buttons.forEach((button) => {
          button.addEventListener("click", async () => {
            const target = document.getElementById(button.dataset.copyTarget);
            if (!target) {
              return;
            }
            await navigator.clipboard.writeText(target.innerText);
            const original = button.textContent;
            button.textContent = "Copied";
            setTimeout(() => {
              button.textContent = original;
            }, 1200);
          });
        });
        document.querySelectorAll("[data-replace-index]").forEach((button) => {
          button.addEventListener("click", () => {
            const target = document.getElementById(button.dataset.replacementId);
            if (!target) {
              return;
            }
            vscode.postMessage({
              command: "replaceFinding",
              findingIndex: Number(button.dataset.replaceIndex),
              replacement: target.innerText
            });
            const original = button.textContent;
            button.textContent = "Applied";
            setTimeout(() => {
              button.textContent = original;
            }, 1200);
          });
        });
        document.querySelectorAll("[data-replace-document]").forEach((button) => {
          button.addEventListener("click", () => {
            const target = document.getElementById(button.dataset.replaceDocument);
            if (!target) {
              return;
            }
            vscode.postMessage({
              command: "replaceDocument",
              replacement: target.innerText
            });
            const original = button.textContent;
            button.textContent = "Applied";
            setTimeout(() => {
              button.textContent = original;
            }, 1200);
          });
        });
        document.querySelectorAll("[data-scroll-target]").forEach((button) => {
          button.addEventListener("click", () => {
            document.getElementById(button.dataset.scrollTarget)?.scrollIntoView({ behavior: "smooth", block: "start" });
          });
        });
      </script>
    </body>
  </html>`;
}

function renderInlineMarkdown(value: string): string {
  const escaped = escapeHtml(value);
  return escaped.replace(/`([^`]+)`/g, "<code class=\"inline\">$1</code>");
}

function createNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let index = 0; index < 24; index += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function baseName(fileName: string): string {
  return fileName.split(/[\\/]/).pop() ?? fileName;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatCarbon(grams: number): string {
  if (grams < 0.001) {
    return `${(grams * 1000).toFixed(2)} mg`;
  }
  return `${grams.toFixed(4)} g`;
}
