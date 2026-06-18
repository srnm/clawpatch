import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommandArgs } from "../exec.js";
import { ClawpatchError } from "../errors.js";
import { providerExitCode } from "../provider-errors.js";
import { extractJson, safeProviderPreview } from "../provider-json.js";
import { parseOrThrow, parseReviewOutput } from "../provider-output.js";
import { providerCheckTimeoutMs, providerTimeoutMs } from "../provider-runtime.js";
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
} from "../types.js";

export const opencodeProvider: Provider = {
  name: "opencode",
  async check(root: string): Promise<string> {
    const result = await runCommandArgs("opencode", ["--version"], root, undefined, {
      timeoutMs: providerCheckTimeoutMs(),
    });
    if (result.exitCode !== 0) {
      throw new ClawpatchError("opencode CLI not available", 4, "provider-auth");
    }
    return result.stdout.trim();
  },
  async map(root: string, prompt: string, options: ProviderOptions): Promise<AgentMapOutput> {
    const output = await runOpencodeJson(root, prompt, options.model, agentMapJsonSchema, true);
    return parseOrThrow(agentMapOutputSchema, output, "opencode agent-map");
  },
  async review(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<PartitionedReviewOutput> {
    const output = await runOpencodeJson(root, prompt, options.model, reviewJsonSchema, true);
    return parseReviewOutput(output);
  },
  async fix(root: string, prompt: string, options: ProviderOptions): Promise<FixPlanOutput> {
    const output = await runOpencodeJson(root, prompt, options.model, fixPlanJsonSchema, false);
    return parseOrThrow(fixPlanOutputSchema, output, "opencode fix-plan");
  },
  async revalidate(
    root: string,
    prompt: string,
    options: ProviderOptions,
  ): Promise<RevalidateOutput> {
    const output = await runOpencodeJson(root, prompt, options.model, revalidateJsonSchema, true);
    return parseOrThrow(revalidateOutputSchema, output, "opencode revalidate");
  },
};

const OPENCODE_READ_ONLY_PERMISSION = JSON.stringify({
  bash: "deny",
  edit: "deny",
  task: "deny",
  webfetch: "deny",
  websearch: "deny",
});

async function runOpencodeJson(
  root: string,
  prompt: string,
  model: string | null,
  schema: object,
  readOnly: boolean,
): Promise<unknown> {
  const dir = await mkdtemp(join(tmpdir(), "clawpatch-opencode-"));
  const promptPath = join(dir, "prompt.txt");
  try {
    await writeFile(promptPath, opencodePrompt(prompt, schema, readOnly), "utf8");
    const args = [
      "run",
      "Follow the attached clawpatch prompt. Return only the requested JSON object.",
      "--format",
      "json",
      "--dir",
      root,
      `--file=${promptPath}`,
    ];
    if (model !== null) {
      args.push("--model", model);
    }
    if (!readOnly) {
      args.push("--dangerously-skip-permissions");
    }
    const result = await runCommandArgs(
      "opencode",
      args,
      root,
      undefined,
      readOnly
        ? {
            trimOutput: false,
            env: { OPENCODE_PERMISSION: OPENCODE_READ_ONLY_PERMISSION },
            timeoutMs: providerTimeoutMs("CLAWPATCH_OPENCODE_TIMEOUT_MS", 300_000),
          }
        : {
            trimOutput: false,
            timeoutMs: providerTimeoutMs("CLAWPATCH_OPENCODE_TIMEOUT_MS", 300_000),
          },
    );
    if (result.exitCode !== 0) {
      throw new ClawpatchError(
        opencodeFailureMessage(result.stdout, result.stderr),
        providerExitCode(result.stdout, result.stderr),
        "provider-failure",
      );
    }
    return extractOpencodeJson(result.stdout);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function opencodePrompt(prompt: string, schema: object, readOnly: boolean): string {
  const promptBody = readOnly
    ? "READ-ONLY REVIEW MODE.\n" +
      "Do not modify, create, or delete any files.\n" +
      "Do not run shell commands or launch subagents.\n\n" +
      prompt
    : prompt;
  return `${promptBody}

Provider output schema:
${JSON.stringify(schema, null, 2)}

Return only one JSON object matching the schema.`;
}

export function extractOpencodeJson(stdout: string): unknown {
  const textParts: string[] = [];
  const observedKinds = new Set<string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let event: {
      type?: string;
      part?: { text?: unknown };
      error?: { data?: { message?: unknown }; name?: unknown; message?: unknown };
    };
    try {
      event = JSON.parse(trimmed) as typeof event;
    } catch {
      continue;
    }
    if (typeof event.type === "string") {
      observedKinds.add(event.type);
    }
    if (event.type === "text" && typeof event.part?.text === "string") {
      textParts.push(event.part.text);
    }
    if (event.type === "error") {
      const message =
        typeof event.error?.data?.message === "string"
          ? event.error.data.message
          : typeof event.error?.message === "string"
            ? event.error.message
            : typeof event.error?.name === "string"
              ? event.error.name
              : "unknown";
      throw new ClawpatchError(
        `opencode provider error: ${message}`,
        providerExitCode("", message),
        "provider-failure",
      );
    }
  }
  const combined = textParts.join("").trim();
  if (combined.length === 0) {
    throw new ClawpatchError(
      `opencode provider produced no extractable text. Observed event kinds: ` +
        `[${[...observedKinds].join(", ")}].`,
      8,
      "malformed-output",
    );
  }
  const parsed = extractJson(combined);
  if (parsed === null) {
    throw new ClawpatchError(
      `opencode provider produced unparsable JSON ` +
        `(text chars=${combined.length}, observed event kinds: ` +
        `[${[...observedKinds].join(", ")}], output preview: ${safeProviderPreview(combined)})`,
      8,
      "malformed-output",
    );
  }
  return parsed;
}

function opencodeFailureMessage(stdout: string, stderr: string): string {
  if (stderr.trim().length > 0) {
    return `opencode provider failed: ${stderr}`;
  }
  const preview = stdout.slice(0, 800).replace(/\s+/gu, " ");
  return preview.length === 0
    ? "opencode provider failed"
    : `opencode provider failed (stdout preview: ${preview})`;
}

export const opencodeTesting = { extractOpencodeJson };
