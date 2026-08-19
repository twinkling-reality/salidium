# Evaluation protocol

This is the preregistered design for the Phase 2 downstream-value gate. It exists now, before there
is anything to evaluate, because a gate written after the results are known is not a gate. Nothing
here has been run.

The claim it is built to test is narrow and falsifiable: **recalling a previously recorded decision
helps a person resume work more accurately than the repository already does, without increasing
incorrect recommendations.** Transport metrics, memory counts, and card impressions are not evidence
for that claim and cannot be substituted for any part of this.

## Unit and design

A unit is one resumption task: a repository snapshot at commit `C`, a decision recorded at least
seven days earlier that materially bears on the task, and a task prompt that never names that
decision.

Tasks are built in pairs matched on difficulty and run as a crossover at task level. Participant `p`
gets task A in the recall arm and task B in the baseline arm; participant `p'` gets the reverse.
Order is counterbalanced. No participant ever sees the same task twice. Analysis is a mixed-effects
logistic model with participant and task-pair random intercepts; the McNemar approximation below is
used only to size the study.

## The baseline arm

The comparison is against what a developer can already do, not against nothing. A tool-less agent is
the developer-written happy path this project has committed to rejecting.

Both arms use the same model, the same agent harness, the same checkout, and the same twenty-minute
wall-clock cap, enforced identically. The baseline arm gets a preregistered, fully command-logged
allowlist:

- `rg` and `grep` over the worktree
- `git log --oneline`, `git log -S`, `git log --follow`, `git blame`, `git show`
- reading `docs/**`, `docs/decisions/**`, `README`, `CHANGELOG`
- a static export of issue and pull-request text

## Primary endpoint and size

Accurate resumption, binary, adjudicated by humans.

Assume a baseline accuracy of 0.55 and a target of 0.75, so the effect is 0.20. Assume discordant
proportions of 0.05 (baseline right, recall wrong) and 0.25 (recall right, baseline wrong), giving a
discordant total of 0.30. McNemar at two-sided alpha 0.05 and power 0.80 needs 57 pairs.

That number assumes every task produces a recall. It will not. If the system correctly abstains on
40% of eligible tasks, those pairs are forced concordant, the observable effect falls to 0.12 and the
discordant total to 0.18, which needs 96 pairs. Inflating by a design effect of 1.2 for imperfect
task matching and by 10% for adjudication voids gives 128.

**Preregister 130 pairs, 260 task runs.** The gate passes only if the lower bound of the 95%
confidence interval on the paired difference is above zero.

## No-recall cases are in the denominator

Freeze the eligible-resumption list before the first run and commit its SHA-256, together with the
analysis plan, into the repository. Every listed task counts whether or not a card appears.
Abstention is scored as the recall arm achieving whatever the participant achieved unaided.

Report the abstention rate separately. Accuracy conditional on a card having appeared may be
reported only as a labelled secondary, never as the gate: conditioning on the system having chosen
to speak is how a retrieval system marks its own homework.

## Co-primary safety endpoint

Incorrect recommendations, tested for non-inferiority.

At 130 pairs with a discordant rate near 0.10, the one-sided 95% upper bound is 0.046, so 0.05
absolute is the smallest margin the study can honestly support. A 0.03 margin needs 300 pairs.
Choose one before collection starts and write the number down.

## Adjudication

Both arms emit a resumption memo in one identical template. A scrubber removes the recall card,
provenance strings, and any lexical tell of the arm before adjudication.

Two independent human adjudicators score the primary endpoint blind; a third breaks ties. Report
Krippendorff's alpha, and preregister that an alpha below 0.70 voids the endpoint and forces rubric
revision before any further collection. Adjudicators also guess which arm they scored; if guess
accuracy exceeds 60%, blinding is declared broken and reported as such.

A model judge may pre-screen and flag disagreements. It never casts a vote. Its agreement with human
consensus is reported separately as a calibration statistic.

## Stratification

Stratify by age (under 7 days, 7 to 90 days, over 90 days), project, source availability (raw local
evidence present or absent), conflict present, outcome attached, and device (origin or second).

At 130 pairs these are descriptive. Preregister exactly one powered subgroup: source-unavailable at
40 pairs, tested for non-inferiority rather than superiority.

## What this study cannot do

With 260 runs and zero observed violations, the rule of three puts the 95% upper bound on
cross-scope leaks, a rejected alternative rendering as the selected one, and serving superseded,
deleted, revoked, or expired items at 1.15%.

That is not a safety guarantee. Those properties must be proven to zero by adversarial construction
against the ship matrix in [the threat model](threat-model.md), and this protocol is preregistered
as incapable of substituting for them. A field study that observes no leak in 260 tries has not
shown that leaks are rare.

## Secondary endpoints

- repeated investigations, counted as re-derivations of an already-recorded fact
- time to verified progress, by Wilcoxon signed-rank on paired medians, where verified progress is a
  preregistered observable such as a passing test or a reviewer-confirmed next step
- harmful recall rate
- contradiction-visibility rate
- abstention appropriateness: of the no-recall cases, the fraction where a human judges that showing
  a card would have been wrong
