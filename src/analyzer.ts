import { parse } from "@babel/parser";
import traverse, { NodePath } from "@babel/traverse";
import { parser as pythonParser } from "@lezer/python";
import type * as t from "@babel/types";
import { co2 as CO2 } from "@tgwf/co2";
import * as vscode from "vscode";

export type RuleSeverity = "info" | "warning";

export interface RuleMatch {
  id: string;
  title: string;
  message: string;
  severity: RuleSeverity;
  range: vscode.Range;
  suggestion?: string;
  replacement?: string;
  estimatedBytes: number;
  estimatedSavingsGrams: number;
  category: "compute" | "network" | "bundle" | "io";
}

export interface ScanReport {
  fileName: string;
  languageId: string;
  sourceBytes: number;
  estimatedTransferredBytes: number;
  estimatedCarbonGrams: number;
  potentialSavingsGrams: number;
  ecoScore: number;
  findings: RuleMatch[];
  engine: "ast" | "parser" | "heuristic";
}

const carbonModel = new CO2({ model: "swd", version: 4 });
let javaParserModulePromise: Promise<{ parse: (input: string) => JavaCstNode }> | undefined;

export async function analyzeDocument(document: vscode.TextDocument): Promise<ScanReport> {
  const text = document.getText();
  const engine = getAnalysisEngine(document.languageId);
  const findings =
    engine === "ast"
      ? analyzeWithAst(document, text)
      : engine === "parser"
        ? await analyzeWithLanguageParser(document, text)
        : analyzeWithHeuristics(document, text);
  const sourceBytes = Buffer.byteLength(text, "utf8");
  const estimatedTransferredBytes = sourceBytes + findings.reduce((total, finding) => total + finding.estimatedBytes, 0);
  const estimatedCarbonGrams = toNumber(carbonModel.perByte(estimatedTransferredBytes, false));
  const potentialSavingsGrams = findings.reduce((total, finding) => total + finding.estimatedSavingsGrams, 0);

  return {
    fileName: document.fileName,
    languageId: document.languageId,
    sourceBytes,
    estimatedTransferredBytes,
    estimatedCarbonGrams,
    potentialSavingsGrams,
    ecoScore: calculateEcoScore(findings, estimatedCarbonGrams),
    findings,
    engine
  };
}

interface JavaCstNode {
  name?: string;
  location?: {
    startOffset: number;
    endOffset: number;
  };
  children?: Record<string, JavaCstNode[]>;
}

function analyzeWithAst(document: vscode.TextDocument, text: string): RuleMatch[] {
  try {
    const ast = parse(text, {
      sourceType: "unambiguous",
      errorRecovery: true,
      plugins: parserPluginsFor(document.languageId)
    });

    const findings: RuleMatch[] = [];
    let loopDepth = 0;

    traverse(ast, {
      enter(path: NodePath) {
        if (isLoopPath(path)) {
          if (loopDepth >= 1) {
            findings.push(createFinding(document, path.node.start, path.node.end, {
              id: "nested-loop",
              title: "Nested loop hotspot",
              message:
                "Nested loops usually scale poorly and increase compute cost as datasets grow. Replace inner scans with indexed lookups where possible.",
              severity: "warning",
              suggestion: "Build a map or set outside the loop and reuse it inside.",
              estimatedBytes: 9500,
              category: "compute"
            }));
          }
          loopDepth += 1;
        }
      },
      exit(path: NodePath) {
        if (isLoopPath(path)) {
          loopDepth = Math.max(0, loopDepth - 1);
        }
      },
      ImportDeclaration(path: NodePath<t.ImportDeclaration>) {
        for (const specifier of path.node.specifiers) {
          if (specifier.type === "ImportNamespaceSpecifier") {
            findings.push(createFinding(document, specifier.start, specifier.end, {
              id: "wildcard-import",
              title: "Wildcard import",
              message: "Namespace imports can inflate bundle and parse cost. Prefer importing only the symbols you need.",
              severity: "info",
              suggestion: "Replace the namespace import with explicit named imports.",
              replacement: `import { /* choose symbols */ } from ${JSON.stringify(path.node.source.value)};`,
              estimatedBytes: 2200,
              category: "bundle"
            }));
          }
        }
      },
      BinaryExpression(path: NodePath<t.BinaryExpression>) {
        if (isFilterLengthCheck(path.node)) {
          const target = renderMemberBase(path.node.left.object.callee.object);
          findings.push(createFinding(document, path.node.start, path.node.end, {
            id: "repeated-array-scan",
            title: "Repeated array scan",
            message: `'.filter(...).length > 0' scans all of '${target}'. '.some(...)' short-circuits after the first match.`,
            severity: "warning",
            suggestion: "Replace the full scan with '.some(...)' when you only need a boolean result.",
            replacement: buildSomeReplacement(path.node),
            estimatedBytes: 5000,
            category: "compute"
          }));
        }
      },
      CallExpression(path: NodePath<t.CallExpression>) {
        if (isConsoleLog(path.node)) {
          findings.push(createFinding(document, path.node.start, path.node.end, {
            id: "verbose-logging",
            title: "Verbose runtime logging",
            message: "Frequent logging in active code paths adds I/O overhead and noise. Gate logs behind a debug flag or remove them from hot paths.",
            severity: "info",
            suggestion: "Keep logs behind a logger level check or development flag.",
            estimatedBytes: 600,
            category: "io"
          }));
        }

        if (isAggressiveSetInterval(path.node)) {
          const interval = getNumericLiteralValue(path.node.arguments[1]);
          findings.push(createFinding(document, path.node.start, path.node.end, {
            id: "polling-timer",
            title: "Aggressive polling timer",
            message: `Polling every ${interval}ms keeps waking the runtime and wastes CPU. Event-driven updates or slower intervals are greener.`,
            severity: "warning",
            suggestion: "Prefer subscriptions, debouncing, or a slower refresh cadence.",
            replacement: buildSetTimeoutReplacement(path.node),
            estimatedBytes: 12000,
            category: "network"
          }));
        }

        if (loopDepth > 0 && isLikelyRemoteCall(path.node)) {
          findings.push(createFinding(document, path.node.start, path.node.end, {
            id: "network-call-in-loop",
            title: "Network or database call inside loop",
            message: "Repeated remote calls inside loops multiply latency, energy use, and backend load. Batch or prefetch instead.",
            severity: "warning",
            suggestion: "Move the call outside the loop, batch requests, or cache prior results.",
            estimatedBytes: 15000,
            category: "network"
          }));
        }
      }
    });

    return dedupeMatches(findings);
  } catch {
    return analyzeWithHeuristics(document, text);
  }
}

async function analyzeWithLanguageParser(document: vscode.TextDocument, text: string): Promise<RuleMatch[]> {
  if (document.languageId === "python") {
    return analyzePythonWithParser(document, text);
  }
  if (document.languageId === "java") {
    return analyzeJavaWithParser(document, text);
  }
  return analyzeWithHeuristics(document, text);
}

function analyzePythonWithParser(document: vscode.TextDocument, text: string): RuleMatch[] {
  const tree = pythonParser.parse(text);
  const cursor = tree.cursor();
  const findings: RuleMatch[] = [];

  walkPython(cursor, 0);
  return dedupeMatches(findings);

  function walkPython(current: typeof cursor, loopDepth: number): void {
    const nodeName = current.name;
    const snippet = text.slice(current.from, current.to);
    let nextLoopDepth = loopDepth;

    if (nodeName === "ImportStatement" && /\bimport\s+\*/.test(snippet)) {
      findings.push(createFinding(document, current.from, current.to, {
        id: "wildcard-import",
        title: "Wildcard import",
        message: "Wildcard imports increase load and namespace noise. Import only the symbols you need.",
        severity: "info",
        suggestion: "Replace the wildcard import with explicit names.",
        estimatedBytes: 2200,
        category: "bundle"
      }));
    }

    if (nodeName === "ForStatement" || nodeName === "WhileStatement") {
      if (loopDepth >= 1) {
        findings.push(createFinding(document, current.from, current.to, {
          id: "nested-loop",
          title: "Nested loop hotspot",
          message: "Nested loops usually scale poorly and increase compute cost as datasets grow.",
          severity: "warning",
          suggestion: "Pre-index data with a dict or set before the inner loop.",
          estimatedBytes: 9500,
          category: "compute"
        }));
      }
      nextLoopDepth += 1;
    }

    if (nodeName === "CallExpression") {
      if (/^\s*print\s*\(/.test(snippet)) {
        findings.push(createFinding(document, current.from, current.to, {
          id: "verbose-logging",
          title: "Verbose runtime logging",
          message: "Frequent logging in active code paths adds I/O overhead and noise.",
          severity: "info",
          suggestion: "Keep logging behind a debug flag or structured logger levels.",
          estimatedBytes: 600,
          category: "io"
        }));
      }

      if (nextLoopDepth > 0 && isLikelyRemoteSnippet(snippet, "python")) {
        findings.push(createFinding(document, current.from, current.to, {
          id: "network-call-in-loop",
          title: "Network or database call inside loop",
          message: "Repeated remote calls inside loops multiply latency, energy use, and backend load.",
          severity: "warning",
          suggestion: "Batch requests or move I/O outside the loop.",
          estimatedBytes: 15000,
          category: "network"
        }));
      }
    }

    if (current.firstChild()) {
      do {
        walkPython(current, nextLoopDepth);
      } while (current.nextSibling());
      current.parent();
    }
  }
}

async function analyzeJavaWithParser(document: vscode.TextDocument, text: string): Promise<RuleMatch[]> {
  const { parse: parseJava } = await getJavaParser();
  const cst = parseJava(text);
  const findings: RuleMatch[] = [];

  walkJava(cst, 0);
  return dedupeMatches(findings);

  function walkJava(node: JavaCstNode | undefined, loopDepth: number): void {
    if (!node || typeof node !== "object") {
      return;
    }

    const nodeName = node.name;
    const snippet = getNodeSnippet(text, node);
    let nextLoopDepth = loopDepth;

    if (nodeName === "importDeclaration" && /\.\*\s*;/.test(snippet)) {
      findings.push(createFinding(document, getNodeStart(node), getNodeEnd(node), {
        id: "wildcard-import",
        title: "Wildcard import",
        message: "Wildcard imports increase dependency surface and parse cost. Prefer explicit imports.",
        severity: "info",
        suggestion: "Replace the star import with explicit classes.",
        estimatedBytes: 2200,
        category: "bundle"
      }));
    }

    if (nodeName === "forStatement" || nodeName === "whileStatement" || nodeName === "doStatement") {
      if (loopDepth >= 1) {
        findings.push(createFinding(document, getNodeStart(node), getNodeEnd(node), {
          id: "nested-loop",
          title: "Nested loop hotspot",
          message: "Nested loops usually scale poorly and increase compute cost as datasets grow.",
          severity: "warning",
          suggestion: "Use indexed structures such as HashMap or HashSet for inner lookups.",
          estimatedBytes: 9500,
          category: "compute"
        }));
      }
      nextLoopDepth += 1;
    }

    if (nodeName === "expressionStatement") {
      if (/\b(?:log|logger\.(?:info|debug|warn|error)|System\.out\.print(?:ln)?)\s*\(/.test(snippet)) {
        findings.push(createFinding(document, getNodeStart(node), getNodeEnd(node), {
          id: "verbose-logging",
          title: "Verbose runtime logging",
          message: "Frequent logging in active code paths adds I/O overhead and noise.",
          severity: "info",
          suggestion: "Use lower-volume logging or guard logs by level.",
          estimatedBytes: 600,
          category: "io"
        }));
      }

      if (nextLoopDepth > 0 && isLikelyRemoteSnippet(snippet, "java")) {
        findings.push(createFinding(document, getNodeStart(node), getNodeEnd(node), {
          id: "network-call-in-loop",
          title: "Network or database call inside loop",
          message: "Repeated remote calls inside loops multiply latency, energy use, and backend load.",
          severity: "warning",
          suggestion: "Batch calls, prefetch results, or move I/O outside the loop.",
          estimatedBytes: 15000,
          category: "network"
        }));
      }
    }

    if (node.children) {
      for (const value of Object.values(node.children)) {
        for (const child of value) {
          walkJava(child, nextLoopDepth);
        }
      }
    }
  }
}

function analyzeWithHeuristics(document: vscode.TextDocument, text: string): RuleMatch[] {
  const findings: RuleMatch[] = [];
  const sanitizedText = stripCommentsForHeuristics(text, document.languageId);
  const rules: Array<{
    id: string;
    title: string;
    severity: RuleSeverity;
    regex: RegExp;
    message: (match: RegExpMatchArray) => string;
    suggestion?: string;
    estimatedBytes: number;
    category: RuleMatch["category"];
  }> = [
    {
      id: "polling-timer",
      title: "Aggressive polling timer",
      severity: "warning",
      regex: /setInterval\s*\([\s\S]*?,\s*(\d{1,4})\s*\)/g,
      message: (match) => `Polling every ${match[1]}ms is expensive. Prefer event-driven updates or a slower cadence.`,
      suggestion: "Use events, subscriptions, or a larger timer interval.",
      estimatedBytes: 12000,
      category: "network"
    },
    {
      id: "nested-loop",
      title: "Nested loop hotspot",
      severity: "warning",
      regex: /\b(for|while)\b[\s\S]{0,220}\b(for|while)\b/g,
      message: () => "Nested loops can grow into quadratic work and increase CPU cost.",
      suggestion: "Pre-index inner collections with a map or set.",
      estimatedBytes: 9500,
      category: "compute"
    },
    {
      id: "verbose-logging",
      title: "Verbose runtime logging",
      severity: "info",
      regex: /console\.log\s*\(|print\s*\(/g,
      message: () => "Frequent runtime logging adds I/O overhead in hot paths.",
      suggestion: "Use debug-only logging or structured log levels.",
      estimatedBytes: 600,
      category: "io"
    }
  ];

  for (const rule of rules) {
    for (const match of sanitizedText.matchAll(rule.regex)) {
      if (match.index === undefined) {
        continue;
      }

      findings.push({
        id: rule.id,
        title: rule.title,
        message: rule.message(match),
        severity: rule.severity,
        range: new vscode.Range(document.positionAt(match.index), document.positionAt(match.index + match[0].length)),
        suggestion: rule.suggestion,
        estimatedBytes: rule.estimatedBytes,
        estimatedSavingsGrams: estimateSavings(rule.estimatedBytes),
        category: rule.category
      });
    }
  }

  return dedupeMatches(findings);
}

function createFinding(
  document: vscode.TextDocument,
  start: number | null | undefined,
  end: number | null | undefined,
  finding: Omit<RuleMatch, "range" | "estimatedSavingsGrams">
): RuleMatch {
  const safeStart = typeof start === "number" ? start : 0;
  const safeEnd = typeof end === "number" ? end : safeStart;

  return {
    ...finding,
    estimatedSavingsGrams: estimateSavings(finding.estimatedBytes),
    range: new vscode.Range(document.positionAt(safeStart), document.positionAt(Math.max(safeStart, safeEnd)))
  };
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

function getAnalysisEngine(languageId: string): ScanReport["engine"] {
  if (isAstLanguage(languageId)) {
    return "ast";
  }
  if (languageId === "python" || languageId === "java") {
    return "parser";
  }
  return "heuristic";
}

function isLoopPath(path: { isForStatement(): boolean; isWhileStatement(): boolean; isDoWhileStatement(): boolean; isForInStatement(): boolean; isForOfStatement(): boolean }): boolean {
  return path.isForStatement() || path.isWhileStatement() || path.isDoWhileStatement() || path.isForInStatement() || path.isForOfStatement();
}

function isConsoleLog(node: t.CallExpression): boolean {
  return (
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "console" &&
    node.callee.property.type === "Identifier" &&
    node.callee.property.name === "log"
  );
}

function isAggressiveSetInterval(node: t.CallExpression): boolean {
  const interval = getNumericLiteralValue(node.arguments[1]);
  return node.callee.type === "Identifier" && node.callee.name === "setInterval" && typeof interval === "number" && interval <= 1000;
}

function getNumericLiteralValue(argument: t.CallExpression["arguments"][number] | undefined): number | undefined {
  return argument?.type === "NumericLiteral" ? argument.value : undefined;
}

function isFilterLengthCheck(node: t.BinaryExpression): node is t.BinaryExpression & { left: t.MemberExpression & { object: t.CallExpression & { callee: t.MemberExpression & { object: t.Expression } } } } {
  if (node.operator !== ">" || node.right.type !== "NumericLiteral" || node.right.value !== 0) {
    return false;
  }
  if (node.left.type !== "MemberExpression" || node.left.computed) {
    return false;
  }
  if (node.left.property.type !== "Identifier" || node.left.property.name !== "length") {
    return false;
  }
  const object = node.left.object;
  return (
    object.type === "CallExpression" &&
    object.callee.type === "MemberExpression" &&
    !object.callee.computed &&
    object.callee.property.type === "Identifier" &&
    object.callee.property.name === "filter"
  );
}

function isLikelyRemoteCall(node: t.CallExpression): boolean {
  const name = getCalleeName(node.callee);
  return !!name && ["fetch", "axios.get", "axios.post", "query", "findMany", "findAll", "select", "request"].includes(name);
}

function getCalleeName(callee: t.CallExpression["callee"]): string | undefined {
  if (callee.type === "Identifier") {
    return callee.name;
  }
  if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") {
    const object = renderMemberBase(callee.object);
    return object ? `${object}.${callee.property.name}` : callee.property.name;
  }
  return undefined;
}

function renderMemberBase(node: t.Expression | t.Super): string {
  if (node.type === "Identifier") {
    return node.name;
  }
  if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
    return `${renderMemberBase(node.object)}.${node.property.name}`;
  }
  return "collection";
}

function buildSomeReplacement(node: t.BinaryExpression & { left: t.MemberExpression & { object: t.CallExpression & { callee: t.MemberExpression & { object: t.Expression } } } }): string {
  const filterCall = node.left.object;
  const target = renderMemberBase(filterCall.callee.object);
  const predicate = filterCall.arguments[0];
  return `${target}.some(${renderArgument(predicate)})`;
}

function buildSetTimeoutReplacement(node: t.CallExpression): string {
  return `setTimeout(${renderArgument(node.arguments[0])}, 5000)`;
}

function renderArgument(argument: t.CallExpression["arguments"][number] | undefined): string {
  if (!argument) {
    return "/* update callback */";
  }
  if (argument.type === "Identifier") {
    return argument.name;
  }
  if (argument.type === "ArrowFunctionExpression" || argument.type === "FunctionExpression") {
    return "() => { /* move existing callback here */ }";
  }
  return "/* update callback */";
}

function calculateEcoScore(findings: RuleMatch[], grams: number): number {
  const severityPenalty = findings.reduce((score, finding) => score + (finding.severity === "warning" ? 15 : 6), 0);
  const carbonPenalty = Math.min(20, Math.round(grams * 10000));
  return Math.max(0, 100 - severityPenalty - carbonPenalty);
}

function dedupeMatches(matches: RuleMatch[]): RuleMatch[] {
  const seen = new Set<string>();
  return matches.filter((match) => {
    const key = `${match.id}:${match.range.start.line}:${match.range.start.character}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function toNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function estimateSavings(bytes: number): number {
  return toNumber(carbonModel.perByte(bytes, false));
}

function stripCommentsForHeuristics(text: string, languageId: string): string {
  let sanitized = text;

  if (languageId === "python") {
    return sanitized.replace(/#[^\r\n]*/g, replaceWithSpaces);
  }

  if (languageId === "java" || languageId === "javascript" || languageId === "javascriptreact" || languageId === "typescript" || languageId === "typescriptreact") {
    sanitized = sanitized.replace(/\/\*[\s\S]*?\*\//g, replaceWithSpaces);
    sanitized = sanitized.replace(/\/\/[^\r\n]*/g, replaceWithSpaces);
  }

  return sanitized;
}

function replaceWithSpaces(match: string): string {
  return match.replace(/[^\r\n]/g, " ");
}

function isLikelyRemoteSnippet(snippet: string, languageId: "python" | "java"): boolean {
  if (languageId === "python") {
    return /\b(?:requests\.(?:get|post|put|delete)|session\.(?:get|post|put|delete)|cursor\.execute|execute_query|fetch|query|select|request)\s*\(/.test(snippet);
  }
  return /\b(?:fetch|query|select|request|executeQuery|executeUpdate|findAll|findMany|getForObject|postForObject|api\.)[A-Za-z0-9_.]*\s*\(/.test(snippet);
}

function getNodeStart(node: JavaCstNode): number | undefined {
  return node.location?.startOffset;
}

function getNodeEnd(node: JavaCstNode): number | undefined {
  const endOffset = node.location?.endOffset;
  return typeof endOffset === "number" ? endOffset + 1 : undefined;
}

function getNodeSnippet(text: string, node: JavaCstNode): string {
  const start = node.location?.startOffset;
  const end = node.location?.endOffset;
  if (typeof start !== "number" || typeof end !== "number") {
    return "";
  }
  return text.slice(start, end + 1);
}

async function getJavaParser(): Promise<{ parse: (input: string) => JavaCstNode }> {
  javaParserModulePromise ??= import("java-parser") as Promise<{ parse: (input: string) => JavaCstNode }>;
  return javaParserModulePromise;
}
