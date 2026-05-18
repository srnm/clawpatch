import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { ClawpatchError } from "./errors.js";
import { ClawpatchConfig, FeatureRecord, ReviewOutput } from "./types.js";

export async function validateReviewOutput(
  root: string,
  feature: FeatureRecord,
  config: ClawpatchConfig,
  output: ReviewOutput,
): Promise<ReviewOutput> {
  const included = includedReviewPaths(feature, config);
  const cache = new Map<string, Promise<string>>();
  for (const file of output.inspected.files) {
    assertSafePath(file, "inspected file");
  }
  const findings = output.findings.slice(0, config.review.maxFindingsPerFeature);
  for (const finding of findings) {
    if (finding.evidence.length === 0) {
      throwMalformed(`finding "${finding.title}" has no evidence`);
    }
    for (const evidence of finding.evidence) {
      assertIncludedPath(evidence.path, included, "evidence file");
      const contents = await fileContents(root, evidence.path, cache);
      assertLineRange(contents, evidence);
      assertQuote(contents, evidence);
    }
  }
  return { ...output, findings };
}

function includedReviewPaths(feature: FeatureRecord, config: ClawpatchConfig): Set<string> {
  return new Set(
    [
      ...feature.ownedFiles.slice(0, config.review.maxOwnedFiles).map((ref) => ref.path),
      ...feature.contextFiles.slice(0, config.review.maxContextFiles).map((ref) => ref.path),
    ].map(normalizePath),
  );
}

function assertIncludedPath(path: string, included: ReadonlySet<string>, label: string): void {
  const normalized = normalizePath(path);
  assertSafePath(path, label);
  if (!included.has(normalized)) {
    throwMalformed(`${label} was not included in review context: ${path}`);
  }
}

function assertSafePath(path: string, label: string): void {
  const normalized = normalizePath(path);
  if (normalized.startsWith("../") || isAbsolute(normalized)) {
    throwMalformed(`${label} escapes repository root: ${path}`);
  }
}

async function fileContents(
  root: string,
  path: string,
  cache: Map<string, Promise<string>>,
): Promise<string> {
  const normalized = normalizePath(path);
  const existing = cache.get(normalized);
  if (existing !== undefined) {
    return existing;
  }
  const loaded = readIncludedFile(root, normalized);
  cache.set(normalized, loaded);
  return loaded;
}

async function readIncludedFile(root: string, path: string): Promise<string> {
  const full = resolve(root, path);
  const realRoot = await realpath(root).catch(() => root);
  const realFull = await realpath(full).catch(() => null);
  if (realFull === null || !isInside(realRoot, realFull)) {
    throwMalformed(`evidence file is not readable inside repository: ${path}`);
  }
  return readFile(full, "utf8").catch(() => {
    throwMalformed(`evidence file is not readable inside repository: ${path}`);
  });
}

function assertLineRange(
  contents: string,
  evidence: ReviewOutput["findings"][number]["evidence"][number],
): void {
  const { startLine, endLine } = evidence;
  if (startLine === null && endLine === null) {
    return;
  }
  if (startLine === null || endLine === null) {
    throwMalformed(`evidence line range must include both startLine and endLine: ${evidence.path}`);
  }
  if (startLine > endLine) {
    throwMalformed(`evidence line range is inverted: ${evidence.path}:${startLine}-${endLine}`);
  }
  const lineCount = contents.length === 0 ? 1 : contents.split("\n").length;
  if (endLine > lineCount) {
    throwMalformed(
      `evidence line range exceeds file length: ${evidence.path}:${startLine}-${endLine}`,
    );
  }
}

function assertQuote(
  contents: string,
  evidence: ReviewOutput["findings"][number]["evidence"][number],
): void {
  const quote = evidence.quote;
  if (quote === null || quote.trim().length === 0) {
    return;
  }
  const target =
    evidence.startLine !== null && evidence.endLine !== null
      ? contents
          .split("\n")
          .slice(evidence.startLine - 1, evidence.endLine)
          .join("\n")
      : contents;
  if (
    !target.includes(quote) &&
    !compactWhitespace(target).includes(compactWhitespace(quote))
  ) {
    throwMalformed(`evidence quote does not match file contents: ${evidence.path}`);
  }
}

function isInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function normalizePath(path: string): string {
  return path.replace(/\\/gu, "/").replace(/^\.\/+/u, "");
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function throwMalformed(message: string): never {
  throw new ClawpatchError(`malformed provider review output: ${message}`, 8, "malformed-output");
}
