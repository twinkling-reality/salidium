# ADR 0006: Cognitive and perceptual architecture for the adaptive session canvas

- Status: accepted and implemented
- Date: 2026-11-02

## Context

Salidium helps a human supervisor understand what an autonomous coding agent did during a session,
how the touched files connect to the rest of the repository, and what remains unverified or at risk
of breaking.

Early iterations of the session diagram exposed compiler and AST mechanics directly on the canvas:

1. **Cloned nodes across columns and panels**: A single modified file (such as `SessionCanvas.tsx`
   or `SessionView.tsx`) appeared up to three times simultaneously (in a top `Edited Files` card,
   again in the center column of a bottom `Connected Files` diagram, and cloned a third time into
   an upstream or downstream column with an `Also Edited` badge when two edited files imported one
   another).
2. **Syntactic line-number badges on curves**: Bezier curves between columns carried opaque pill
   badges (`L35`, `L17`, `L14`, `L2`, `L1`) showing the line number of the `import` statement inside
   the source file.
3. **False ordinal numbering (`1. / 2. / 3. / 4.`)**: Numbering the top three summary cards `1, 2, 3`
   and the structural dependency map `4` implied a four-step chronological sequence when panel `4`
   was actually a spatial zoom into panel `2`.
4. **Right-to-left import arrows in a left-to-right layout**: Tracing AST `import` pointer direction
   caused arrows to point right-to-left (`Edited Files <-- Dependents`), fighting the human eye's
   left-to-right causal reading order.
5. **Static column labels and empty boxes**: Hardcoded metaphor headers (such as `Built On` or
   `Density / Layers`) and rigid 3-column templates forced users to decode tool-specific jargon.

To ground Salidium's visual architecture in how people actually perceive, forage, and build mental
models of complex autonomous work, we conducted a multi-disciplinary research synthesis across five
overlapping cognitive and human-factors domains.

---

## Research Foundation Across Five Overlapping Domains

### 1. Visual Indexing, Object Permanence, and Working Memory Bounds

- **FINST Visual Indexing Theory (Pylyshyn, 1989, 2001)**: Pre-attentive human vision maintains
  approximately 4 to 5 spatial pointers (*FINSTs*, or Fingers of Instantiation) that bind one
  conceptual object to one spatial locus. Cloning a single file node into multiple columns breaks
  1:1 spatial object permanence and forces conscious serial search to deduplicate the graph.
- **Working Memory Capacity (Cowan, 2001)**: Human working memory holds $4 \pm 1$ chunks at once.
  When a 2-file coupled edit is rendered as 4 separate cards across 3 columns, working memory slots
  are exhausted just reconciling that two cards name the same file.
- **Split-Attention Effect and Spatial Contiguity (Sweller, 1988; Chandler & Sweller, 1991, 1992;
  Mayer, 2009)**: Separating mutually referring representations of the same files into a top
  `Edited Files` box and a bottom `Connected Files` box creates extraneous cognitive load as the
  viewer executes saccades to reconcile counts (`4 files` vs. `3 files` when a stylesheet has no TS
  imports) and diff metrics (`+184 -22`).

### 2. Gestalt Perception, Uniform Connectedness, and Graph Aesthetics

- **Uniform Connectedness and Good Continuation (Palmer & Rock, 1994; Ware, 2021)**: A continuous
  contour (an edge) is the primary entry-level perceptual unit the visual cortex uses to group
  related nodes. Placing opaque pill boxes (`L35`, `L17`) at the midpoint of the inter-column
  gutter occludes the curves right at their inflection and crossing points, breaking contour
  continuity.
- **Graph Drawing Aesthetics and Crossing Minimization (Purchase, 1997, 2002; Sugiyama et al.,
  1981)**: Path-tracing error and latency rise sharply with edge crossings and acute convergence
  angles. Sorting upstream and downstream nodes by the vertical barycenter (average row index) of
  their connected edited files eliminates unnecessary diagonal crossings.
- **Data-Ink Ratio and Preattentive Salience (Tufte, 1983; Treisman & Gelade, 1980)**: High-contrast
  alphanumeric pills in the gutter trigger preattentive pop-out, drawing foveal fixation to the
  least useful fact in a session review (which line number at the top of a file holds an `import`
  keyword).

### 3. Program Comprehension and Information Foraging Theory

- **Questions Programmers Ask During Software Evolution (Sillito, Murphy, & De Volder, 2008;
  LaToza & Myers, 2010; Storey et al., 1999)**: Reviewers build mental models through four
  progressive questions:
  1. *What was the agent trying to accomplish and what did it touch?* (Scope)
  2. *How do the edited files fit together as a unit?* (Internal coherence of the change set)
  3. *What unedited callers or packages depend on the modified code and might break?* (Reachability
     and blast radius)
  4. *Did automated checks run and verify the affected surface?* (Verification closure)
- **Information Foraging Theory and Information Scent (Pirolli & Card, 1999; Lawrance et al., 2013;
  Fleming et al., 2013)**: Developers navigate visual containers (*patches*) guided by proximal
  cues (*information scent*). Labels like `L35`, `pkg`, or vague metaphors like `Built On` carry
  weak or misleading scent; concrete, data-derived labels (`Imports (4) · 2 files · 2 pkgs`,
  `Edited Files (4) · 1 Linked Edit`, `Dependents & Tests (4) · 2 Unedited Callers`) allow instant
  prediction of patch contents.
- **Single-Node Identity in Spatial Code Canvases (Bragdon et al., *Code Bubbles*, ICSE 2010;
  DeLine et al., *Debugger Canvas*, ICSE 2012)**: In a dependency graph of a change set, every file
  must map 1-to-1 to a single visual card ($|V_{\text{visual}}| = |V_{\text{entity}}|$), and
  columns must form a strict mathematical set partition ($U \cap E = \emptyset$ and
  $E \cap D = \emptyset$).

### 4. Supervisory Control and Situation Awareness in Autonomous Systems

- **Three-Level Situation Awareness (Endsley, 1995; Endsley & Kiris, 1995)** and **Trust Calibration
  in Automation (Lee & See, 2004: Purpose, Process, Performance)**:
  - *Level 1 (Perception)*: Single canonical inventory of agent, tools used, and edited files.
  - *Level 2 (Comprehension)*: How edited files couple to one another (`↳ uses SessionCanvas.tsx` /
    `↑ used by SessionView.tsx`) and what external foundations they import.
  - *Level 3 (Projection)*: Which downstream callers remain unedited (`Unedited Caller`, amber
    risk signal) versus which downstream consumers are verification test suites (`Test Suite`).

### 5. Causal Models, Teleological Explanation, and Cartographic Generalization

- **Causal DAGs and Narrative Episode Structure (Sloman, 2005; Pennington & Hastie, 1986, 1992)**:
  Humans simulate causality forward from inputs to intervention to downstream ripple (`Imports` ->
  `Edited Files` -> `Dependents & Tests`). Reversing AST `import` arrows so visual curves flow
  left-to-right aligns the diagram with human causal simulation.
- **Teleological vs. Mechanistic Explanation (Lombrozo, 2006, 2012)**: Humans seek functional roles
  (`Test Suite`, `Unedited Caller`, `Package`, `↳ uses SessionCanvas.tsx`) rather than mechanistic
  parser coordinates (`ts-relative · L17`), which belong in `Full` detail mode or hover tooltips.
- **Degree-of-Interest and Visual Momentum (Furnas, 1986; Woods, 1984; Shneiderman, 1996; Beck,
  1933)**: Progressive disclosure across `Detail: Summary | Standard | Full` expands the same
  mental model without introducing competing duplicate inventories.

---

## Decision: Architectural Invariants for Salidium's Session Canvas

Every diagram view rendered by `@salidium/ui` (`packages/ui/src/components/canvas/`:
`SessionCanvas.tsx`, `SystemArchitectureLens.tsx`, `ProjectMapTopologySection.tsx`,
`ExecutionSequenceLens.tsx`, `VerificationMatrixLens.tsx`, `NarrativeLens.tsx`, and
`CanvasDesignInspector.tsx`) and composed by `@salidium/core` (`composeCanvasSpec.ts` under
`salidium.canvas-spec/v1`) must obey seven invariants:

1. **Strict 1:1 Spatial Node Identity ($U \cap E = \emptyset, E \cap D = \emptyset$)**:
   - Every file modified in the session lives **exclusively** in the `Edited Files` column,
     including non-TypeScript files (such as `.css` or config files) and per-file diff deltas
     (`+linesAdded -linesRemoved`).
   - An edited file is never cloned into `Imports` or `Dependents & Tests`.
   - Dependencies between two edited files are rendered as internal co-edit links inside `Edited
     Files` (`↳ uses <file>` / `↑ used by <file>`) and co-highlighted on hover.
2. **Zero Duplicate File Inventories**:
   - When the `Code Map & Impact` topology is displayed (`Detail: Standard` or `Full`), the top
     overview row compacts to `Agent & Tools` and `Checks & Review` so `Edited Files` is rendered
     once on screen.
   - When `Detail: Summary` is selected (or when no project map is available), the 3-card summary
     ribbon (`Agent & Tools` -> `Edited Files` -> `Checks & Review`) is shown.
3. **Unobstructed Left-to-Right Causal Curves with Barycenter Ordering**:
   - Static curves never carry `L##` import line-number pills.
   - Curves flow left-to-right (`Imports` -> `Edited Files` -> `Dependents & Tests`).
   - Upstream and downstream nodes are sorted by the vertical barycenter of the `Edited Files` rows
     they connect to, minimizing curve crossings.
4. **Data-Driven Dynamic Column Layout and Naming**:
   - Columns and their headings are generated dynamically from the session's observed dependency
     graph:
     - Left column (rendered only when unedited upstream nodes exist): `Imported Files (N)`,
       `Imported Packages (N)`, or `Imports (N)` with dynamic file/package counts.
     - Center column: `Edited File (1)` or `Edited Files (N)`.
     - Right column (rendered only when unedited downstream nodes exist): `Related Tests (N)`,
       `Dependents (N)`, or `Dependents & Tests (N)` with an explicit `Unedited Callers` risk badge.
   - Empty upstream or downstream columns collapse automatically (3-column, 2-column, or 1-column
     grid) rather than rendering empty placeholder boxes.
5. **Two Top-Level Cognitive Controls (`View` and `Detail`) plus Personal Visual Control (`Customize`)**:
   - `View`: `Overview` · `Steps` · `Why & How`.
   - `Detail`: `Summary` · `Standard` · `Full` (exposing parser resolver rules like
     `ts-relative · L17` only in `Full` mode).
   - `Customize`: `CanvasDesignInspector` backed by `salidium.canvas-style/v1`.
6. **Verified Reference Binding (`collectValidCanvasRefs`)**:
   - Every `salidium.canvas-spec/v1` block binds to observed session telemetry or `@salidium/project-map`
     IDs (`file:`, `call:`, `edge:`, `subagent:`, `turn:`). Unverified references are stripped
     deterministically before rendering.
7. **Perceptual Contrast Guardrails (`salidium.canvas-style/v1`)**:
   - `packages/ui/src/lib/visualPresets.ts` (`canvasStyleToInlineVars`) enforces mathematical
     perceptual contrast across all three elevation tiers (Tier 0 Canvas Backdrop -> Tier 1 Section
     Container `.sys-tier`/`.sys-topology-col` -> Tier 2 Inner Node Card `.dep-node-card`/`.sys-card`):
     - Minimum OKLab lightness separation ($\Delta L \ge 0.045$) between adjacent surface tiers.
     - Minimum WCAG relative luminance contrast of $\ge 4.6:1$ for primary text and $\ge 3.1:1$ for
       muted labels against both backdrop and card surfaces.
     - Minimum visible hairline border width ($\ge 0.75\text{px}$) and border contrast against card
       and backdrop surfaces so zero-contrast white-on-white or dark-on-dark states cannot occur.

---

## References

1. Beck, H. (1933). London Underground schematic diagram.
2. Bragdon, A., Reiss, S. P., Zeleznik, R., Karumuri, S., Wahlig, W., Kaplan, J., et al. (2010).
   Code Bubbles: Rethinking the user interface paradigm of integrated development environments.
   *ICSE 2010*, 455-464.
3. Chandler, P., & Sweller, J. (1991). Cognitive load theory and the format of instruction.
   *Cognition and Instruction*, 8(4), 293-332.
4. Cowan, N. (2001). The magical number 4 in short-term memory: A reconsideration of mental storage
   capacity. *Behavioral and Brain Sciences*, 24(1), 87-114.
5. DeLine, R., Bragdon, A., Burnett, M., et al. (2012). Debugger Canvas: Industrial experience with
   the Code Bubbles paradigm. *ICSE 2012*, 1064-1073.
6. Endsley, M. R. (1995). Toward a theory of situation awareness in dynamic systems. *Human
   Factors*, 37(1), 32-64.
7. Furnas, G. W. (1986). Generalized fisheye views. *CHI 1986*, 16-23.
8. LaToza, T. D., & Myers, B. A. (2010). Hard-to-answer questions about code. *PLATEAU 2010*.
9. Lawrance, J., Bogart, C., Burnett, M., Bellamy, R., Rector, K., & Fleming, S. D. (2013). How
   programmers debug, revisited: An information foraging theory perspective. *IEEE TSE*, 39(2),
   197-215.
10. Lee, J. D., & See, K. A. (2004). Trust in automation: Designing for appropriate reliance.
    *Human Factors*, 46(1), 50-80.
11. Lombrozo, T. (2006). The structure and function of explanations. *Trends in Cognitive Sciences*,
    10(10), 464-470.
12. Palmer, S., & Rock, I. (1994). Rethinking perceptual organization: The role of uniform
    connectedness. *Psychonomic Bulletin & Review*, 1(1), 29-55.
13. Pennington, N., & Hastie, R. (1986). Evidence evaluation in complex decision making. *Journal
    of Personality and Social Psychology*, 51(2), 242-258.
14. Pirolli, P., & Card, S. (1999). Information foraging. *Psychological Review*, 106(4), 643-675.
15. Purchase, H. C. (1997). Which aesthetic has the greatest effect on human understanding?
    *Graph Drawing (GD 1997)*, 248-261.
16. Pylyshyn, Z. W. (1989). The role of location indexes in spatial perception: A sketch of the
    FINST spatial-index model. *Cognition*, 32(1), 65-97.
17. Shneiderman, B. (1996). The eyes have it: A task by data type taxonomy for information
    visualizations. *IEEE Symposium on Visual Languages*, 336-343.
18. Sillito, J., Murphy, G. C., & De Volder, K. (2008). Asking and answering questions during a
    programming change task. *IEEE TSE*, 34(4), 434-451.
19. Sloman, S. (2005). *Causal Models: How People Think About the World and Its Alternatives*.
    Oxford University Press.
20. Storey, M.-A. D., Fracchia, F. D., & Müller, H. A. (1999). Cognitive design elements to support
    the construction of a mental model during software exploration. *Journal of Systems and
    Software*, 44(3), 171-185.
21. Sugiyama, K., Tagawa, S., & Toda, M. (1981). Methods for visual understanding of hierarchical
    system structures. *IEEE Transactions on Systems, Man, and Cybernetics*, 11(2), 109-125.
22. Tufte, E. R. (1983). *The Visual Display of Quantitative Information*. Graphics Press.
23. Ware, C. (2021). *Information Visualization: Perception for Design* (4th ed.). Morgan Kaufmann.
24. Woods, D. D. (1984). Visual momentum: A concept to improve the cognitive coupling of person and
    computer. *International Journal of Man-Machine Studies*, 21(3), 229-244.
