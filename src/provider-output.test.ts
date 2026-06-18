import { describe, expect, it } from "vitest";
import { ClawpatchError } from "./errors.js";
import {
  formatZodError,
  formatZodIssue,
  parseOrThrow,
  parseReviewOutput,
} from "./provider-output.js";
import { reviewOutputSchema } from "./types.js";

function finding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Sample finding",
    category: "bug",
    severity: "medium",
    confidence: "high",
    evidence: [],
    reasoning: "Sample reasoning.",
    reproduction: null,
    recommendation: "Sample recommendation.",
    whyTestsDoNotAlreadyCoverThis: "Tests do not encode this case.",
    suggestedRegressionTest: null,
    minimumFixScope: "Touch only the offending line.",
    ...overrides,
  };
}

describe("parseReviewOutput", () => {
  it("preserves valid findings", () => {
    const result = parseReviewOutput({
      findings: [
        finding({ title: "first", category: "bug" }),
        finding({ title: "second", category: "security" }),
        finding({ title: "third", category: "performance" }),
      ],
      inspected: { files: ["src/a.ts"], symbols: [], notes: [] },
    });

    expect(result.findings.map((entry) => entry.title)).toEqual(["first", "second", "third"]);
    expect(result.droppedFindings).toEqual([]);
    expect(result.inspected.files).toEqual(["src/a.ts"]);
  });

  it("keeps valid siblings when one finding is invalid", () => {
    const result = parseReviewOutput({
      findings: [
        finding({ title: "first" }),
        finding({ title: "invalid", category: "quality" }),
        finding({ title: "third", category: "performance" }),
      ],
      inspected: { files: [], symbols: [], notes: [] },
    });

    expect(result.findings.map((entry) => entry.title)).toEqual(["first", "third"]);
    expect(result.droppedFindings).toHaveLength(1);
    expect(result.droppedFindings[0]).toMatchObject({
      path: ["findings", 1, "category"],
      layer: "schema",
    });
    expect(result.droppedFindings[0]?.sample).toContain("quality");
  });

  it("throws a malformed-output error for an invalid container", () => {
    expect(() =>
      parseReviewOutput({
        findings: "not-an-array",
        inspected: { files: [], symbols: [], notes: [] },
      }),
    ).toThrowError(/findings/u);
    try {
      parseReviewOutput({
        findings: "not-an-array",
        inspected: { files: [], symbols: [], notes: [] },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ClawpatchError);
      expect(error).toMatchObject({ code: "malformed-output", exitCode: 8 });
    }
  });

  it("bounds invalid finding samples", () => {
    const result = parseReviewOutput({
      findings: [finding({ title: "x".repeat(500), category: "quality" })],
      inspected: { files: [], symbols: [], notes: [] },
    });

    expect(result.droppedFindings[0]?.sample).toHaveLength(200);
    expect(result.droppedFindings[0]?.sample.endsWith("...")).toBe(true);
  });
});

describe("schema error formatting", () => {
  it("reports an invalid enum with its path, value, and expected values", () => {
    const input = {
      findings: [finding({ category: "quality" })],
      inspected: { files: [], symbols: [], notes: [] },
    };
    const result = reviewOutputSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (result.success) return;

    const message = formatZodError(result.error, input);
    expect(message).toMatch(/findings\[0\]\.category="quality"/u);
    expect(message).toMatch(/invalid_value/u);
    expect(message).toMatch(/expected one of [^()]*\bbug\b/u);
    expect(message.split("\n")).toHaveLength(1);
  });

  it("reports a missing required field", () => {
    const input = finding();
    delete input["reasoning"];
    const result = reviewOutputSchema.safeParse({
      findings: [input],
      inspected: { files: [], symbols: [], notes: [] },
    });
    expect(result.success).toBe(false);
    if (result.success) return;

    expect(formatZodError(result.error, { findings: [input] })).toMatch(
      /findings\[0\]\.reasoning.*invalid_type.*expected string/u,
    );
  });

  it("bounds received value previews", () => {
    const longValue = "a".repeat(500);
    const issue = formatZodIssue({
      code: "invalid_type",
      path: ["findings", 0, "reasoning"],
      message: "x",
      expected: "string",
      received: longValue,
    } as unknown as Parameters<typeof formatZodIssue>[0]);

    expect(issue.length).toBeLessThan(longValue.length);
    expect(issue).toMatch(/findings\[0\]\.reasoning=/u);
  });

  it("summarizes additional issues", () => {
    const error = {
      issues: Array.from({ length: 5 }, (_, index) => ({
        code: "invalid_type",
        path: ["x", index],
        message: "x",
        expected: "string",
        received: "n",
      })),
    } as unknown as Parameters<typeof formatZodError>[0];

    expect(formatZodError(error)).toMatch(/\(\+2 more\)$/u);
  });
});

describe("parseOrThrow", () => {
  it("returns parsed data", () => {
    const output = { findings: [], inspected: { files: [], symbols: [], notes: [] } };
    expect(parseOrThrow(reviewOutputSchema, output, "test")).toEqual(output);
  });

  it("wraps schema failures as malformed provider output", () => {
    expect(() =>
      parseOrThrow(
        reviewOutputSchema,
        { findings: [{ category: "quality" }], inspected: {} },
        "test-label",
      ),
    ).toThrowError(/test-label: schema validation failed: findings\[0\]/u);
    try {
      parseOrThrow(reviewOutputSchema, { findings: [], inspected: {} }, "test-label");
    } catch (error) {
      expect(error).toMatchObject({ code: "malformed-output", exitCode: 8 });
    }
  });
});
