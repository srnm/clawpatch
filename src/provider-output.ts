import { z, type ZodError, type ZodIssue, type ZodType } from "zod";
import { ClawpatchError } from "./errors.js";
import type { DroppedFinding, PartitionedReviewOutput } from "./provider-types.js";
import {
  type ReviewFinding,
  reviewFindingSchema,
  reviewInspectedSchema,
  reviewOutputSchema,
} from "./types.js";

const ZOD_VALUE_PREVIEW_LIMIT = 80;
const ZOD_ISSUE_HEAD_LIMIT = 3;

function formatZodPath(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) {
    return "<root>";
  }
  let out = "";
  for (let index = 0; index < path.length; index += 1) {
    const segment = path[index];
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else if (index === 0) {
      out += String(segment);
    } else {
      out += `.${String(segment)}`;
    }
  }
  return out;
}

function previewZodValue(value: unknown): string {
  let rendered: string;
  if (typeof value === "string") {
    rendered = JSON.stringify(value);
  } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
    rendered = String(value);
  } else if (value === undefined) {
    return "";
  } else {
    try {
      rendered = JSON.stringify(value) ?? String(value);
    } catch {
      rendered = String(value);
    }
  }
  return rendered.length > ZOD_VALUE_PREVIEW_LIMIT
    ? `${rendered.slice(0, ZOD_VALUE_PREVIEW_LIMIT - 1)}…`
    : rendered;
}

function lookupAtPath(input: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let current: unknown = input;
  for (const segment of path) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof segment === "number") {
      if (!Array.isArray(current)) {
        return undefined;
      }
      current = current[segment];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[String(segment)];
    } else {
      return undefined;
    }
  }
  return current;
}

export function formatZodIssue(issue: ZodIssue, input?: unknown): string {
  const path = formatZodPath(issue.path);
  const issueRecord = issue as ZodIssue & {
    received?: unknown;
    expected?: unknown;
    values?: unknown;
  };
  let received: unknown;
  let hasReceived = false;
  if ("received" in issueRecord && issueRecord.received !== undefined) {
    received = issueRecord.received;
    hasReceived = true;
  } else if (input !== undefined && issue.path.length > 0) {
    const looked = lookupAtPath(input, issue.path);
    if (looked !== undefined) {
      received = looked;
      hasReceived = true;
    }
  }
  const receivedSegment = hasReceived ? `=${previewZodValue(received)}` : "";
  let expectedSegment = "";
  if (Array.isArray(issueRecord.values)) {
    expectedSegment = `, expected one of ${issueRecord.values.map(String).join(",")}`;
  } else if (typeof issueRecord.expected === "string" && issueRecord.expected.length > 0) {
    expectedSegment = `, expected ${issueRecord.expected}`;
  }
  return `${path}${receivedSegment} (${issue.code}${expectedSegment})`;
}

export function formatZodError(error: ZodError, input?: unknown): string {
  const issues = error.issues ?? [];
  if (issues.length === 0) {
    return "schema validation failed";
  }
  const head = issues
    .slice(0, ZOD_ISSUE_HEAD_LIMIT)
    .map((issue) => formatZodIssue(issue, input))
    .join("; ");
  const more =
    issues.length > ZOD_ISSUE_HEAD_LIMIT ? ` (+${issues.length - ZOD_ISSUE_HEAD_LIMIT} more)` : "";
  return `schema validation failed: ${head}${more}`;
}

export function parseOrThrow<T>(schema: ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }
  throw new ClawpatchError(
    `${label}: ${formatZodError(result.error, input)}`,
    8,
    "malformed-output",
  );
}

const reviewContainerSchema = z.object({
  findings: z.array(z.unknown()),
  inspected: reviewInspectedSchema,
});

function truncateSample(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) {
    text = String(value);
  }
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

export function parseReviewOutput(output: unknown): PartitionedReviewOutput {
  const whole = reviewOutputSchema.safeParse(output);
  if (whole.success) {
    return {
      findings: whole.data.findings,
      inspected: whole.data.inspected,
      droppedFindings: [],
    };
  }

  const container = reviewContainerSchema.safeParse(output);
  if (!container.success) {
    const issue = container.error.issues[0];
    const where =
      issue?.path
        .map((segment) => (typeof segment === "symbol" ? segment.toString() : segment))
        .join(".") ?? "<root>";
    throw new ClawpatchError(
      `provider review output is malformed at ${where}: ${issue?.message ?? "invalid review output shape"}`,
      8,
      "malformed-output",
    );
  }

  const validFindings: ReviewFinding[] = [];
  const droppedFindings: DroppedFinding[] = [];
  container.data.findings.forEach((candidate, index) => {
    const result = reviewFindingSchema.safeParse(candidate);
    if (result.success) {
      validFindings.push(result.data);
      return;
    }
    const issue = result.error.issues[0];
    const issuePath = (issue?.path ?? []).map((segment) =>
      typeof segment === "symbol" ? segment.toString() : segment,
    );
    droppedFindings.push({
      path: ["findings", index, ...issuePath],
      message: issue?.message ?? "invalid finding shape",
      sample: truncateSample(candidate),
      layer: "schema",
    });
  });

  return {
    findings: validFindings,
    inspected: container.data.inspected,
    droppedFindings,
  };
}
