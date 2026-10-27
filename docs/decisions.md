# Decisions

Decisions taken on 2026-10-27 to unblock [ROADMAP.md](../ROADMAP.md) §9. Each was made with a sensible default instead of waiting. Each lists what would make it change. Revisit after the ten buyer conversations.

## D1. Regulation and buyer: PCI DSS 4.0.1, head of engineering at a Series A–B fintech

- **Chosen because** its requirements are the most code-shaped of the candidates (stored card data, logging, authentication, secure development, encryption in transit), the assessment repeats every year, and the assessor asks for exactly the evidence this tool produces.
- **Rejected for now:** EU AI Act high-risk obligations (less code-mappable, most startups are not high-risk), DORA and NIS2 (mostly policy and governance).
- **Copyright:** the PCI DSS text belongs to the PCI Security Standards Council. The fixture carries requirement numbers and paraphrased obligations, never the standard verbatim.
- **Changes if** most of the first ten conversations name a different deadline.

## D2. Token cost: bring your own key in the Action, the product's key in the App

- The GitHub Action takes `anthropic-api-key` and `voyage-api-key` inputs. Without them it runs the offline analyst and says so in the comment.
- The hosted App uses the product's keys with a per-tenant monthly cap. The default cap is $25.
- **Changes if** early tenants refuse to supply keys to the Action.

## D3. Tenancy: Clerk Organizations, with one personal org per user as the fallback

- A tenant row maps to a GitHub App installation and, optionally, a Clerk organization id.
- A signed-in user with no organization sees the tenant whose installation they created.
- **Changes if** Clerk Organizations pricing or limits get in the way.

## D4. Real repositories for the first public audits

| Repo | Why |
|---|---|
| `ghostfolio/ghostfolio` | TypeScript personal-finance app: account and transaction data |
| `juice-shop/juice-shop` | Deliberately insecure TypeScript shop: a control that must produce findings |
| `maybe-finance/maybe` | Rails personal-finance app: tests Ruby coverage |

- Each is audited at a pinned commit with the bundled demo rules plus the PCI DSS fixture.
- The indexer caps files and bytes so a large repo fails fast instead of running up cost.
- **Changes if** a repo is too large for the cap or its licence forbids publishing excerpts. All three are open-source licensed: AGPL-3.0, MIT and AGPL-3.0.

## D5. Human review happens after the report, not by pausing the graph

- The LangGraph `interruptBefore` hook stays unused. Pausing before the report would mean no report until someone clicks.
- Reviews are stored per finding and carried forward to later runs on the same repo by a finding signature.

## D6. Fix PRs and evidence export wait for a design partner

- §6 (draft fix PRs) and §7 (Vanta/Drata export) are not built until a partner asks. The `frameworkRefs` field on controls is added now because it costs nothing.
