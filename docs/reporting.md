# Reporting

`clawpatch report` renders current findings.

```bash
clawpatch report
clawpatch report -o report.md
clawpatch report --json
clawpatch report --status open --severity high
clawpatch report --feature <featureId>
```

Markdown output includes:

- finding ID
- severity, category, confidence, triage, and status
- feature ID and title when available
- evidence file paths and line ranges when available
- reasoning text
- recommendation and reproduction text when available

`review` also writes a Markdown report for each run under:

```text
.clawpatch/reports/<runId>.md
```

Filters:

- `--status <status>`
- `--severity <severity>`
- `--feature <featureId>`
- `--category <category>`
- `--triage <triage>`

`--json` returns sorted machine-readable finding items with IDs, status,
severity, category, confidence, triage, feature info, evidence refs,
recommendation, and reproduction fields. It does not require parsing Markdown.
