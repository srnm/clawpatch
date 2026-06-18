import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommandArgs } from "../exec.js";
import { ClawpatchError } from "../errors.js";
import { providerExitCode } from "../provider-errors.js";
import { parseCodexJson } from "../provider-json.js";
import { parseOrThrow, parseReviewOutput } from "../provider-output.js";
import {
  agentMapJsonSchema,
  fixPlanJsonSchema,
  reviewJsonSchema,
  revalidateJsonSchema,
} from "../provider-schema.js";
import type { PartitionedReviewOutput, Provider, ProviderOptions } from "../provider-types.js";
import {
  AgentMapOutput,
  FixPlanOutput,
  RevalidateOutput,
  agentMapOutputSchema,
  fixPlanOutputSchema,
  revalidateOutputSchema,
  type CodexConfig,
} from "../types.js";

export const codexProvider: Provider = {
  name: "codex",
  async check(root: string): Promise<string> {
    const result = await runCommandArgs("codex", ["--version"], root);
    if (result.exitCode !== 0) {
      throw new ClawpatchError("codex CLI not available", 4, "provider-auth");
    }
    return result.stdout.trim();
  },
  async map(root: string, prompt: string, options: ProviderOptions): Promise<AgentMapOutput> {
    const output = await runCodexJson(root, prompt, options, agentMapJsonSchema);
    return parseOrThrow(agentMapOutputSchema, output, "codex agent-map");
  },
  async review(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<PartitionedReviewOutput> {
    const output = await runCodexJson(root, prompt, options, reviewJsonSchema);
    return parseReviewOutput(output);
  },
  async fix(root: string, prompt: string, options: ProviderOptions): Promise<FixPlanOutput> {
    const output = await runCodexJson(root, prompt, options, fixPlanJsonSchema, "workspace-write");
    return parseOrThrow(fixPlanOutputSchema, output, "codex fix-plan");
  },
  async revalidate(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<RevalidateOutput> {
    const output = await runCodexJson(root, prompt, options, revalidateJsonSchema);
    return parseOrThrow(revalidateOutputSchema, output, "codex revalidate");
  },
};

const CODEX_DEFAULT_TIMEOUT_MS = 300_000;
async function runCodexJson(
  root: string,
  prompt: string,
  options: ProviderOptions,
  schema: object,
  sandbox = "read-only",
): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), "clawpatch-codex-"));
  const schemaPath = join(dir, "schema.json");
  const outputPath = join(dir, "output.json");
  await writeFile(schemaPath, JSON.stringify(schema), "utf8");
  try {
    const args = [
      "exec",
      "--cd",
      root,
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
    ];
    addCodexSandboxArgs(args, sandbox);
    addCodexModelArgs(args, options);
    args.push("-");
    const result = await runCommandArgs("codex", args, root, prompt, {
      timeoutMs: codexTimeoutMs(),
    });
    if (result.exitCode !== 0) {
      throw new ClawpatchError(
        codexFailureMessage(result.stdout, result.stderr),
        providerExitCode(result.stdout, result.stderr),
        "provider-failure",
      );
    }
    const raw = await readFile(outputPath, "utf8").catch(() => "");
    if (raw.trim().length === 0) {
      throw new ClawpatchError("codex provider produced no JSON output", 8, "malformed-output");
    }
    return parseCodexJson(raw);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function codexFailureMessage(stdout: string, stderr: string): string {
  const output = stderr || stdout;
  const scopeAdvice = /api\.responses\.write|insufficient permissions|missing scopes/iu.test(output)
    ? "\nCodex/OpenAI auth is missing Responses API write access (`api.responses.write`). Check the active credentials, organization/project role, and restricted key scopes."
    : "";
  return `codex provider failed: ${output}${scopeAdvice}`;
}

function codexTimeoutMs(): number {
  const raw =
    process.env["CLAWPATCH_CODEX_TIMEOUT_MS"] ?? process.env["CLAWPATCH_PROVIDER_TIMEOUT_MS"];
  if (raw === undefined) {
    return CODEX_DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : CODEX_DEFAULT_TIMEOUT_MS;
}

function addCodexSandboxArgs(args: string[], sandbox: string): void {
  const override = process.env["CLAWPATCH_CODEX_SANDBOX"]?.trim();
  if (override === "bypass" || override === "none") {
    args.push("--dangerously-bypass-approvals-and-sandbox");
    return;
  }
  args.push("--sandbox", override && override.length > 0 ? override : sandbox);
}

function addCodexModelArgs(args: string[], options: ProviderOptions): void {
  if (options.skipGitRepoCheck) {
    args.push("--skip-git-repo-check");
  }
  addCodexConfigArgs(args, options.codexConfig ?? {});
  if (options.model !== null) {
    args.push("--model", options.model);
  }
  if (options.reasoningEffort !== null) {
    args.push("-c", `model_reasoning_effort="${options.reasoningEffort}"`);
  }
}

const CODEX_CONFIG_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u;

function addCodexConfigArgs(args: string[], config: CodexConfig): void {
  for (const [key, value] of Object.entries(config).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    args.push("-c", renderCodexConfigEntry(key, value));
  }
}

function renderCodexConfigEntry(key: string, value: CodexConfig[string]): string {
  if (!CODEX_CONFIG_KEY.test(key)) {
    throw new ClawpatchError(`invalid Codex config key: ${key}`, 2, "invalid-usage");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new ClawpatchError(
      `invalid Codex config value for ${key}: finite number required`,
      2,
      "invalid-usage",
    );
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new ClawpatchError(`invalid Codex config value for ${key}`, 2, "invalid-usage");
  }
  return `${key}=${encoded}`;
}

export const codexTesting = {
  addCodexConfigArgs,
  addCodexModelArgs,
  addCodexSandboxArgs,
  codexFailureMessage,
  codexTimeoutMs,
  parseCodexJson,
};
