import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommandArgs } from "../exec.js";
import { ClawpatchError } from "../errors.js";
import { providerExitCode } from "../provider-errors.js";
import { extractJson, safeProviderPreview } from "../provider-json.js";
import { parseOrThrow, parseReviewOutput } from "../provider-output.js";
import { providerTimeoutMs } from "../provider-runtime.js";
import {
  agentMapJsonSchema,
  fixPlanJsonSchema,
  reviewJsonSchema,
  revalidateJsonSchema,
} from "../provider-schema.js";
import type { PartitionedReviewOutput, Provider, ProviderOptions } from "../provider-types.js";
import { compareSemanticVersions } from "../provider-version.js";
import {
  AgentMapOutput,
  CommandResult,
  FixPlanOutput,
  RevalidateOutput,
  agentMapOutputSchema,
  fixPlanOutputSchema,
  revalidateOutputSchema,
} from "../types.js";

const CURSOR_DEFAULT_TIMEOUT_MS = 300_000;
const CURSOR_MIN_SAFE_APP_VERSION = "2.5.0";
const CURSOR_DARWIN_INFO_PLIST = "/Applications/Cursor.app/Contents/Info.plist";
const CURSOR_EXPERIMENTAL_ENV = "CLAWPATCH_CURSOR_EXPERIMENTAL";
const CURSOR_WRITE_ENV = "CLAWPATCH_CURSOR_ALLOW_WRITE";
export const cursorProvider: Provider = {
  name: "cursor",
  async check(root: string): Promise<string> {
    return await checkedCursorRuntimeVersion(root);
  },
  async map(root: string, prompt: string, options: ProviderOptions): Promise<AgentMapOutput> {
    assertCursorProviderEnabled("map");
    const output = await runCursorJson(root, prompt, options, agentMapJsonSchema, true);
    return parseOrThrow(agentMapOutputSchema, output, "cursor agent-map");
  },
  async review(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<PartitionedReviewOutput> {
    assertCursorProviderEnabled("review");
    const output = await runCursorJson(root, prompt, options, reviewJsonSchema, true);
    return parseReviewOutput(output);
  },
  async fix(root: string, prompt: string, options: ProviderOptions): Promise<FixPlanOutput> {
    assertCursorProviderEnabled("fix");
    assertCursorWriteEnabled();
    const output = await runCursorJson(root, prompt, options, fixPlanJsonSchema, false);
    return parseOrThrow(fixPlanOutputSchema, output, "cursor fix-plan");
  },
  async revalidate(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<RevalidateOutput> {
    assertCursorProviderEnabled("revalidate");
    const output = await runCursorJson(root, prompt, options, revalidateJsonSchema, true);
    return parseOrThrow(revalidateOutputSchema, output, "cursor revalidate");
  },
};

async function runCursorJson(
  root: string,
  prompt: string,
  options: ProviderOptions,
  schema: object,
  readOnly: boolean,
): Promise<unknown> {
  await checkedCursorRuntimeVersion(root);
  const dir = await mkdtemp(join(tmpdir(), "clawpatch-cursor-"));
  const promptPath = join(dir, "prompt.txt");
  await writeFile(promptPath, cursorPrompt(prompt, schema, readOnly), "utf8");

  try {
    const args = cursorAgentArgs(root, options, readOnly, promptPath);
    const result = await runCursorAgent(root, args);
    if (result.exitCode !== 0) {
      throw new ClawpatchError(
        cursorFailureMessage(result.stdout, result.stderr, result.exitCode),
        providerExitCode(`${result.stderr}\n${result.stdout}`),
        "provider-failure",
      );
    }
    return extractCursorJson(result.stdout);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function checkedCursorRuntimeVersion(root: string): Promise<string> {
  const result = await runCursorAgent(root, ["--version"]);
  if (result.exitCode !== 0) {
    throw new ClawpatchError(
      "cursor-agent CLI not available or not authenticated",
      4,
      "provider-auth",
    );
  }
  const version = result.stdout.trim();
  const appVersion = await cursorAppVersion();
  assertCursorRuntimeVersionAllowed(version, appVersion);
  return appVersion === null ? version : `${version} (Cursor app ${appVersion})`;
}

function cursorAgentArgs(
  root: string,
  options: ProviderOptions,
  readOnly: boolean,
  promptPath: string,
): string[] {
  const args = ["--trust", "-p", "--output-format", "json", "--workspace", root];
  if (readOnly) {
    args.push("--mode", "ask");
  }
  if (options.model !== null) {
    args.push("--model", options.model);
  }
  args.push(cursorPromptArgument(promptPath));
  return args;
}

function cursorPromptArgument(promptPath: string): string {
  return `Read the complete Clawpatch prompt from ${promptPath}. Follow it exactly. Return only the requested JSON object.`;
}

async function runCursorAgent(
  root: string,
  args: string[],
  input?: string,
): Promise<CommandResult> {
  return await runCommandArgs("cursor-agent", args, root, input, {
    trimOutput: false,
    timeoutMs: cursorTimeoutMs(),
    env: cursorEnv(),
  });
}

function cursorPrompt(prompt: string, schema: object, readOnly: boolean): string {
  const promptBody = readOnly
    ? "READ-ONLY REVIEW MODE.\n" +
      "Do not modify, create, or delete any files.\n" +
      "Do not run shell commands.\n" +
      "The Cursor CLI also receives --mode ask for this read-only request.\n\n" +
      prompt
    : prompt;
  const evidenceRules =
    schema === reviewJsonSchema
      ? `

Cursor evidence rules:
- Cite only files that are explicitly included in the prompt's file blocks.
- evidence.path must exactly match an included file path.
- If you provide startLine and endLine, copy them from the included file block and keep them inside that file's shown line range.
- Do not use files outside the prompt excerpts as evidence.
- Always set evidence.quote to null.
- Every evidence item must include startLine and endLine from the shown file block.`
      : "";
  return `${promptBody}${evidenceRules}

Provider output schema:
${JSON.stringify(schema, null, 2)}

Return only one JSON object matching the schema.`;
}

function extractCursorJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new ClawpatchError("cursor provider produced no JSON envelope", 8, "malformed-output");
  }
  const envelope = parseSingleCursorEnvelope(trimmed);
  if (typeof envelope !== "object" || envelope === null) {
    throw new ClawpatchError(
      "cursor provider produced a non-object JSON envelope",
      8,
      "malformed-output",
    );
  }
  const record = envelope as Record<string, unknown>;
  if (record["type"] !== "result") {
    throw new ClawpatchError(
      "cursor provider produced a non-result JSON envelope",
      8,
      "malformed-output",
    );
  }
  const subtype = record["subtype"];
  if (record["is_error"] === true || (subtype !== undefined && subtype !== "success")) {
    const subtypePreview = typeof subtype === "string" ? subtype : "unknown";
    throw new ClawpatchError(
      `cursor provider returned an error envelope (subtype=${safeProviderPreview(
        subtypePreview,
        80,
      )}, is_error=${String(record["is_error"])})`,
      1,
      "provider-failure",
    );
  }
  if (typeof record["result"] !== "string" || record["result"].trim().length === 0) {
    throw new ClawpatchError(
      "cursor provider result envelope is missing result text",
      8,
      "malformed-output",
    );
  }
  const parsed = extractJson(record["result"]);
  if (parsed === null) {
    throw new ClawpatchError(
      `cursor provider result contained no Clawpatch JSON (result chars=${record["result"].length})`,
      8,
      "malformed-output",
    );
  }
  return parsed;
}

function parseSingleCursorEnvelope(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {}
  const parsedLines: unknown[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      parsedLines.push(JSON.parse(trimmed) as unknown);
    } catch {
      throw new ClawpatchError(
        "cursor provider produced malformed JSON envelope",
        8,
        "malformed-output",
      );
    }
  }
  if (parsedLines.length === 1) {
    return parsedLines[0];
  }
  throw new ClawpatchError(
    `cursor provider produced ${parsedLines.length} JSON envelopes; expected exactly one`,
    8,
    "malformed-output",
  );
}

function cursorFailureMessage(stdout: string, stderr: string, exitCode: number | null): string {
  const combined = `${stderr}\n${stdout}`;
  if (/auth|login|not authenticated|keychain|unauthorized/iu.test(combined)) {
    return "cursor provider failed: authentication required or unavailable";
  }
  if (/quota|rate.?limit/iu.test(combined)) {
    return "cursor provider failed: quota or rate limit";
  }
  return `cursor provider failed with exit code ${exitCode ?? "unknown"}`;
}

function assertCursorProviderEnabled(operation: string): void {
  if (process.env[CURSOR_EXPERIMENTAL_ENV] === "1") {
    return;
  }
  throw new ClawpatchError(
    `cursor provider ${operation} is experimental and disabled by default; set ${CURSOR_EXPERIMENTAL_ENV}=1 after completing local HITL verification`,
    2,
    "unsupported-provider",
  );
}

function assertCursorWriteEnabled(): void {
  if (process.env[CURSOR_WRITE_ENV] === "1") {
    return;
  }
  throw new ClawpatchError(
    `cursor provider fix is disabled until write-mode HITL verification passes; set ${CURSOR_WRITE_ENV}=1 only in an isolated checkout`,
    2,
    "unsupported-provider",
  );
}

function cursorTimeoutMs(): number {
  return providerTimeoutMs("CLAWPATCH_CURSOR_TIMEOUT_MS", CURSOR_DEFAULT_TIMEOUT_MS);
}

function cursorEnv(): NodeJS.ProcessEnv {
  const apiKey = process.env["CURSOR_API_KEY"];
  return {
    NO_OPEN_BROWSER: "1",
    ...(apiKey === undefined ? {} : { CURSOR_API_KEY: apiKey }),
  };
}

async function cursorAppVersion(): Promise<string | null> {
  if (process.platform !== "darwin") {
    return null;
  }
  const plist = await readFile(CURSOR_DARWIN_INFO_PLIST, "utf8").catch(() => null);
  if (plist === null) {
    return null;
  }
  const match =
    /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/u.exec(plist) ??
    /<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/u.exec(plist);
  return match?.[1]?.trim() ?? null;
}

function assertCursorRuntimeVersionAllowed(cliVersion: string, appVersion: string | null): void {
  const parsedCli = parseSemver(cliVersion);
  if (parsedCli !== null) {
    assertCursorVersionAllowed(cliVersion, parsedCli);
    return;
  }
  if (isCursorDateBuildVersion(cliVersion) && appVersion !== null) {
    const parsedApp = parseSemver(appVersion);
    if (parsedApp !== null) {
      assertCursorVersionAllowed(appVersion, parsedApp);
      return;
    }
  }
  throw new ClawpatchError(
    "cursor provider could not verify Cursor app/runtime version for CVE-2026-26268 / GHSA-8pcm-8jpx-hv8r",
    4,
    "provider-auth",
  );
}

function assertCursorVersionAllowed(version: string, parsed: [number, number, number]): void {
  const minimum = parseSemver(CURSOR_MIN_SAFE_APP_VERSION);
  if (minimum === null || compareSemanticVersions(parsed, minimum) >= 0) {
    return;
  }
  throw new ClawpatchError(
    `cursor provider blocked vulnerable Cursor version ${version}; upgrade to ${CURSOR_MIN_SAFE_APP_VERSION} or newer for CVE-2026-26268 / GHSA-8pcm-8jpx-hv8r`,
    4,
    "provider-auth",
  );
}

function isCursorDateBuildVersion(version: string): boolean {
  return /^\d{4}\.\d{2}\.\d{2}(?:[-+].*)?$/u.test(version.trim());
}

function parseSemver(version: string): [number, number, number] | null {
  const trimmed = version.trim();
  if (isCursorDateBuildVersion(trimmed)) {
    return null;
  }
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/u.exec(trimmed);
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? "0")];
}

export const cursorTesting = {
  assertCursorRuntimeVersionAllowed,
  cursorAgentArgs,
  cursorEnv,
  cursorFailureMessage,
  cursorPrompt,
  cursorTimeoutMs,
  extractCursorJson,
  parseSemver,
};
