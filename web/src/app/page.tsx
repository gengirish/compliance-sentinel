import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  BellRing,
  CheckCheck,
  FileText,
  Gauge,
  Landmark,
  Quote,
  Radar,
  ScanSearch,
  ShieldCheck,
} from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: { absolute: "Compliance Sentinel · Regulatory change, audited against your code" },
  description:
    "Watches regulatory portals, extracts what new rules require of software, audits your codebase against them and reports every finding with the regulation section and the exact file:line.",
  robots: { index: true, follow: true },
};

const REPO_URL = "https://github.com/gengirish/compliance-sentinel";
const SAMPLE_REPORT_URL = `${REPO_URL}/blob/main/samples/report-example.pdf`;

const STEPS = [
  {
    icon: Radar,
    title: "Watch",
    body: "Each day it checks the Federal Register API and EUR-Lex. Rule text is hashed, so only new or amended rules go further and a quiet day costs nothing.",
  },
  {
    icon: Landmark,
    title: "Extract obligations",
    body: "Rules are split on article and section headings and embedded. The model lists the duties software must implement, tied to the sections that state them.",
  },
  {
    icon: ScanSearch,
    title: "Audit the code",
    body: "Per obligation, keyword and vector search find evidence in your repository. Each one is judged compliant, a violation, or needing human review.",
  },
  {
    icon: BellRing,
    title: "Report and alert",
    body: "Findings are deduplicated and rendered to a PDF report. A critical violation goes to Slack and email the same morning.",
  },
];

const GUARANTEES = [
  {
    icon: Quote,
    title: "Two citations or no verdict",
    body: "A verdict needs at least one regulation section and one code location. Without both, the only allowed answer is needs review.",
  },
  {
    icon: CheckCheck,
    title: "Citations checked without a model",
    body: "Every cited chunk must belong to the rule and every file:line range must exist in the indexed snapshot. Invented citations are dropped and the verdict is downgraded.",
  },
  {
    icon: Gauge,
    title: "Bounded cost",
    body: "A per-run cost cap, retries with backoff on every step, and graph state checkpointed to Postgres. A failed run leaves its rules queued for the next one.",
  },
];

const EVAL = [
  { value: "5/5", label: "planted violations found" },
  { value: "100%", label: "precision" },
  { value: "0", label: "compliant areas flagged" },
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
            <a href="#how-it-works" className="hover:text-foreground">
              How it works
            </a>
            <a href="#citations" className="hover:text-foreground">
              Citations
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
              <p className="text-sm font-medium text-accent">Regulatory change monitoring for engineering teams</p>
              <h1 className="mt-4 text-4xl font-bold tracking-tight text-balance sm:text-5xl">
                New rules, checked against your code. <span className="gradient-text">Down to the line.</span>
              </h1>
              <p className="mt-6 max-w-xl text-lg text-muted text-pretty">
                Compliance Sentinel watches regulatory portals, works out what each new or amended rule requires of
                software, and audits your repository against it. Every finding cites the regulation section and the
                exact <code className="font-mono text-foreground">file:line</code>.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link href="/overview" className={buttonVariants()}>
                  Open dashboard <ArrowRight className="size-4" aria-hidden />
                </Link>
                <a href={SAMPLE_REPORT_URL} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "secondary" })}>
                  <FileText className="size-4" aria-hidden /> Sample report
                </a>
              </div>
            </div>

            <SampleFinding />
          </div>
        </section>

        <section id="how-it-works" className="scroll-mt-20 border-t border-border">
          <div className="mx-auto max-w-6xl px-4 py-20">
            <SectionHeading eyebrow="How it works" title="From a rule change to a cited finding, every morning" />
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
          </div>
        </section>

        <section id="citations" className="scroll-mt-20 border-t border-border bg-surface/40">
          <div className="mx-auto max-w-6xl px-4 py-20">
            <SectionHeading
              eyebrow="Citations you can check"
              title="A finding is only as good as its evidence"
              description="The model proposes; plain code verifies. Anything it cannot back with both the rule and your source is handed to a person."
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
                title="Tested against an app with planted violations"
                description="The demo target is a small Express API with five planted violations (personal data in logs, no retention job, plaintext secrets, assumed marketing consent, no breach notification) and two areas done correctly."
              />
              <p className="mt-4 text-sm text-muted">
                These figures come from the offline keyword baseline, which proves the pipeline, retrieval and citation
                checks. Figures for the Claude analyst have not been measured yet.
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
          <p>Decision support, not legal advice. Findings do not guarantee compliance or complete coverage of any regulation.</p>
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

// A real finding from samples/report-example.pdf (demo rules against demo-target-app).
function SampleFinding() {
  return (
    <figure className="min-w-0">
      <Card className="shadow-2xl shadow-primary/10">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full bg-danger/15 px-2 py-0.5 font-semibold text-danger">Violation</span>
          <span className="rounded-full bg-danger/15 px-2 py-0.5 font-semibold text-danger">Critical</span>
        </div>
        <p className="mt-4 font-semibold text-pretty">
          Personal data must not be exposed in application logs; logging must be limited to what is necessary.
        </p>

        <div className="mt-5 space-y-1 border-l-2 border-primary pl-3 text-sm">
          <p className="text-xs uppercase tracking-wide text-muted">Regulation</p>
          <p>GDPR Article 5(1)(c), data minimisation</p>
        </div>

        <div className="mt-5 text-sm">
          <p className="text-xs uppercase tracking-wide text-muted">Code evidence</p>
          <p className="mt-1 font-mono text-xs text-accent">src/routes/signup.js:10</p>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-background p-3 font-mono text-xs leading-relaxed">
            <code>console.log(&quot;New signup&quot;, {"{"} email, fullName, dateOfBirth, ssn, phone {"}"});</code>
          </pre>
        </div>
      </Card>
      <figcaption className="mt-3 text-center text-xs text-muted">From the sample report on the bundled demo app.</figcaption>
    </figure>
  );
}
