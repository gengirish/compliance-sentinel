# Audits of real open-source repositories

Compliance Sentinel audited three public repositories on 2026-10-27, each at a pinned commit, with Claude and the bundled demo rules. The rules were abridged excerpts of GDPR, the FTC Safeguards Rule, SEC Regulation S-P, FCA PS21/3 and MAS Notice 655. The PCI DSS rules were added after these runs.

Each folder holds the report (`report.html`), the run summary (`summary.json`) and a labelling sheet (`labels.json`). Every violation in the sheet is labelled true or false positive. Every `needs_review` finding is labelled useful or noise. Each label comes with a note citing the code at `path:line`.

**The labels are a first pass by Claude Code, and a person has not confirmed them yet.** Each entry says so in its `labelledBy` field. The labeller was asked to be strict: a control implemented anywhere in the repository makes the finding false, and so does a duty that code cannot fail.

| Repo | Commit | Violations | True positives | False positives | Precision | Needs review | Useful | Noise | Cost |
|---|---|---|---|---|---|---|---|---|---|
| ghostfolio/ghostfolio | `5ab32ff` | 6 | 2 | 4 | 33% | 26 | 7 | 19 | $1.23 |
| juice-shop/juice-shop | `717f5ef` | 10 | 6 | 4 | 60% | 24 | 8 | 16 | $1.10 |
| maybe-finance/maybe | `77b5469` | 8 | 2 | 6 | 25% | 25 | 7 | 18 | $1.49 |
| **Total** | | 24 | 10 | 14 | 42% | 75 | 22 | 53 | $3.82 |

Embeddings came from the local hash embedder, because no Voyage key was set. `node scripts/tally-real-labels.mjs` regenerates this table from the label files.

## What the labels show

- **The real gaps are code-level and specific.** Multi-factor authentication is optional for administrators in all three apps. Ghostfolio and Juice Shop keep no audit trail of user activity. Juice Shop lets any signed-in user list every user record.
- **Most false positives are organisational duties judged as code violations.** Examples are notifying a regulator within 72 hours, running an incident-response programme, and FCA scenario testing. These cited unrelated files, such as a UI toast test or a CI notification step. They should have been `needs_review`. The golden eval shows the same pattern, so this is the next fix to the judge prompt.
- **Some false positives miss an implementation elsewhere in the repository.** For example, Ghostfolio's user deletion in `user.service.ts` covers disposal.
- **`needs_review` is noisy.** About seven in ten were labelled noise, mostly FCA operational-resilience and governance duties that do not apply to an application codebase.

## Reproduce

```bash
pnpm audit:real                 # needs ANTHROPIC_API_KEY; writes into this folder
pnpm audit:real --only juice-shop/juice-shop
```

The repositories and pinned commits are listed in [repos.json](repos.json). A re-run keeps existing labels for findings whose obligation and evidence are unchanged, and adds unlabelled entries for new ones.

The audited projects are open source: Ghostfolio and Maybe under AGPL-3.0, OWASP Juice Shop under MIT. The reports quote short excerpts of their code for the purpose of the findings. Decision support, not legal advice: the findings do not say whether any project or its operators comply with any regulation.
