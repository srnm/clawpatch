# Findings

Findings are stored in `.clawpatch/findings/<findingId>.json`.

Each finding records:

- feature ID
- title
- category
- severity
- confidence
- triage
- evidence
- reasoning
- reproduction notes
- recommendation
- status
- linked patch attempts

Statuses:

- `open`
- `false-positive`
- `fixed`
- `wont-fix`
- `uncertain`

Current ways to inspect findings:

```bash
clawpatch status
clawpatch report
clawpatch report -o report.md
clawpatch report --json
clawpatch report --status open --severity high
clawpatch report --feature <featureId>
```

Current ways to act on a finding:

```bash
clawpatch fix --finding <findingId>
clawpatch revalidate --finding <findingId>
```

There is no interactive `triage` command yet.
