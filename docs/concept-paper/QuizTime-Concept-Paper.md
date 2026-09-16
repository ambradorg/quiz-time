# QuizTime: An AI-Assisted Flashcard and Quiz Generator for Active Recall and Spaced Repetition Study

**A Concept Paper**

Proposed by the QuizTime Project Team

<!-- pagebreak -->

## Abstract

Students spend hours re-reading handouts, lecture slides, and photographed
whiteboards, yet rereading is one of the least effective study techniques
identified in the learning-science literature. Retrieval practice (self-testing)
and distributed practice (spacing) consistently outperform it, but both demand
a resource students rarely have in abundance: time to build and schedule review
materials by hand. QuizTime is a proposed web-based, installable study
application that closes that gap. A learner uploads up to eight files (PDF,
Word, PowerPoint, or photographs of printed material) or pastes up to 100,000
characters of text; the system sends the material to a large language model and
returns a single editable study set of 8–20 flashcards, each with a question,
an answer, a hint, and a difficulty rating. The learner then answers those cards
in four modes — Study (self-checked flashcards), Exam (multiple choice),
Identification (typed recall with spelling-tolerant checking), and Enumeration
(list recall) — and the system records every outcome as a right/wrong result.
A spaced-repetition engine built on an SM-2 descendant schedules each card with
a due date, so a daily Review queue surfaces only what the learner is about to
forget. Because many learners study on commutes and in places with unreliable
connectivity, QuizTime is also an offline-first Progressive Web App: decks,
progress, and even the review queue work with no signal, and answers recorded
offline are replayed automatically when the connection returns. This paper
presents the rationale, objectives, scope, conceptual framework, methodology,
work plan, and expected outcomes of the project.

<!-- pagebreak -->

## Chapter 1 — Introduction and Rationale

### 1.1 Background of the Study

The typical Filipino learner's study materials are already digital. Lecture
slides arrive as PDFs or PowerPoint files, handouts are photographed with a
phone, reviewers are shared as Word documents, and notes are pasted into
messaging apps. The bottleneck is no longer *access* to information; it is the
*average learner's ability to convert that information into durable memory*
inside a limited study window.

Learning-science research is unusually clear about which techniques work.
Dunlosky et al. (2013) rated ten common study techniques by utility and found
that the strategies students use most — rereading, highlighting, and summarizing
— rank low, while practice testing (self-quizzing) and distributed practice
(spacing) rank highest. Roediger and Karpicke (2006) demonstrated that students
who were tested on material retained significantly more of it a week later than
students who spent the same amount of time rereading it, despite the rereading
group feeling more confident. The obstacle is practical: building a good deck of
flashcards for a 40-page lecture is tedious, and manually scheduling when to
review each card — the very mechanism that produces the spacing effect — is
tedious enough that almost nobody does it.

Two technologies have matured at the right moment to remove that friction.
First, generative artificial intelligence is now able to read a document or a
photograph and identify its key concepts, definitions, and enumerations.
Second, the Progressive Web App model allows a phone browser to install a
web application and cache its data, so a study session does not have to depend
on a signal.

QuizTime combines them: an AI-assisted deck builder on the front end of the
study cycle, and a spaced-repetition scheduler on the back end of it, delivered
as an application that keeps working with or without the network.

### 1.2 Statement of the Problem

Students possess large volumes of digital learning material but lack the time,
structure, and tools to convert it into retrieval practice and to review it on a
schedule that defeats the forgetting curve. Existing flashcard applications
either require learners to author every card manually, charge a subscription for
AI-assisted generation, or assume an always-on connection. Consequently, the
most effective study techniques remain the least used.

### 1.3 Purpose of the Study

This concept paper proposes the design, development, and evaluation of
**QuizTime**, a web-based, installable study application that (a) converts
uploaded or pasted learning material into editable flashcard study sets with the
help of large language models, (b) drills those cards through four complementary
study modes with scoring and feedback, (c) schedules each card with a spaced-
repetition algorithm and presents a daily review queue, and (d) keeps the entire
study experience — including the review queue — functional offline.

<!-- pagebreak -->

## Chapter 2 — Objectives of the Study

### 2.1 General Objective

To design and develop QuizTime, an AI-assisted, offline-capable flashcard and
quiz generator that turns a learner's own documents into active-recall practice,
and to evaluate its functionality, reliability, and acceptability as a study
tool.

### 2.2 Specific Objectives

1. **To develop an AI-assisted generation pipeline** that accepts up to eight
   uploaded files (PDF, DOCX, PPTX, JPG, PNG, WEBP, HEIC) or up to 100,000
   characters of pasted text and produces one study set of 8–20 flashcards, each
   with a question, a complete answer, an optional hint, and a difficulty rating.
2. **To implement four study modes** — Study (flip-and-self-check), Exam
   (four-option multiple choice), Identification (typed recall with
   case-, punctuation-, and typo-tolerant checking), and Enumeration (recall of
   list-type answers with per-item feedback) — with points, accuracy, letter
   grades, streaks, and an end-of-session breakdown of missed items.
3. **To implement a spaced-repetition scheduler** based on an SM-2 descendant
   that grades each card Again / Hard / Good / Easy, computes its next due date,
   clamps intervals to a pedagogically sane range, and presents a daily Review
   queue that prioritizes overdue cards and limits new cards to twenty per day.
4. **To provide progress analytics** — overall statistics, per-deck mastery and
   accuracy, a daily study streak, spaced-repetition health indicators, and a
   recent-activity feed — persisted per account in a relational database.
5. **To deliver an offline-first experience** through a service worker and
   client-side snapshots so that decks, all study modes, the review queue, and
   progress tracking continue to work without a connection, with locally
   recorded answers automatically synchronized afterwards.
6. **To design the system for content reliability and service continuity**, so
   that generation survives a single AI model or provider being rate-limited,
   unavailable, or unable to read a particular file type, and so that all
   learners' data remain isolated behind authenticated accounts.
7. **To validate the system** through automated unit, integration, and
   end-to-end tests, and to determine the level of acceptability of the proposed
   system among students and instructors using a standard software-quality
   evaluation instrument.

<!-- pagebreak -->

## Chapter 3 — Scope and Delimitation

### 3.1 Scope

The proposed system covers the following:

| Area | Included |
| --- | --- |
| Platform | Responsive web application (desktop and mobile browsers) installable as a Progressive Web App |
| Input material | Up to 8 files per study set — PDF, DOCX, PPTX, JPG, PNG, WEBP, HEIC/HEIF — or up to 100,000 characters of pasted text; both may be combined into one set |
| Generation | 8–20 AI-written flashcards per set with question, answer, hint, and difficulty; a descriptive title and a one-to-two sentence summary |
| Generation resilience | Automatic failover across a chain of AI models and two providers (Google Gemini, OpenRouter) with cooldown memory, user-facing notice, and a clear error when every model is exhausted |
| Study modes | Study, Exam, Identification, Enumeration |
| Spaced repetition | Four-button SM-2 descendant grading, per-card schedule, daily Review queue with deck filter and daily new-card cap |
| Deck management | Manual deck creation, rename, and full card create/edit/delete/reorder that preserves existing study progress |
| Progress tracking | Overall and per-deck statistics, streak, spaced-repetition rollup, and recent activity, tied to the signed-in account |
| Offline operation | Cached application shell, per-account deck/card/schedule snapshots, a queued outbox for answers and progress, and background replay when the connection returns |
| Accounts and security | Google sign-in (OAuth 2.0 / Auth.js), per-user data isolation on every read and write, and cascade deletion of a user's data |
| Operations | Health check endpoint, per-user rate limiting of the AI endpoint, and a maintenance mode that can be toggled without rebuilding |

### 3.2 Delimitation

The following are explicitly **outside** the scope of the project:

1. **QuizTime is not a learning management system.** It does not maintain class
   rosters, sections, gradebooks, or teacher dashboards, and it does not enforce
   academic-integrity policies beyond authenticating the learner.
2. **No teacher-side analytics or content moderation console.** Statistics are
   personal to the signed-in learner.
3. **No real-time collaboration, sharing, or social features.** Study sets are
   private to their owner; there are no public decks, comments, or leaderboards.
4. **No handwriting or image-only scanning.** Photographs must contain printed
   or legibly rendered text. The system does not perform optical character
   recognition on cursive handwriting, and scanned PDFs without a text layer are
   rejected with an explanatory message rather than silently generating poor
   cards.
5. **No automated evaluation of free-form or essay answers.** Identification
   checking is string-based (case-, punctuation-, and small-typo-tolerant, with
   `/`-separated alternatives); it cannot judge the semantic correctness of a
   paragraph.
6. **AI output is treated as a draft, not an authority.** Generated cards are
   editable precisely because a language model can misread a source; the learner
   remains responsible for verifying content before relying on it.
7. **No native mobile application, desktop installer, payment module, or
   institutional single sign-on** in this version. Offline capability is
   delivered through the PWA, and access is free at the point of use.
8. **Non-deterministic AI generation.** Because generation depends on external
   model providers, identical inputs may produce slightly different sets, and
   the system's availability is bounded by the API quotas available to the
   project.

<!-- pagebreak -->

## Chapter 4 — Significance of the Study

**To students and learners.** QuizTime removes the two largest costs of
effective studying — authoring materials and scheduling reviews. A learner
photographs a handout before an exam, receives a working deck in under a minute,
and is told exactly which cards to review today.

**To teachers and instructors.** The system offers a low-effort way to convert
existing course materials into practice material that students can study
independently. It complements classroom instruction rather than replacing it,
and it reduces the time spent preparing supplementary review sheets.

**To self-learners and professional reviewers.** Board-examination reviewees,
online-course takers, and professionals studying for certifications accumulate
material from many sources. Because a single study set can combine eight files,
QuizTime lets them consolidate a topic's worth of sources into one deck and let
the scheduler decide what needs attention.

**To learners with limited connectivity.** The offline-first design extends
spaced repetition to shared-computer laboratories, dormitories with unstable
Wi-Fi, commutes, and areas where mobile data is expensive. Progress is queued
locally and synchronized later rather than lost.

**To the institution.** The project demonstrates a reproducible model for
integrating generative AI and learning-science evidence into a student-facing
tool, with documented performance, reliability, and data-protection practices
that can inform institutional guidelines on AI use.

**To future researchers and developers.** The system is accompanied by
documented, tested, reusable components — the failover engine, the pure
spaced-repetition scheduler, the offline core, and the service-worker contract —
that can be extended or re-examined in later studies, including controlled
comparisons of AI-generated versus student-authored flashcards.

<!-- pagebreak -->

## Chapter 5 — Review of Related Literature

### 5.1 Retrieval Practice and the Testing Effect

The testing effect refers to the finding that retrieving information from memory
strengthens that memory more than restudying it does. Roediger and Karpicke
(2006) had participants either reread a passage or take a recall test on it, and
found that the tested group remembered significantly more one week later.
Karpicke and Blunt (2011) extended the result by showing that retrieval practice
outperformed elaborative studying with concept mapping. Crucially, learners tend
to *prefer* rereading because it feels fluent, which means an effective study
tool must make retrieval the path of least resistance — the design premise of
QuizTime's four practice modes.

### 5.2 Distributed Practice and the Forgetting Curve

Ebbinghaus (1885/1913) documented that memory decays rapidly at first and then
more slowly, implying that reviews should be concentrated early and spread out
later. Cepeda et al. (2006) synthesized hundreds of experiments and confirmed
that spaced repetitions produce markedly better retention than massed ones.
Wozniak and Gorzelanczyk (1994) operationalized this with the SM-2 algorithm,
which adjusts each item's review interval using an "ease factor" that grows when
the item is recalled easily and shrinks when it is forgotten. Modern
implementations such as Anki replace SM-2's binary quality scale with four
grading buttons (Again, Hard, Good, Easy). QuizTime adopts this four-button
descendant, including a minutes-long learning phase for new cards, lapse
relearning, interval clamping to one year, and an ease factor clamped between
1.3 and 2.8.

### 5.3 Cognitive Load, Multimedia, and Interface Design

Sweller's (1988) cognitive load theory holds that instruction competes for a
limited working memory, and Mayer's (2009) multimedia principles recommend
concise text, coherent signalling, and the avoidance of extraneous load. Paivio's
(1986) dual-coding theory adds that pairing verbal content with complementary
visual cues aids recall. These findings motivate QuizTime's design decisions:
one question per screen, prominent correct/incorrect feedback, colour-coded
difficulty, a mascot and celebratory states used sparingly as feedback rather
than decoration, and answer previews on the grading buttons ("Good · 3 days")
so that the learner is not asked to make an uninformed decision.

### 5.4 Generative AI in Education

Recent reviews of large language models in education report substantial
opportunities — personalized practice, summarization, question generation — and
comparable risks, including factual hallucination, bias, and over-reliance
(Zawacki-Richter et al., 2019; Kasneci et al., 2023). The literature's recurring
recommendation is human oversight: AI should draft, and the learner should
review. QuizTime is designed around that recommendation. Generated cards are
immediately editable, difficult cards can be corrected or removed, and the
system never asserts that a generated answer is verified truth.

### 5.5 Synthesis and the Research Gap

The evidence base for retrieval practice and spaced repetition is strong and
mature, and the tooling for spaced repetition is likewise mature. What remains
scarce, particularly in the local context, is a study tool that joins the two
with (a) no-cost AI-assisted material preparation from the student's *own*
materials, (b) study modes that make retrieval the default interaction, and
(c) an offline-first architecture suited to intermittent connectivity. QuizTime
is proposed to address that combination, and its evaluation is framed around
whether the resulting system is functional, reliable, and acceptable to its
intended users.

<!-- pagebreak -->

## Chapter 6 — Conceptual Framework

The study follows the Input–Process–Output (IPO) model.

### 6.1 Input

- The learner's own material: PDFs, Word documents, PowerPoint decks, camera
  photographs, and pasted text.
- The learner's account: Google identity, profile, and study history.
- Recorded outcomes: every right/wrong answer, the mode that produced it, and
  the timestamp.
- Scheduling state: ease factor, interval, repetitions, lapses, learning step,
  and due date per card.
- System configuration: AI provider credentials, model order, rate limits, and
  maintenance flag.

### 6.2 Process

1. **Ingestion.** Files are validated, images are downscaled in the browser,
   and oversized documents are converted to text client-side (PDF, DOCX, PPTX)
   so that a document larger than the serverless request limit can still be
   processed, in parts if necessary.
2. **Generation.** A structured prompt produces a title, a summary, and 8–20
   cards in strict JSON. The failover engine walks an ordered chain of models;
   a model that is rate-limited, unavailable, or incapable of reading the input
   is skipped (with a cooldown so it is not retried needlessly), and the model
   actually used is reported to the learner.
3. **Curation.** The learner reviews, edits, reorders, adds, or deletes cards
   before or after saving; edits preserve existing progress and schedules.
4. **Practice.** The four study modes present the cards, check the answer
   (exact or fuzzy match, alternative phrasings, or per-item enumeration
   checking), and score the attempt.
5. **Scheduling.** Each graded card is rescheduled by the shared pure scheduler;
   the card's ease, interval, repetitions, and due date are updated.
6. **Persistence and synchronization.** Results and schedules are written to the
   database; when the device is offline they are written to an outbox and
   replayed in order, batched, when connectivity returns.
7. **Analytics.** Aggregation produces overall and per-deck statistics, streaks,
   and spaced-repetition health indicators that feed back to the learner.

### 6.3 Output

- A reusable, editable study set generated from the learner's own material.
- Improved retrieval performance on the learner's own content, evidenced by
  per-card and per-deck accuracy and mastery trends.
- A maintained review schedule that tells the learner what to study each day.
- A device that can be studied from with no connection.

### 6.4 Feedback Loop

Recorded outcomes are not merely reported; they are the input to the next
scheduling decision. Correct recalls lengthen intervals, lapses shorten them,
and cards answered incorrectly inside a session are re-queued within the same
session (at most twice per card, so a single item cannot trap the learner). The
learner's observed difficulty therefore continuously reshapes the workload.

<!-- pagebreak -->

## Chapter 7 — Methodology

### 7.1 Research Design

The study employs **developmental research** — specifically the design-and-
development research model of Richey and Klein (2007) — in which the production
of an artifact (the system) and the study of that production are treated as
equally important. The project proceeds in four phases: (1) analysis of the
problem and requirements, (2) design, (3) development and iterative testing, and
(4) evaluation.

### 7.2 Requirements Gathering

Requirements are drawn from three sources: (a) a survey and informal interviews
with students on their current study habits, the materials they receive, and
their perceived barriers to self-testing; (b) a review of the learning-science
literature summarized in Chapter 5; and (c) document analysis of real course
material (lecture PDFs, slide decks, handouts) used as test input throughout
development. Requirements are recorded as user stories and traced to specific
objectives and test cases.

### 7.3 Development Methodology

Development follows an **incremental and iterative** approach: each increment
delivers a working vertical slice that is demonstrated, tested, and refined
before the next begins. Version control is used throughout, and no increment is
considered complete until its automated tests pass.

| Increment | Delivered capability |
| --- | --- |
| P1 — Core | Upload and parsing (PDF, image), AI generation, Study Mode, deck storage |
| P2 — Practice and measurement | Exam Mode, scoring, and study statistics per account |
| P3 — Accounts | Google sign-in, per-user data isolation, rate limiting, maintenance mode |
| P4 — Retention | SM-2 descendant scheduler, Review queue, deck badges, offline grading |
| P5 — Offline and resilience | Service worker, IndexedDB snapshots, outbox replay, AI model failover across providers |

### 7.4 System Architecture

QuizTime is a three-tier web application:

- **Presentation tier.** A React single-page interface rendered by Next.js,
  styled with a soft claymorphic design system, served responsively to phones
  and desktops and installable as a PWA.
- **Application tier.** Next.js route handlers implement the REST API:
  authentication, generation, deck and card management, review scheduling,
  statistics, device bundle export, health, and configuration.
- **Data tier.** PostgreSQL (via Drizzle ORM) stores accounts, decks, cards,
  progress, results, and schedules.
- **External services.** Google Gemini and OpenRouter for generation; Google
  OAuth for identity.

Supporting tiers inside the browser are a **service worker** (application shell
and background synchronization) and an **IndexedDB snapshot store** (decks,
cards, progress, and schedules for offline study).

### 7.5 Data Model

| Table | Purpose | Key relationships |
| --- | --- | --- |
| `users` | Google account profile (provider subject id, email, name, image) | Root of all ownership |
| `study_sessions` | A study set (deck): title, source type, source text, AI summary, owner | Belongs to a user |
| `flashcards` | Question, answer, hint, difficulty, order within the deck | Belongs to a study set |
| `card_progress` | Known/unknown flag, attempts, last reviewed — one row per card per deck | Unique on (card, session) |
| `study_results` | One row per answered card: correctness, mode, timestamp | Belongs to a user, deck, and card |
| `card_reviews` | Scheduling state per card: ease, interval, reps, lapses, learning step, due date | Unique on (user, card) |

Ownership is enforced by user-scoped foreign keys with `ON DELETE CASCADE`, and
every query in the API is scoped to the authenticated user, so one account can
never read, grade, or delete another account's data.

### 7.6 Tools and Technologies

| Layer | Technology |
| --- | --- |
| Front-end | React 19, Next.js 16 (App Router), TypeScript 5.9 |
| Styling | Tailwind CSS 4, custom claymorphic design tokens |
| Offline | Service Worker, Cache Storage, IndexedDB, Background Sync |
| Back-end | Next.js route handlers (Node.js), Auth.js v5 (JWT sessions) |
| Database | PostgreSQL with Drizzle ORM and versioned SQL migrations |
| Document parsing | pdf.js (PDF, client and server), mammoth (DOCX), JSZip (PPTX) |
| AI providers | Google Gemini (primary), OpenRouter (fallback), with a custom failover engine |
| Hosting | Vercel (serverless) with a managed PostgreSQL instance |
| Quality assurance | Node test runner, TypeScript compiler, ESLint, end-to-end HTTP suites with minted sessions |

### 7.7 Testing and Evaluation

**Automated verification.** The project ships 194 automated checks across nine
test files: the offline core and service-worker contract (38 + 9), the failover
engine (41), the spaced-repetition scheduler (21), the fallback provider adapter
(20), the generation endpoint's fallback behaviour (17), the deck editor (9),
the offline round trip against a real server and database (9), and an
authentication/statistics end-to-end suite (30). For this paper, the five suites
that need neither a database nor an API key were executed — 146 checks, all
passing. Eight of the end-to-end checks attempt cross-account access directly,
proving that one learner cannot read, grade, or delete another's decks, results,
or schedules.

**Manual verification.** A scripted usability walkthrough covers the primary
tasks (upload, generate, edit, study in each mode, grade a review, install the
app, study in airplane mode, reconnect and confirm synchronization).

**System evaluation.** Acceptability is measured with a researcher-made
instrument based on the ISO/IEC 25010 software quality model, covering
functional suitability, performance efficiency, reliability, usability,
security, and maintainability. Respondents rate statements on a five-point
Likert scale; results are analyzed using descriptive statistics (mean and
standard deviation) and interpreted with a standard adjectival rating scale.

### 7.8 Ethical Considerations

Participation in surveys and evaluation is voluntary and anonymized, with
informed consent. Only Google sign-in is supported, so the system never stores
passwords, and no learner data are shared with third parties beyond the material
transmitted to the configured AI providers for generation. API credentials are
held in server-side environment variables and never exposed to the browser.
Consistent with the Data Privacy Act of 2012 (Republic Act No. 10173), learners
may delete their study sets at any time, deletion cascades to all dependent
records, and offline copies are purged on sign-out. Because some AI providers may
use submitted prompts for training on free tiers, the project documents this and
advises learners not to upload confidential material.

<!-- pagebreak -->

## Chapter 8 — Proposed System: Features and Functionality

### 8.1 Material Upload and AI Generation

The learner drags in files, picks them from the gallery or file system, or uses
the camera, and may additionally paste text. Up to eight files are sent together
and combined into a single study set. Photographs are downscaled before upload;
Word and PowerPoint files are converted to text; PDFs and images are read by the
model directly. When a document exceeds the serverless request limit, the browser
extracts its text and uploads it in parts, which are merged into one set. The
response reports which model produced the cards and, if a switch occurred, tells
the learner which model was used and why.

### 8.2 Four Study Modes

| Mode | Interaction | Checking and scoring |
| --- | --- | --- |
| **Study** | Read the question, tap to flip, reveal the answer and optional hint | Self-reported "Got it / Still learning"; the card can be re-queued within the session |
| **Exam** | Choose one of four options | Immediate correct/wrong feedback; 10 points per correct answer, bonuses for medium (+5) and hard (+10) cards and for consecutive correct answers (+2 each, capped at +10) |
| **Identification** | Type the answer from memory | Case-, punctuation-, and typo-tolerant matching, including `/`-separated alternative answers |
| **Enumeration** | Type every item of a list answer, in any order | Per-item feedback; a card is complete when all items are named |

Exam sessions end with a results screen showing accuracy, letter grade, points
against the maximum, best streak, elapsed time, and a review of missed
questions, which can be sent directly into Study Mode for remediation.

### 8.3 Deck Editing

Every deck is editable. A learner can create a deck manually without uploading
anything, rename or re-describe any deck, and add, edit, delete, or reorder
cards. Saving a deck diffs the list within a single transaction: edited cards
keep their database identity — and therefore their progress and review schedule
— omitted cards are deleted, and new cards are inserted in the order shown.

### 8.4 Spaced Repetition and Progress Analytics

The Review tab presents the day's queue across all decks, split into overdue
and new cards, with a per-deck filter and a badge on the navigation item. Each
graded card prints what each button will do before it is pressed, because the
client and the server run the same scheduler. Progress analytics add up every
answered card into overall totals, accuracy, and a daily streak, plus per-deck
mastery, spaced-repetition health (cards tracked, due now, learning, mature,
lapses), and a recent-activity feed.

### 8.5 Offline Study

Installed or cached, QuizTime opens with no network and still signs the learner
in from a cached session, lists saved decks with their due counts, runs all four
study modes, computes the review queue locally with the same scheduler as the
server, and records answers to an outbox that is replayed in order — in batches,
and in the background where the browser supports it — as soon as connectivity
returns. Deletions propagate immediately so a removed deck cannot return from the
cache, and signing out purges the device copy.

### 8.6 Reliability and Operational Features

- **Model failover with memory.** A rate-limited or unavailable model is skipped
  for a cooldown window (honouring the provider's own retry hint when supplied,
  and doubling on repeated failures up to 30 minutes), then retried
  automatically. Non-retryable errors are surfaced immediately instead of being
  masked by another attempt.
- **Rate limiting.** Generation is limited per user so that a single account
  cannot exhaust the project's API quota.
- **Health and configuration endpoints.** A health check reports database
  connectivity and maintenance state; a configuration endpoint lets the interface
  distinguish "not yet configured" from "broken".
- **Maintenance mode.** A signed-out visitor sees a maintenance page while
  signed-in users keep full access with a notice, and the toggle takes effect
  without a rebuild.

<!-- pagebreak -->

## Chapter 9 — Work Plan and Timeline

The project is scheduled over six months (24 weeks).

| Phase | Weeks | Activities | Deliverables |
| --- | --- | --- | --- |
| 1. Planning and analysis | 1–4 | Literature review, learner survey and interviews, requirements specification, feasibility assessment | Concept paper, requirements list, use cases |
| 2. Design | 4–8 | Architecture, data model, interface prototypes, scheduler design, test plan | System design document, ERD, wireframes |
| 3. Increment P1–P2 (core and practice) | 6–12 | Upload/parsing, generation, Study and Exam modes, scoring, storage | Working prototype with decks and scoring |
| 4. Increment P3 (accounts and security) | 10–14 | Google sign-in, per-user scoping, rate limiting, maintenance mode | Multi-user release with data isolation |
| 5. Increment P4 (retention) | 13–17 | Scheduler, Review queue, deck badges, offline grading queue | Spaced-repetition release |
| 6. Increment P5 (offline and resilience) | 16–20 | Service worker, snapshots, outbox replay, AI failover | Offline-capable PWA with provider failover |
| 7. Testing and evaluation | 19–22 | Automated suites, usability walkthrough, acceptability survey, deployment | Test report, evaluation results |
| 8. Documentation and defense | 22–24 | User manual, technical documentation, final paper, presentation | Final documentation and manuscript |

<!-- pagebreak -->

## Chapter 10 — Budgetary Requirements

Development uses free and open-source technologies; the costs below are the
operational expenses of running and evaluating the system for one semester.

| Item | Specification | Estimated cost |
| --- | --- | --- |
| Domain name | `.com`, one year | ₱700 |
| Application hosting | Vercel — free tier sufficient for development and defense; Pro tier optional | ₱0 – ₱1,200 / month |
| Database hosting | Managed PostgreSQL — free tier sufficient; paid tier optional | ₱0 – ₱1,500 / month |
| AI generation (primary) | Google Gemini API — free tier for development; small paid allowance for the evaluation period | ₱0 – ₱1,500 |
| AI generation (fallback) | OpenRouter — one-time credit purchase unlocks a higher free daily allowance | ₱600 |
| Materials, printing, and defense | Documentation printing, binding, presentation materials | ₱1,200 |
| **Estimated total** | | **₱2,500 – ₱10,000** |

Notes: the project is deliberately designed to run entirely on free tiers when
quotas permit, and the failover chain means the system degrades rather than
fails when a free allowance is exhausted. Internet subscription and the
developers' own devices are contributed and are not charged to the project.

<!-- pagebreak -->

## Chapter 11 — Expected Outcomes and Conclusion

At the end of the project, the team expects to deliver:

1. **A deployed, installable web application** that converts uploaded or pasted
   learning material into editable flashcards and drills them in four study
   modes with scoring and feedback.
2. **A working spaced-repetition scheduler** with a daily review queue that
   demonstrably changes what the learner studies next, and per-deck and overall
   progress analytics that make that change visible.
3. **An offline-capable study experience** in which decks, progress, and the
   review queue remain usable without a connection and synchronize afterwards.
4. **A resilient generation pipeline** that survives individual models or
   providers being rate-limited or unavailable, and that is honest with the
   learner about which model produced the cards.
5. **Verified quality** evidenced by 194 automated checks — 146 of them
   re-executed for this paper, including cross-account access attempts and the
   offline round trip — and by the acceptability evaluation using the
   ISO/IEC 25010-based instrument.
6. **Complete documentation** — user guide, technical documentation, and the
   final manuscript — so the system can be maintained, extended, or studied
   further.

The project rests on a simple claim supported by decades of learning research:
learners remember what they retrieve, and they retrieve more of what is
scheduled for them. The barrier has never been the science but the labour of
applying it. QuizTime proposes to remove that labour — by using AI to prepare
the material a learner already has, and by using a scheduler to decide when each
card should return — and to do so in a form that keeps working where many
learners actually study: on a phone, with a connection that cannot be relied on.

<!-- pagebreak -->

## References

Cepeda, N. J., Pashler, H., Vul, E., Wixted, J. T., & Rohrer, D. (2006).
Distributed practice in verbal recall tasks: A review and quantitative
synthesis. *Psychological Bulletin, 132*(3), 354–380.

Dunlosky, J., Rawson, K. A., Marsh, E. J., Nathan, M. J., & Willingham, D. T.
(2013). Improving students' learning with effective learning techniques:
Promising directions from cognitive and educational psychology.
*Psychological Science in the Public Interest, 14*(1), 4–58.

Ebbinghaus, H. (1913). *Memory: A contribution to experimental psychology*
(H. A. Ruger & C. E. Bussenius, Trans.). Teachers College, Columbia University.
(Original work published 1885)

Karpicke, J. D., & Blunt, J. R. (2011). Retrieval practice produces more
learning than elaborative studying with concept mapping. *Science, 331*(6018),
772–775.

Kasneci, E., Sessler, K., Küchemann, S., Bannert, M., Dementieva, D., Fischer,
F., Gasser, U., Groh, G., Günnemann, S., Hüllermeier, E., Krusche, S., Kutyniok,
G., Michaeli, T., Nerdel, C., Pfeffer, J., Poquet, O., Sailer, M., Schmidt, A.,
Seidel, T., … Kasneci, G. (2023). ChatGPT for good? On opportunities and
challenges of large language models for education. *Learning and Individual
Differences, 103*, 102274.

Mayer, R. E. (2009). *Multimedia learning* (2nd ed.). Cambridge University
Press.

Paivio, A. (1986). *Mental representations: A dual coding approach*. Oxford
University Press.

Republic Act No. 10173. (2012). *Data Privacy Act of 2012*. Republic of the
Philippines.

Richey, R. C., & Klein, J. D. (2007). *Design and development research: Methods,
strategies, and issues*. Routledge.

Roediger, H. L., III, & Karpicke, J. D. (2006). Test-enhanced learning: Taking
memory tests improves long-term retention. *Psychological Science, 17*(3),
249–255.

Sweller, J. (1988). Cognitive load during problem solving: Effects on learning.
*Cognitive Science, 12*(2), 257–285.

Wozniak, P. A., & Gorzelanczyk, E. J. (1994). Optimization of repetition
schedule in the practice of learning. *Acta Neurobiologiae Experimentalis,
54*(1), 59–62.

Zawacki-Richter, O., Marín, V. I., Bond, M., & Gouverneur, F. (2019). Systematic
review of research on artificial intelligence applications in higher education —
Where are the educators? *International Journal of Educational Technology in
Higher Education, 16*(1), 39.

<!-- pagebreak -->

## Appendices

### Appendix A — API Endpoint Summary

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/scan` | Validate uploads/text, generate flashcards with failover, return title, summary, cards, and the model used |
| GET | `/api/sessions` | List the signed-in user's decks with counts and due badges |
| POST | `/api/sessions` | Create a study set manually |
| GET | `/api/sessions/[id]` | Retrieve one deck with its cards |
| PATCH | `/api/sessions/[id]` | Rename or re-describe a deck; update progress |
| DELETE | `/api/sessions/[id]` | Delete a deck and its dependent records |
| PUT | `/api/sessions/[id]/cards` | Save the full card list in one transactional diff (edit, delete, insert, reorder) |
| GET | `/api/review` | Return the review queue with counts, due dates, and deck breakdown |
| POST | `/api/review` | Grade up to 100 cards and reschedule them |
| GET | `/api/stats` | Overall and per-deck statistics plus recent activity |
| POST | `/api/stats/results` | Record up to 100 right/wrong outcomes |
| GET | `/api/offline/bundle` | Export the snapshot a device needs for offline study |
| GET | `/api/config` | Report which generation providers are configured |
| GET | `/api/health` | Report application and database health and maintenance state |
| * | `/api/auth/[...nextauth]` | Google sign-in and session handling |

### Appendix B — Spaced-Repetition Parameters

| Parameter | Value | Meaning |
| --- | --- | --- |
| Learning steps | 1 minute, 10 minutes | A new card's first repetitions before graduation |
| Graduating interval | 1 day | Interval after the last learning step |
| Easy graduation | 4 days | Interval when a new card is graded Easy immediately |
| Relearning step | 10 minutes | Where a lapsed card returns to |
| Default ease | 2.50 | Starting ease factor |
| Ease range | 1.30 – 2.80 | Clamp applied by the scheduler |
| Hard multiplier | × 1.20 | Interval growth for Hard (at least one day) |
| Easy bonus | × 1.30 | Additional multiplier for Easy |
| Ease change | Again −0.20, Hard −0.15, Easy +0.15 | Applied on each grade |
| Interval range | 1 – 365 days | Clamp applied after graduation |
| New cards per day | 20 | Daily limit on introduced new cards |
| In-session requeues | 2 per card | Maximum repeats of a missed card in one session |

### Appendix C — Environment Configuration

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string (required) |
| `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | Google sign-in and session signing |
| `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_FALLBACK_MODELS`, `GEMINI_RATE_LIMIT_COOLDOWN_SECONDS` | Primary provider and its failover order |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODELS` | Fallback provider and its model list |
| `MAINTENANCE_MODE` | Toggle maintenance mode without a rebuild |

### Appendix D — Testing Suites

| Suite | Checks | Coverage |
| --- | --- | --- |
| `test:offline` | 47 | Offline core, browser glue, and the service-worker contract — **run for this paper, all passing** |
| `test:failover` | 41 | Failover engine with simulated rate-limit, unavailable-model, and bad-request errors — **run, all passing** |
| `test:srs` | 21 | Learning steps, graduation, lapses, ease clamping, interval growth, button previews — **run, all passing** |
| `test:openrouter` | 20 | Fallback provider adapter and error normalization — **run, all passing** |
| `test:scan` | 17 | The generation endpoint end to end with fake provider endpoints — **run, all passing** |
| `test:e2e` | 30 | Authentication, statistics, scheduling, and cross-account isolation over HTTP (needs a database) |
| `test:deck-editor` | 9 | Card creation, editing, deletion, reordering, and progress preservation (needs a database) |
| `test:offline-e2e` | 9 | Offline round trip against a real server and database (needs a database) |
| **Total** | **194** | 146 executed and passing without a database or API key |
