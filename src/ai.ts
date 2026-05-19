import { parse } from "@babel/parser";
import { parser as pythonParser } from "@lezer/python";
import * as vscode from "vscode";
import { analyzeDocument, RuleMatch, ScanReport } from "./analyzer";

type ApiKeyProvider = "openai" | "gemini";
type Provider = "codezero" | ApiKeyProvider;
type AiRequester = (prompt: string, signal?: AbortSignal) => Promise<string>;

export interface AiIssueSuggestion {
  findingIndex: number;
  action: string;
  replacement?: string;
  confidence: "high" | "medium" | "low";
}

export interface AiRefactorSuggestion {
  items: AiIssueSuggestion[];
  fullReplacement?: string;
}

export interface AiReplacementValidation {
  ok: boolean;
  message?: string;
}

interface ReplacementInspection {
  ok: boolean;
  problems: string[];
  document?: vscode.TextDocument;
  report?: ScanReport;
}

interface JavaCstNode {
  name?: string;
  location?: {
    startOffset: number;
    endOffset: number;
  };
  children?: Record<string, JavaCstNode[]>;
}

const secretKeys: Record<ApiKeyProvider, string> = {
  openai: "codezero.openAIApiKey",
  gemini: "codezero.googleApiKey"
};

const defaultHostedAiEndpoint = "https://api.codezero.dev/v1/refactor";
let javaParserModulePromise: Promise<{ parse: (input: string) => JavaCstNode }> | undefined;

export async function generateAiIssueSuggestions(
  document: vscode.TextDocument,
  report: ScanReport,
  secrets?: vscode.SecretStorage,
  signal?: AbortSignal
): Promise<AiRefactorSuggestion> {
  const config = vscode.workspace.getConfiguration("codezero");
  const provider = config.get<Provider>("aiProvider", "codezero");
  const model = normalizeModel(provider, config.get<string>("aiModel", ""));
  const prompt = buildIssuePrompt(document, report);
  const requestSuggestion = await createAiRequester(provider, config, secrets, model);

  const responseText = await requestSuggestion(prompt, signal);
  const draftResult = parseIssueResponse(responseText);
  const bestResult = await repairRemainingFindings(document, report, draftResult, requestSuggestion, signal);
  const normalizedItems = normalizeIssueSuggestions(bestResult.items, report.findings);

  return {
    items: await validateIssueSuggestions(document, report, normalizedItems),
    fullReplacement: await getSafeFullReplacement(document, bestResult.fullReplacement)
  };
}

export async function saveAiApiKey(provider: ApiKeyProvider, apiKey: string, secrets: vscode.SecretStorage): Promise<void> {
  await secrets.store(secretKeys[provider], apiKey.trim());
}

export async function validateAiReplacement(
  document: vscode.TextDocument,
  replacement: string,
  range?: vscode.Range
): Promise<AiReplacementValidation> {
  const fullText = range ? replaceRange(document, range, replacement) : replacement;
  const inspection = await inspectReplacementDocument(document, fullText, false);
  return {
    ok: inspection.ok,
    message: inspection.problems.join(" ")
  };
}

export async function validateAiFullReplacement(
  document: vscode.TextDocument,
  replacement: string
): Promise<AiReplacementValidation> {
  const inspection = await inspectReplacementDocument(document, replacement, true);
  return {
    ok: inspection.ok,
    message: inspection.problems.join(" ")
  };
}

function normalizeModel(provider: Provider, configuredModel: string): string {
  const model = configuredModel.trim();
  if (provider === "codezero" || provider === "gemini") {
    if (!model || model.startsWith("gpt-") || model.startsWith("o1-") || model.startsWith("o3-") || model.startsWith("o4-")) {
      return "gemini-2.5-flash";
    }
    return model.startsWith("models/") ? model.slice("models/".length) : model;
  }

  if (!model || !(model.startsWith("gpt-") || model.startsWith("o1-") || model.startsWith("o3-") || model.startsWith("o4-"))) {
    return "gpt-4o-mini";
  }
  return model;
}

async function createAiRequester(
  provider: Provider,
  config: vscode.WorkspaceConfiguration,
  secrets: vscode.SecretStorage | undefined,
  model: string
): Promise<AiRequester> {
  if (provider === "codezero") {
    const endpoint = normalizeHostedAiEndpoint(config.get<string>("hostedAiEndpoint", defaultHostedAiEndpoint));
    return (prompt, signal) => requestHostedSuggestion(endpoint, model, prompt, signal);
  }

  const apiKey = await getApiKey(provider, config, secrets);
  if (!apiKey) {
    throw new Error(
      provider === "openai"
        ? "Run 'CodeZero: Configure AI Refactor' or set codezero.openAIApiKey to use OpenAI refactoring suggestions."
        : "Run 'CodeZero: Configure AI Refactor' or set codezero.googleApiKey to use Gemini refactoring suggestions."
    );
  }

  return provider === "openai"
    ? (prompt, signal) => requestOpenAiSuggestion(apiKey, model, prompt, signal)
    : (prompt, signal) => requestGeminiSuggestion(apiKey, model, prompt, signal);
}

function normalizeHostedAiEndpoint(configuredEndpoint: string | undefined): string {
  const endpoint = (configuredEndpoint ?? defaultHostedAiEndpoint).trim();
  if (!endpoint) {
    throw new Error("CodeZero hosted AI endpoint is not configured. Set codezero.hostedAiEndpoint before publishing.");
  }

  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("codezero.hostedAiEndpoint must be a valid URL.");
  }

  const isLocalhost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost)) {
    throw new Error("codezero.hostedAiEndpoint must use HTTPS, except for localhost development.");
  }

  return url.toString();
}

async function getApiKey(
  provider: ApiKeyProvider,
  config: vscode.WorkspaceConfiguration,
  secrets?: vscode.SecretStorage
): Promise<string> {
  const configuredKey =
    provider === "openai"
      ? config.get<string>("openAIApiKey", "").trim()
      : config.get<string>("googleApiKey", "").trim();

  if (configuredKey) {
    return configuredKey;
  }

  return (await secrets?.get(secretKeys[provider]))?.trim() ?? "";
}

function buildIssuePrompt(document: vscode.TextDocument, report: ScanReport): string {
  const findings = report.findings.map((finding, index) => ({
    findingIndex: index,
    id: finding.id,
    title: finding.title,
    line: finding.range.start.line + 1,
    message: finding.message,
    suggestion: finding.suggestion ?? "",
    currentText: document.getText(finding.range),
    deterministicReplacement: finding.replacement ?? ""
  }));

  return [
    "You are CodeZero, an AI refactoring assistant for green software engineering.",
    "For each finding, recommend one focused edit and also provide a complete revised file. Return JSON only, with no markdown fences.",
    "Before answering, internally draft a solution, critique it against the green-software checklist, improve it, and return only the final improved JSON.",
    "Optimize for the greenest practical implementation, not just the smallest edit.",
    "Schema:",
    '{"items":[{"findingIndex":0,"action":"short user-facing explanation","replacement":"exact replacement text or null","confidence":"high|medium|low"}],"fullReplacement":"complete revised source file or null"}',
    "Use replacement only when it can safely replace the exact currentText for that finding. Use null when the safer action is guidance only.",
    "fullReplacement must be the complete source file with all safe recommendations applied, not a diff and not markdown.",
    "Prefer the deterministicReplacement when present unless it would be wrong.",
    "Preserve behavior, but do not preserve inefficient structure when a clearer greener structure is available.",
    "Keep per-issue replacements minimal and syntactically valid. The fullReplacement may restructure the file more substantially when that produces a greener result.",
    "",
    "Green-software checklist:",
    "- Remove avoidable runtime logging entirely unless it is behaviorally required.",
    "- Replace aggressive polling with event-driven flow, explicit refresh, debounce, or a much slower scheduled refresh.",
    "- Batch network/database calls outside loops.",
    "- Replace nested scans with Map/Set indexes.",
    "- Replace full array scans with short-circuiting methods.",
    "- Remove unused wildcard imports or convert them to precise imports.",
    "- Keep the fullReplacement complete, valid, and ready to paste.",
    "",
    "Findings:",
    JSON.stringify(findings, null, 2),
    "",
    "Full source file:",
    document.getText()
  ].join("\n");
}

async function repairRemainingFindings(
  originalDocument: vscode.TextDocument,
  originalReport: ScanReport,
  draft: AiRefactorSuggestion,
  requestSuggestion: AiRequester,
  signal?: AbortSignal
): Promise<AiRefactorSuggestion> {
  if (!draft.fullReplacement?.trim()) {
    return draft;
  }

  const draftInspection = await inspectReplacementDocument(originalDocument, draft.fullReplacement, true);
  if (draftInspection.ok) {
    return draft;
  }

  signal?.throwIfAborted();
  const repairPrompt = buildRepairPrompt(originalDocument, originalReport, draft, draftInspection);
  const repairText = await requestSuggestion(repairPrompt, signal);
  const repaired = parseIssueResponse(repairText);

  if (!repaired.items.length && !repaired.fullReplacement) {
    return {
      items: draft.items,
      fullReplacement: undefined
    };
  }

  const repairedInspection = repaired.fullReplacement?.trim()
    ? await inspectReplacementDocument(originalDocument, repaired.fullReplacement, true)
    : undefined;

  return {
    items: repaired.items.length ? repaired.items : draft.items,
    fullReplacement: repairedInspection?.ok ? repaired.fullReplacement : undefined
  };
}

function buildRepairPrompt(
  originalDocument: vscode.TextDocument,
  originalReport: ScanReport,
  draft: AiRefactorSuggestion,
  inspection: ReplacementInspection
): string {
  const remainingFindings = inspection.report?.findings.map((finding) => ({
    id: finding.id,
    title: finding.title,
    line: finding.range.start.line + 1,
    message: finding.message,
    currentText: inspection.document?.getText(finding.range) ?? ""
  })) ?? [];

  return [
    "You are CodeZero fixing a refactor that failed CodeZero validation.",
    "Return JSON only, with no markdown fences.",
    "Use this exact schema:",
    '{"items":[{"findingIndex":0,"action":"short user-facing explanation","replacement":"exact replacement text or null","confidence":"high|medium|low"}],"fullReplacement":"complete revised source file or null"}',
    "",
    "The previous fullReplacement had these validation problems:",
    JSON.stringify(inspection.problems, null, 2),
    "",
    "The previous fullReplacement still produced these CodeZero findings:",
    JSON.stringify(remainingFindings, null, 2),
    "",
    "Fix every validation problem and every remaining finding in the fullReplacement. The revised fullReplacement must be the complete source file and should produce zero CodeZero findings.",
    "Do not leave setInterval polling, verbose runtime logs, nested loops, filter(...).length checks, wildcard imports, or remote calls inside loops.",
    "",
    "Original findings for index mapping:",
    JSON.stringify(
      originalReport.findings.map((finding, index) => ({
        findingIndex: index,
        id: finding.id,
        title: finding.title,
        originalLine: finding.range.start.line + 1
      })),
      null,
      2
    ),
    "",
    "Previous AI JSON:",
    JSON.stringify(draft, null, 2),
    "",
    "Original source file:",
    originalDocument.getText()
  ].join("\n");
}

function parseIssueResponse(responseText: string): AiRefactorSuggestion {
  const cleaned = responseText.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const candidates = [cleaned, ...extractJsonObjectCandidates(cleaned)];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        items?: Array<{
          findingIndex?: unknown;
          action?: unknown;
          replacement?: unknown;
          confidence?: unknown;
        }>;
        fullReplacement?: unknown;
      };

      return {
        items: (parsed.items ?? []).flatMap((item) => {
          if (typeof item.findingIndex !== "number" || typeof item.action !== "string") {
            return [];
          }

          return [
            {
              findingIndex: item.findingIndex,
              action: item.action,
              replacement: typeof item.replacement === "string" ? item.replacement : undefined,
              confidence: item.confidence === "high" || item.confidence === "medium" || item.confidence === "low" ? item.confidence : "medium"
            }
          ];
        }),
        fullReplacement: typeof parsed.fullReplacement === "string" ? parsed.fullReplacement : undefined
      };
    } catch {
      // Try the next candidate.
    }
  }

  return { items: [] };
}

function extractJsonObjectCandidates(value: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(value.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

function normalizeIssueSuggestions(suggestions: AiIssueSuggestion[], findings: RuleMatch[]): AiIssueSuggestion[] {
  return findings.map((finding, index) => {
    const suggestion = suggestions.find((item) => item.findingIndex === index);
    return {
      findingIndex: index,
      action: suggestion?.action || finding.suggestion || finding.message,
      replacement: suggestion?.replacement ?? finding.replacement,
      confidence: suggestion?.confidence ?? (finding.replacement ? "high" : "medium")
    };
  });
}

async function validateIssueSuggestions(
  document: vscode.TextDocument,
  report: ScanReport,
  suggestions: AiIssueSuggestion[]
): Promise<AiIssueSuggestion[]> {
  const validated: AiIssueSuggestion[] = [];

  for (const suggestion of suggestions) {
    const finding = report.findings[suggestion.findingIndex];
    if (!finding || !suggestion.replacement) {
      validated.push(suggestion);
      continue;
    }

    const validation = await validateAiReplacement(document, suggestion.replacement, finding.range);
    validated.push(
      validation.ok
        ? suggestion
        : {
            ...suggestion,
            replacement: undefined,
            confidence: "low",
            action: `${suggestion.action} CodeZero could not verify a safe one-click replacement, so this item is shown as guidance.`
          }
    );
  }

  return validated;
}

async function getSafeFullReplacement(
  document: vscode.TextDocument,
  replacement: string | undefined
): Promise<string | undefined> {
  if (!replacement?.trim()) {
    return undefined;
  }

  const validation = await validateAiFullReplacement(document, replacement);
  return validation.ok ? replacement : undefined;
}

async function inspectReplacementDocument(
  referenceDocument: vscode.TextDocument,
  fullText: string,
  requireCleanAnalysis: boolean
): Promise<ReplacementInspection> {
  const problems = await validateSyntaxForLanguage(referenceDocument.languageId, fullText);

  if (problems.length > 0) {
    return {
      ok: false,
      problems
    };
  }

  if (!requireCleanAnalysis) {
    return {
      ok: true,
      problems: []
    };
  }

  const document = await vscode.workspace.openTextDocument({
    content: fullText,
    language: referenceDocument.languageId
  });
  const report = await analyzeDocument(document);
  const remainingProblems = report.findings.map(
    (finding) => `${finding.title} on line ${finding.range.start.line + 1}: ${finding.message}`
  );

  return {
    ok: remainingProblems.length === 0,
    problems: remainingProblems,
    document,
    report
  };
}

async function validateSyntaxForLanguage(languageId: string, text: string): Promise<string[]> {
  try {
    if (isAstLanguage(languageId)) {
      parse(text, {
        sourceType: "unambiguous",
        errorRecovery: false,
        plugins: parserPluginsFor(languageId)
      });
      return [];
    }

    if (languageId === "python") {
      const tree = pythonParser.parse(text);
      return lezerTreeHasErrors(tree) ? ["Python parser reported syntax errors in the AI replacement."] : [];
    }

    if (languageId === "java") {
      const { parse: parseJava } = await getJavaParser();
      parseJava(text);
      return [];
    }

    return text.trim() ? [] : ["AI replacement was empty."];
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown syntax error.";
    return [`AI replacement did not parse for ${languageId}: ${message}`];
  }
}

function lezerTreeHasErrors(tree: ReturnType<typeof pythonParser.parse>): boolean {
  const cursor = tree.cursor();

  do {
    if (cursor.type.isError) {
      return true;
    }

    if (cursor.firstChild()) {
      continue;
    }

    while (!cursor.nextSibling()) {
      if (!cursor.parent()) {
        return false;
      }
    }
  } while (true);
}

function replaceRange(document: vscode.TextDocument, range: vscode.Range, replacement: string): string {
  const text = document.getText();
  return `${text.slice(0, document.offsetAt(range.start))}${replacement}${text.slice(document.offsetAt(range.end))}`;
}

function parserPluginsFor(languageId: string): Array<"jsx" | "typescript"> {
  if (languageId === "typescript") {
    return ["typescript"];
  }
  if (languageId === "typescriptreact") {
    return ["typescript", "jsx"];
  }
  if (languageId === "javascriptreact") {
    return ["jsx"];
  }
  return [];
}

function isAstLanguage(languageId: string): boolean {
  return ["javascript", "javascriptreact", "typescript", "typescriptreact"].includes(languageId);
}

async function requestHostedSuggestion(endpoint: string, model: string, prompt: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(endpoint, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      schemaVersion: 1,
      model,
      prompt
    })
  });

  if (!response.ok) {
    throw new Error(`CodeZero hosted AI request failed with ${response.status}. ${await responseErrorDetails(response)}`);
  }

  const data = (await response.json()) as {
    content?: unknown;
    text?: unknown;
    items?: unknown;
    fullReplacement?: unknown;
  };

  if (typeof data.content === "string") {
    return data.content.trim();
  }
  if (typeof data.text === "string") {
    return data.text.trim();
  }
  if (data.items || data.fullReplacement) {
    return JSON.stringify(data);
  }

  return "No suggestion returned.";
}

async function requestOpenAiSuggestion(apiKey: string, model: string, prompt: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: "You generate concise sustainable-code refactors with short explanations. Return JSON only."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.2
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed with ${response.status}. ${await responseErrorDetails(response)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  return data.choices?.[0]?.message?.content?.trim() || "No suggestion returned.";
}

async function requestGeminiSuggestion(apiKey: string, model: string, prompt: string, signal?: AbortSignal): Promise<string> {
  const models = geminiModelFallbacks(model);
  const errors: string[] = [];

  for (const candidateModel of models) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      signal?.throwIfAborted();

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(candidateModel)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          signal,
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: prompt
                  }
                ]
              }
            ],
            generationConfig: {
              responseMimeType: "application/json",
              temperature: 0.2
            }
          })
        }
      );

      if (response.ok) {
        const data = (await response.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };

        return data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n").trim() || "No suggestion returned.";
      }

      const details = await responseErrorDetails(response);
      errors.push(`Model ${candidateModel} failed with ${response.status}. ${details}`);

      if (!isRetryableAiStatus(response.status)) {
        break;
      }

      await delay(600 * (attempt + 1), signal);
    }
  }

  throw new Error(`Gemini request failed after retries. ${errors.join(" ")}`);
}

function geminiModelFallbacks(model: string): string[] {
  return uniqueStrings([model, "gemini-2.5-flash-lite", "gemini-2.0-flash"]);
}

function isRetryableAiStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }

    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

async function responseErrorDetails(response: Response): Promise<string> {
  try {
    const details = await response.text();
    return details ? `Details: ${details}` : "";
  } catch {
    return "";
  }
}

async function getJavaParser(): Promise<{ parse: (input: string) => JavaCstNode }> {
  javaParserModulePromise ??= import("java-parser") as Promise<{ parse: (input: string) => JavaCstNode }>;
  return javaParserModulePromise;
}
