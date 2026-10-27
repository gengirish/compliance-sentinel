# GitHub Action

Compliance Sentinel runs as a GitHub Action. On every pull request it audits the repository against the bundled regulation excerpts and posts one summary comment, which it updates on later pushes. Each violation in the comment cites the regulation section and links to the `file:line` at the audited commit. The full HTML report is attached to the workflow run as an artifact.

## Install

Add this file as `.github/workflows/compliance-sentinel.yml`:

```yaml
name: Compliance Sentinel
on:
  pull_request:
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: write

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: gengirish/compliance-sentinel@main
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          rules: pci
          fail-on: critical
```

Then add `ANTHROPIC_API_KEY` under **Settings → Secrets and variables → Actions**. Without the key the Action still runs, using the offline keyword baseline. That baseline checks only the controls in its catalogue, and the comment says so.

## Inputs

| Input | Default | What it does |
|---|---|---|
| `anthropic-api-key` | empty | Claude judges each obligation. Without it, the offline baseline runs |
| `voyage-api-key` | empty | `voyage-law-2` embeddings for retrieval. Without it, a local hash embedder is used |
| `rules` | `pci` | Prefixes of the bundled rule files: `pci`, `gdpr`, `ftc`, `sec`, `fca`, `mas`, comma-separated. Empty means all |
| `fail-on` | `critical` | Fail the job on a violation at or above this severity, or `none` |
| `comment` | `true` | Post or update the pull-request comment |
| `max-cost-usd` | `2` | Per-run model spend cap |

## Cost

The bundled demo rules cost about $0.45 per run with Claude on a small repository (see the Evaluation section of the README). A larger repository costs more, because each obligation's evidence is longer, and the per-run cap stops further model calls once it is reached.

## Limits

- The rules are bundled excerpts, not the live regulatory feeds. The hosted app tracks live sources.
- A repository over 2,000 indexable files or 8 MB of indexable text is refused rather than partly audited. `INDEX_MAX_FILES` and `INDEX_MAX_BYTES` raise the caps.
- Decision support, not legal advice. Findings do not guarantee compliance or complete coverage of any regulation.
