import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import type { Rule } from "../db/schema.js";
import {
  AssessmentSchema,
  ObligationListSchema,
  RelevanceSchema,
  type RuleChunkRef,
} from "../graph/types.js";
import { type Analyst, type AssessInput, formatEvidence, formatRuleChunks } from "./analyst.js";

export const SMART_MODEL = "claude-sonnet-5-5";
export const FAST_MODEL = "claude-haiku-5-5";

/** USD per million tokens. Cache reads are billed at a tenth of the input price. */
const PRICING: Record<string, { input: number; output: number }> = {
  [SMART_MODEL]: { input: 2, output: 10 },
  [FAST_MODEL]: { input: 0.1, output: 0.5 },
};

export function costUsd(model: string, usage: Anthropic.Usage): number {
  const price = PRICING[model];
  if (!price) return 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return (
    (usage.input_tokens * price.input +
      cacheRead * price.input * 0.1 +
      cacheWrite * price.input * 1.25 +
      usage.output_tokens * price.output) /
    1_000_000
  );
}

const AUDITOR_SYSTEM = `You are a compliance engineer auditing a software codebase against regulatory text.
You work only from the material in the message: regulation chunks, each tagged with a numeric id, and code excerpts with line numbers.
Cite regulation chunks by the ids shown. Cite code by the exact path and line numbers shown. Never cite anything that is not in the message.
Your output is decision support for a human reviewer, not a legal opinion, so prefer "needs_review" over a guess.`;

export class ClaudeAnalyst implements Analyst {
  readonly name = "claude";
  private readonly client: Anthropic;

  constructor(client?: Anthropic) {
    this.client = client ?? new Anthropic();
  }

  private async structured<S extends z.ZodType>(opts: {
    model: string;
    effort: "low" | "medium" | "high";
    schema: S;
    prompt: string;
    maxTokens?: number;
  }): Promise<{ data: z.infer<S>; costUsd: number }> {
    const response = await this.client.messages.parse({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 16_000,
      system: AUDITOR_SYSTEM,
      messages: [{ role: "user", content: opts.prompt }],
      output_config: { effort: opts.effort, format: zodOutputFormat(opts.schema) },
    });
    const cost = costUsd(opts.model, response.usage);
    if (response.stop_reason === "refusal") {
      throw new AnalystRefusal(`model declined the request (${response.stop_details?.category ?? "unspecified"})`, cost);
    }
    if (response.stop_reason === "max_tokens" || response.parsed_output == null) {
      throw new Error(`structured output unavailable (stop_reason: ${response.stop_reason})`);
    }
    return { data: response.parsed_output as z.infer<S>, costUsd: cost };
  }

  async isRelevant(rule: Rule, chunks: RuleChunkRef[]) {
    const sample = chunks
      .slice(0, 3)
      .map((c) => c.text)
      .join("\n\n")
      .slice(0, 6_000);
    const { data, costUsd } = await this.structured({
      model: FAST_MODEL,
      effort: "low",
      schema: RelevanceSchema,
      maxTokens: 1_000,
      prompt: `Decide whether this rule is relevant to a software compliance audit.
It is relevant when it imposes duties that software systems or data-handling processes must implement (privacy, security, record keeping, consent, retention, breach notification, access control and similar).
It is not relevant when it only concerns matters with no bearing on software, such as tariffs, airworthiness or fisheries.

Title: ${rule.title}

Opening text:
${sample}`,
    });
    return { ...data, costUsd };
  }

  async extractObligations(rule: Rule, chunks: RuleChunkRef[]) {
    const { data, costUsd } = await this.structured({
      model: SMART_MODEL,
      effort: "medium",
      schema: ObligationListSchema,
      prompt: `Read the regulation chunks below and list the obligations that a software team would have to implement or evidence in code, configuration or data handling.

Guidance:
- One obligation per distinct duty. Merge restatements of the same duty.
- Skip definitions, scope clauses, penalties and duties that cannot show up in a codebase.
- technical_controls are search keywords for the codebase: identifiers, API names and words likely to appear in code that implements or breaks the duty.
- source_chunk_ids must be ids from the chunks below that actually state the duty.
- Return an empty list when the text imposes no such duty.

Rule: ${rule.title}
Effective: ${rule.effectiveDate ?? "not stated"}

${formatRuleChunks(chunks)}`,
    });
    return { obligations: data.obligations, costUsd };
  }

  async assess(input: AssessInput) {
    const { data, costUsd } = await this.structured({
      model: SMART_MODEL,
      effort: "medium",
      schema: AssessmentSchema,
      prompt: `Judge whether the codebase meets the obligation, using only the evidence below.

Obligation: ${input.obligation.obligation}
Applies to: ${input.obligation.appliesTo}
Rule: ${input.rule.title}

Regulation text:
${formatRuleChunks(input.ruleChunks)}

Code evidence (the search covered the whole repository; these are the most relevant excerpts):
${input.evidence.length ? formatEvidence(input.evidence) : "(no relevant code was found)"}

How to decide:
- "violation": the code shown breaks the obligation, or a control the obligation requires is plainly absent from the place it would live. Cite the lines that show it.
- "compliant": the code shown implements the obligation. Cite the lines that implement it.
- "needs_review": the evidence is missing, ambiguous, or the obligation is organisational and cannot be judged from code.
- Severity reflects the harm if the violation were exploited: critical for exposed personal data or credentials and for missing legally mandated notifications, high for missing safeguards, medium and low for lesser gaps.
- A violation or compliant verdict needs at least one regulation chunk id and at least one code location. Without both, answer "needs_review".
- Keep each cited range tight: the few lines that prove the point, not the whole file.`,
    });
    return { assessment: data, costUsd };
  }
}

/** Raised when the model's safety classifiers decline a request. */
export class AnalystRefusal extends Error {
  constructor(
    message: string,
    readonly costUsd: number,
  ) {
    super(message);
    this.name = "AnalystRefusal";
  }
}
