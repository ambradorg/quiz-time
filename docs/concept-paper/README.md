# QuizTime — Concept Paper & Presentation

Academic documentation for the QuizTime project: a concept paper, a defense
deck, the figures used in both, and the small toolchain that regenerates them.

| File | What it is |
| --- | --- |
| `QuizTime-Concept-Paper.docx` | The concept paper (14 sections + references + appendices), cover page, contents page and page numbers |
| `QuizTime-Concept-Paper.md` | The paper's source text — edit this, then rebuild the `.docx` |
| `QuizTime-Concept-Presentation.pptx` | 15-slide defense deck with **speaker notes on every slide** |
| `figures/` | The six diagrams used in the paper and the deck (PNG, transparent of nothing, ready to paste into either) |
| `tools/` | Node scripts that regenerate the `.docx`, the `.pptx` and the figures |

## The paper at a glance

Title: *QuizTime: An AI-Assisted Flashcard and Quiz Generator for Active Recall
and Spaced Repetition Study*.

The paper frames the project as **design-and-development research**: a rationale
grounded in the testing effect and distributed practice, objectives, scope and
delimitation, a review of related literature, an Input–Process–Output conceptual
framework, the methodology (architecture, data model, tooling, testing plan),
the proposed system's features, a 24-week work plan, a budget, and the expected
outcomes.

## The deck at a glance

15 slides, roughly 12–14 minutes with the notes:

1. Title
2. The problem
3. The opportunity
4. Objectives of the study
5. Conceptual framework
6. How it works
7. Four ways to be tested
8. Spaced repetition
9. Works with no signal
10. System architecture
11. Scope and delimitation
12. Methodology and work plan
13. Testing and evaluation
14. Significance and cost
15. Closing

Press **F6** (or View → Notes) in PowerPoint to read the speaker notes while you
present; each one has a suggested time budget and the point a panelist is most
likely to probe.

## Rebuilding

```bash
cd docs/concept-paper/tools
npm install
npm run build      # figures → .docx → .pptx
npm run qa         # renders every slide to a PNG and flags layout overflow
```

`npm run build` writes the `.docx` and `.pptx` next to this README and the
figures into `figures/`. Intermediate PNGs live in the system temp directory, so
nothing large lands in the repository.

| Script | Does |
| --- | --- |
| `diagrams.js` | Draws the six diagrams (SVG → PNG via `sharp`) |
| `prep-images.js` | Crops each diagram's own title block, since slides carry their own headings |
| `build-docx.js` | Markdown → Word, with cover page, contents, tables, page numbers |
| `build-pptx.js` | Builds the 16:9 deck, including the notes |
| `qa-render.js` | Parses the finished `.pptx` and re-renders each slide, warning about overflowing or off-slide elements |

The deck pulls the app's own logo and mascot artwork from `public/` and
`public/hamster/`, so it always matches the shipped product.

## Things to fill in

The cover page and slide 1 deliberately carry no school, program, adviser or
section names. Add them where "QuizTime Project Team" appears:

- `QuizTime-Concept-Paper.md` — the line under the title, then rebuild.
- Slide 1 of the deck: edit the text box directly in PowerPoint.

## Number accuracy

Every figure quoted in the paper and the deck was read from the source tree
rather than assumed: the SM-2 constants from `src/lib/srs.ts`, the upload and
text limits from `src/app/api/scan/route.ts` and `src/app/page.tsx`, the scoring
table from `src/app/page.tsx`, and the test counts from running
`npm run test:offline`, `test:failover`, `test:srs`, `test:openrouter` and
`test:scan` (146 checks, all passing) plus a static count of the three suites
that need a database (48 checks), for 194 in total. If you change a constant in
the app, check Appendix B of the paper before presenting.
