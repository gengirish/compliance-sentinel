import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  CheckCheck,
  FileText,
  Gauge,
  GitPullRequest,
  Landmark,
  Quote,
  ScanSearch,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: { absolute: "Compliance Sentinel · PCI DSS evidence from your code, down to the line" },
  description:
    "Maps each PCI DSS v4.0.1 requirement to your repository and checks every pull request for new gaps. Every finding cites the requirement and the exact file:line, with citations checked mechanically.",
  robots: { index: true, follow: true },
};

const REPO_URL = "https://github.com/gengirish/compliance-sentinel";
const SAMPLE_REPORT_URL = `${REPO_URL}/blob/main/samples/report-example.pdf`;
const ACTION_DOCS_URL = `${REPO_URL}/blob/main/docs/github-action.md`;
const REAL_REPOS_URL = `${REPO_URL}/tree/main/samples/real`;

const INSTALL_SNIPPET = `- uses: actions/checkout@v4
- uses: gengirish/compliance-sentinel@main
  with:
    anthropic-api-key: \${{ secrets.ANTHROPIC_API_KEY }}
    rules: pci
    fail-on: critical`;

const STEPS = [
  {
    icon: Workflow,
    title: "Add one workflow step",
    body: "The GitHub Action runs on every pull request. There is no agent to deploy. Code leaves your CI runner only as the excerpts sent to the model, plus the chunks sent for embedding if you add a Voyage key.",
  },
  {
    icon: Landmark,
    title: "Map each requirement",
    body: "PCI DSS v4.0.1 requirements that code can meet or break are split into obligations: card data storage, masking, transmission, unique IDs, MFA and audit logging.",
  },
  {
    icon: ScanSearch,
    title: "Find the evidence",
    body: "Per obligation, keyword and vector search find the code, and a repository-wide count shows when a control is absent rather than just unseen.",
  },
  {
    icon: GitPullRequest,
    title: "Comment on the pull request",
    body: "One comment per pull request, updated on each push, lists violations by severity with linked file:line. A critical finding can fail the check.",
  },
];

const GUARANTEES = [
  {
    icon: Quote,
    title: "Two citations or no verdict",
    body: "A verdict needs at least one requirement section and one code location. Without both, the only allowed answer is needs review.",
  },
  {
    icon: CheckCheck,
    title: "Citations checked without a model",
    body: "Every cited section must belong to the rule and every file:line range must exist at the audited commit. Invented citations are dropped and the verdict is downgraded.",
  },
  {
    icon: Gauge,
    title: "Bounded cost",
    body: "A per-run cost cap stops further model calls. On the bundled demo app a full audit costs about fifty cents.",
  },
];

const EVAL = [
  { value: "28/30", label: "planted violations found across three runs" },
  { value: "$0.53", label: "average model cost per run on the demo app" },
  { value: "42%", label: "precision on three real open-source repos" },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen overflow-x-hidden">
      <header className="sticky top-0 z-10 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
          <Link href="/" className="flex items-center gap-2 font-bold">
            <ShieldCheck className="size-5 text-primary-light" aria-hidden />
            <span className="gradient-text">Compliance Sentinel</span>
          </Link>
          <nav aria-label="Sections" className="hidden gap-5 text-sm text-muted md:flex">
            <a href="#install" className="hover:text-foreground">
              Install
            </a>
            <a href="#how-it-works" className="hover:text-foreground">
              How it works
            </a>
            <a href="#results" className="hover:text-foreground">
              Results
            </a>
          </nav>
          <Link href="/overview" className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "ml-auto")}>
            Open dashboard
          </Link>
        </div>
      </header>

      <main>
        <section className="relative">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 -top-24 mx-auto h-96 max-w-4xl rounded-full bg-primary/20 blur-3xl"
          />
          <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-4 py-20 lg:grid-cols-2 lg:py-28">
            <div>
              <p className="text-sm font-medium text-accent">For fintech engineering teams with a PCI DSS assessment</p>
              <h1 className="mt-4 text-4xl font-bold tracking-tight text-balance sm:text-5xl">
                Show your assessor where the code meets PCI DSS. <span className="gradient-text">Down to the line.</span>
              </h1>
              <p className="mt-6 max-w-xl text-lg text-muted text-pretty">
                The assessor asks where card data is stored, logged, masked and sent. Today an engineer answers in a
                spreadsheet, one requirement at a time. Compliance Sentinel maps each PCI DSS v4.0.1 requirement to your
                repository and checks every pull request for new gaps. Every finding cites the requirement and the exact{" "}
                <code className="font-mono text-foreground">file:line</code>.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <a href={ACTION_DOCS_URL} target="_blank" rel="noreferrer" className={buttonVariants()}>
                  Add the GitHub Action <ArrowRight className="size-4" aria-hidden />
                </a>
                <a href={SAMPLE_REPORT_URL} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "secondary" })}>
                  <FileText className="size-4" aria-hidden /> Sample report
                </a>
              </div>
            </div>

            <SampleFinding />
          </div>
        </section>

        <section id="install" className="scroll-mt-20 border-t border-border bg-surface/40">
          <div className="mx-auto grid max-w-6xl gap-12 px-4 py-20 lg:grid-cols-2">
            <SectionHeading
              eyebrow="Install"
              title="One step in your pull-request workflow"
              description="Add it to a workflow with pull-requests: write permission and an ANTHROPIC_API_KEY secret. Without the key it still runs, using a keyword baseline that checks only a fixed catalogue of controls."
            />
            <pre className="min-w-0 overflow-x-auto rounded-xl border border-border bg-background p-5 font-mono text-sm leading-relaxed">
              <code>{INSTALL_SNIPPET}</code>
            </pre>
          </div>
        </section>

        <section id="how-it-works" className="scroll-mt-20 border-t border-border">
          <div className="mx-auto max-w-6xl px-4 py-20">
            <SectionHeading eyebrow="How it works" title="From a requirement to a cited finding on every pull request" />
            <ol className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {STEPS.map(({ icon: Icon, title, body }, i) => (
                <li key={title}>
                  <Card className="h-full">
                    <div className="flex items-center justify-between">
                      <Icon className="size-5 text-primary-light" aria-hidden />
                      <span className="font-mono text-xs text-muted">0{i + 1}</span>
                    </div>
                    <h3 className="mt-4 font-semibold">{title}</h3>
                    <p className="mt-2 text-sm text-muted">{body}</p>
                  </Card>
                </li>
              ))}
            </ol>
            <p className="mt-8 max-w-3xl text-sm text-muted">
              The hosted app also watches eight regulatory sources each day, including the Federal Register, SEC, FCA,
              EUR-Lex and MAS, and sends a weekly digest of rule changes.
            </p>
          </div>
        </section>

        <section className="border-t border-border bg-surface/40">
          <div className="mx-auto max-w-6xl px-4 py-20">
            <SectionHeading
              eyebrow="Citations you can check"
              title="A finding is only as good as its evidence"
              description="The model proposes; plain code verifies. Anything it cannot back with both the requirement and your source is handed to a person."
            />
            <div className="mt-12 grid gap-4 md:grid-cols-3">
              {GUARANTEES.map(({ icon: Icon, title, body }) => (
                <Card key={title} className="bg-background">
                  <Icon className="size-5 text-accent" aria-hidden />
                  <h3 className="mt-4 font-semibold">{title}</h3>
                  <p className="mt-2 text-sm text-muted">{body}</p>
                </Card>
              ))}
            </div>
          </div>
        </section>

        <section id="results" className="scroll-mt-20 border-t border-border">
          <div className="mx-auto grid max-w-6xl gap-12 px-4 py-20 lg:grid-cols-2">
            <div>
              <SectionHeading
                eyebrow="Results"
                title="Measured with Claude, including the misses"
                description="The demo target is a small Express API with ten planted violations, five of them PCI DSS: a card number in the logs, a stored CVV, card numbers stored in plaintext, card data sent over plain HTTP and a shared admin login."
              />
              <p className="mt-4 text-sm text-muted">
                On real code the picture is weaker. Across three open-source finance apps, 10 of 24 reported violations
                were real on a first-pass review. Most false positives were organisational duties, such as notifying a
                regulator, judged as code. Every finding and label is{" "}
                <a href={REAL_REPOS_URL} target="_blank" rel="noreferrer" className="text-accent underline-offset-4 hover:underline">
                  published
                </a>
                .
              </p>
            </div>
            <div className="grid content-center gap-4 sm:grid-cols-3">
              {EVAL.map((s) => (
                <Card key={s.label} className="text-center">
                  <p className="gradient-text text-4xl font-bold tabular-nums">{s.value}</p>
                  <p className="mt-2 text-sm text-muted">{s.label}</p>
                </Card>
              ))}
            </div>
          </div>
        </section>

        <section className="border-t border-border">
          <div className="mx-auto flex max-w-6xl flex-col items-start gap-6 px-4 py-20 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-2xl font-bold tracking-tight">See the latest audit</h2>
              <p className="mt-2 text-muted">Findings, runs and tracked rules, behind your team&apos;s sign-in.</p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link href="/overview" className={buttonVariants()}>
                Open dashboard <ArrowRight className="size-4" aria-hidden />
              </Link>
              <a href={REPO_URL} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "ghost" })}>
                Source on GitHub
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-8 text-xs text-muted sm:flex-row sm:justify-between">
          <p>
            Decision support, not legal advice or a PCI assessment. Findings do not guarantee compliance or complete
            coverage of any standard. PCI DSS is a standard of the PCI Security Standards Council; this product is not
            affiliated with it.
          </p>
          <p className="shrink-0">Compliance Sentinel by IntelliForge AI</p>
        </div>
      </footer>
    </div>
  );
}

function SectionHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description?: string }) {
  return (
    <div className="max-w-2xl">
      <p className="text-sm font-medium text-accent">{eyebrow}</p>
      <h2 className="mt-2 text-3xl font-bold tracking-tight text-balance">{title}</h2>
      {description && <p className="mt-4 text-muted text-pretty">{description}</p>}
    </div>
  );
}

// A finding from an audit of the bundled demo app (demo-target-app/schema.sql).
function SampleFinding() {
  return (
    <figure className="min-w-0">
      <Card className="shadow-2xl shadow-primary/10">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full bg-danger/15 px-2 py-0.5 font-semibold text-danger">Violation</span>
          <span className="rounded-full bg-danger/15 px-2 py-0.5 font-semibold text-danger">Critical</span>
        </div>
        <p className="mt-4 font-semibold text-pretty">
          Sensitive authentication data, including the card verification code, must not be stored after authorisation,
          even if it is encrypted.
        </p>

        <div className="mt-5 space-y-1 border-l-2 border-primary pl-3 text-sm">
          <p className="text-xs uppercase tracking-wide text-muted">Requirement</p>
          <p>PCI DSS v4.0.1, Requirement 3.3.1</p>
        </div>

        <div className="mt-5 text-sm">
          <p className="text-xs uppercase tracking-wide text-muted">Code evidence</p>
          <p className="mt-1 font-mono text-xs text-accent">schema.sql:49</p>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-background p-3 font-mono text-xs leading-relaxed">
            <code>{"CREATE TABLE payments (\n  ...\n  card_number text NOT NULL,\n  cvv text,"}</code>
          </pre>
        </div>
      </Card>
      <figcaption className="mt-3 text-center text-xs text-muted">From an audit of the bundled demo app.</figcaption>
    </figure>
  );
}
