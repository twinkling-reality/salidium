# Product positioning

Public communication should let a developer understand Salidium before asking them to understand
its architecture or business model.

## Canonical promise

> Visualize your agent's work with diagrams and evidence you can check, not walls of text.

This replaced "Understand what your coding agent did." on 2026-08-20. The reason is recorded rather
than left to be rediscovered: "understand" is a verb a reader has to interpret, and the line named
no artifact, so a stranger could not tell the product from a chat tool or a log tailer. "Diagrams"
is the word that fixes it. It is concrete, it is what the product actually draws, and a survey of
sixty-seven one-line descriptions from comparable repositories found that these lines land when the
output is a familiar object a reader can picture rather than an abstract function.

"Evidence you can check" replaced "plain explanations" on 2026-08-21. That clause named the one
part of a report a model writes, and `SALIDIUM_EXPLAINER=off` removes it: every flow diagram on the
page reads from the explanation, so the promise emptied for anyone who took the advice the
documentation itself gives. The word that stays is "diagrams", because the coverage grid, the check
lanes, the churn bars, the session flow and the timeline are drawn whether or not a model is ever
called. Why and How are the explainer's diagrams and they are the top of a report rather than the
whole of it, which is what [Explanations](https://salidium.com/docs/explanations) already says:
most of a report is what Salidium observed, and one part of it is prose. Evidence is the panel that
holds the working behind the verdict, and it is there in either configuration.

The line is also the GitHub repository description verbatim, which is the surface a stranger meets
first.

Salidium turns Claude Code and Codex sessions into a clear, evidence-linked report: what changed,
why, what was verified, and what it flagged for a human.

"What it flagged for a human" replaced "what needs you" on 2026-08-20. "Needs you" is the label on
the sessions list and it is right there: a heading with a count beside it, read by someone already
looking at the product. Lifted into a sentence it becomes a noun phrase nobody says out loud, and a
reader who has never seen the group stops on it. The replacement is not new wording. It is the
product's own gloss of the same bucket, from the tooltip on the review badge in
`packages/ui/src/components/Report.tsx`, which is where the product already had to explain the
label to a person. The label itself is unchanged.

Use this promise consistently in the README, website hero, npm description, GitHub description, and
social metadata. Channel constraints may change the grammar, but not the product claim.

Recommended short description for npm, GitHub, and social metadata:

> Turn Claude Code and Codex sessions into a clear, evidence-linked report: what changed, why,
> what was verified, and what it flagged for a human.

## Communication order

Lead public entry points in this order:

1. The problem: coding-agent sessions are verbose and difficult to audit quickly.
2. The outcome: a clear report of changes, reasons, verification, and human attention,
   updating while the agent is still working rather than only once it has stopped.
3. The trial: `npx salidium`.
4. The trust model: MIT-licensed, open source, local-first, raw transcripts local, no Salidium
   telemetry.
5. Technical architecture and the hosted-service boundary through deeper links.

## Accurate trust language

Say that the complete account-free local product is open source and runs without the hosted
service. Say that raw transcripts remain local by default and Salidium has no telemetry. Also state
that optional generated explanations send a bounded, locally redacted excerpt through the user's
installed agent CLI, which may contact its provider and consume the user's plan or API allowance.

Do not describe proprietary hosted operations as open source. Describe them plainly as a separate
service for capabilities that inherently require hosted coordination. The detailed contract is in
[Open-source and hosted-service boundary](open-source-boundary.md).

## Claims to avoid

Avoid vague categories such as “agent platform,” inflated intelligence or productivity claims, and
any implication that Salidium independently proves an agent's reported reasoning. Do not lead with
repository structure or commercial terminology. Transport success, report views, and stored memory
counts are not evidence that eventual work improved.
