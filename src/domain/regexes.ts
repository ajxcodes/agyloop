/* eslint-disable @typescript-eslint/no-unused-vars */
import { VERDICT_SKIPPED } from './gate-verdicts';

/**
 * The refusal `GateResultReport.parseBlock` prints when a report has no
 * `GATE_REPORT_JSON:` marker (issue #413). A check that ASSERTS this text is a
 * deliberate refusal test and is exempt from Rule C; a comment that merely
 * names it is not, or an explanatory `#` line would disarm the rule.
 */
export const REGEX_GATE_REPORT_MARKER_REFUSAL = /missing\s+GATE_REPORT_JSON/;


// System-origin-only invariant (issue #236): the REVIEW_STATUS token contract stays
// binary (APPROVED | CHANGES_REQUESTED) so a Reviewer subagent can never self-declare
// `SKIPPED` to bypass review. VERDICT_SKIPPED is set exclusively by RunReviewUseCase
// when no reviewer output / critique report exists and is never parsed from text.
export const REGEX_REVIEW_STATUS_TOKEN = /^REVIEW_STATUS:\s*(APPROVED|CHANGES_REQUESTED)$/im;

export const REGEX_REVIEW_SUMMARY_TOKEN = /^REVIEW_SUMMARY:\s*(.+)$/im;

export const REGEX_UNFULFILLED_AC_TOKEN = /^UNFULFILLED_AC:\s*(.+)$/im;

export const REGEX_REMEDIATION_GUIDANCE_TOKEN = /^REMEDIATION_GUIDANCE:\s*(.+)$/im;


// Structured Protocol Regex Patterns
export const REGEX_GATE_STATUS_TOKEN = /^GATE_STATUS:\s*(PASSED|FAILED|TIMED_OUT)$/im;

export const REGEX_BUILD_STATUS_TOKEN = /^BUILD_STATUS:\s*(PASSED|FAILED)$/im;

export const REGEX_TEST_METRICS_TOKEN = /^(?:TEST_METRICS|TEST_COUNT):\s*(.+)$/im;

export const REGEX_FAILURE_FILE_TOKEN = /^FAILURE_FILE:\s*(.+)$/im;

export const REGEX_FAILING_ASSERTION_TOKEN = /^FAILING_ASSERTION:\s*(.+)$/im;


// Issue #415: every metric pattern carries TWO alternatives — the label form a
// .NET/VSTest summary prints (`Passed:    12`) and the historical verb form
// (`12 passed`, and Mocha's participle `12 passing`). `[ \t]` (never `\s`) keeps
// `12\n     Failed: 0` from pairing the PASSED line's number with the FAILED
// label, which fabricated `failed: 12` and `total: 24` on a real VSTest block.
// The verb alternative keeps the participle suffix (issue #415 review round 1):
// dropping `ing` made `TestMetrics.parse('  12 passing (1s)')` return null and
// failed a genuinely passing Mocha suite, which is an allowlisted runner.
export const REGEX_METRIC_PASSED =
  /(?:\bpass(?:ed)?[ \t]*:[ \t]*(?:\n[ \t]*)?(\d+)|(\d+)[ \t]+pass(?:ed|ing)?\b)/i;

export const REGEX_METRIC_FAILED =
  /(?:\bfail(?:ed)?[ \t]*:[ \t]*(?:\n[ \t]*)?(\d+)|(\d+)[ \t]+fail(?:ed|ing)?\b)/i;

export const REGEX_METRIC_SKIPPED =
  /(?:\bskip(?:ped)?[ \t]*:[ \t]*(?:\n[ \t]*)?(\d+)|(\d+)[ \t]+skip(?:ped)?\b)/i;

export const REGEX_METRIC_TOTAL =
  /(?:\b(?:tests?|total)[ \t]*:[ \t]*(?:\n[ \t]*)?(\d+)|(\d+)[ \t]+tests?[ \t]+completed\b)/i;

export const REGEX_TAP_TESTS = /tests\s+(\d+)/i;

export const REGEX_TAP_PASS = /pass\s+(\d+)/i;

export const REGEX_TAP_FAIL = /fail\s+(\d+)/i;

export const REGEX_TAP_SKIPPED = /skipped\s+(\d+)/i;


export const REGEX_MD_TABLE_HEADER = /\|\s*Command\s*\|\s*Exit Code\s*\|\s*Duration\s*\|\s*Status\s*\|/i;

export const REGEX_MD_TABLE_ROW = /\|\s*([^|]+?)\s*\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([A-Z_\s]+?)\s*\|/;


// eslint-disable-next-line no-control-regex
export const REGEX_ANSI_ESCAPE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

export const REGEX_STACK_FRAME = /^\s*at\s+(?:(?<callSite>.*?)\s+\((?<fileLocation>[^)]+:\d+:\d+)\)|(?<directLocation>[^\s()]+\.[a-zA-Z0-9]+:\d+:\d+))/;

export const REGEX_FILE_LOCATION = /(?:at\s+.*?\(([^)]+:\d+:\d+)\)|at\s+([^\s()]+\.[a-zA-Z0-9]+:\d+:\d+)|([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+:\d+:\d+))/;

export const REGEX_ASSERTION_FAILURE = /(?:AssertionError|Assertion failed|Expected:|Received:|assert(?:\.[a-zA-Z0-9_]+)?\s*\(|Error:\s*.+|expect\(.*\)\..*)/i;

export const REGEX_ERROR_BANNER = /(?:FAIL|ERROR|FAILURE|✖|×)\s+(.+)/;

export const REGEX_NOISE_NODE_INTERNAL = /(?:node:internal\/|\/node_modules\/)/;

export const REGEX_NOISE_NPM_ERR = /^npm\s+ERR!/;

export const REGEX_NOISE_PASSING = /^\s*(?:✔|√|PASS|ok\s+\d+)\s+/;


// Markdown "bold key" bullets: `- **Key:**` (unfilled) versus `- **Key:** value`
// (filled). Used by `DiscoveryReport` to tell an untouched template scaffold from
// a discovery report a subagent actually wrote. Deliberately template-agnostic:
// the predicate never names a specific section key, so it survives the repository
// drifting its `templates/discovery-plan.md`.
//
// BOTH spellings carry evidence because the two authoritative sources disagree:
// `templates/discovery-plan.md` writes the colon INSIDE the bold (`- **Key:**`),
// while the discovery prompt's own Expected Output Structure writes it OUTSIDE
// (`- **Summary & Symptoms**:`). Recognising one only made the prompt's own shape
// invisible as evidence — half of issue #306's false negative.
//
// Both carry the `g` flag, so `RegExp.prototype.test()` is STATEFUL (it advances
// `lastIndex` and would alternate true/false on repeated calls). Always use
// `String.prototype.match()` with these — `match` on a global regex resets
// `lastIndex` first and returns the full match array, so it is safe to call
// repeatedly on the same instance.
export const REGEX_MD_UNFILLED_KEY_BULLET = /^[ \t]*[-*+][ \t]*\*\*[^*\n]+?(?::\*\*|\*\*:)[ \t]*$/gm;

export const REGEX_MD_FILLED_KEY_BULLET = /^[ \t]*[-*+][ \t]*\*\*[^*\n]+?(?::\*\*|\*\*:)[ \t]*\S/gm;


/**
 * The `- ` / `* ` / `+ ` list marker of a bullet, plus the whitespace after it.
 * Split out of `DiscoveryReport` so the inline copy cannot drift from
 * `REGEX_MD_UNFILLED_KEY_BULLET`'s own `[-*+][ \t]*` prefix.
 */
export const REGEX_MD_BULLET_PREFIX = /^[-*+][ \t]*/;


/**
 * The `**Key:**` / `**Key**:` header of a bold-key bullet, without the leading
 * list marker. Paired with `REGEX_MD_BULLET_PREFIX` to recover the
 * human-readable key name.
 *
 * No `g` flag: `exec()` must stay stateless, and the captured key never carries
 * the trailing colon (`**Observed Behavior:**` yields `Observed Behavior`).
 */
export const REGEX_MD_BOLD_KEY = /^\*\*([^*\n]+?)(?::\*\*|\*\*:)/;


/**
 * A `##`..`######` markdown section heading. Group 2 is the heading text.
 *
 * Why `DiscoveryReport` needs it: the discovery prompt's Expected Output
 * Structure is heading-shaped, so a compliant RCA can carry its evidence as
 * prose under these headings and never write a single `- **Key:**` bullet
 * (issue #306). `#` (a single hash) is deliberately excluded — that is the
 * document title, i.e. preamble, not a section.
 */
export const REGEX_MD_SECTION_HEADING = /^[ \t]{0,3}(#{2,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;


/**
 * A top-level `#` title heading (not a section). Matched lines are preamble and
 * contribute no content, which is what keeps a pristine scaffold at zero units.
 */
export const REGEX_MD_TITLE_HEADING = /^[ \t]{0,3}#[ \t]+\S/;


/**
 * A markdown table separator row (`|---|:---:|`). Structural, not evidence —
 * `cleanProseLine` returns `''` for it so pipes and dashes cannot pad a report
 * over the content threshold.
 */
export const REGEX_MD_TABLE_SEPARATOR = /^[ \t]*\|?[ \t]*:?-{2,}[-|: \t]*$/;


/**
 * The markdown noise `DiscoveryReport.cleanProseLine` strips before measuring a
 * line's substance. Hoisted here — beside the key-bullet grammar and the section
 * regexes — so every markdown-shape rule the predicate reads is visible in one
 * place instead of being scattered inline through the value object.
 *
 * All five are used with `String.prototype.replace()` only, so their `g` flag is
 * safe (a global `test()` would carry `lastIndex` between calls).
 */
export const REGEX_MD_BLOCKQUOTE_PREFIX = /^(?:>[ \t]*)+/;

/** `[text](url)` / `![alt](url)` → the link TEXT (`$1`), never the target. */
export const REGEX_MD_LINK_SYNTAX = /!?\[([^\]]*)\]\([^)]*\)/g;

export const REGEX_MD_EMPHASIS = /\*\*|__/g;

/** Backticks and table pipes are punctuation, not words. */
export const REGEX_MD_INLINE_NOISE = /[`|]/g;

export const REGEX_MD_WHITESPACE_RUN = /\s+/g;

/** Trailing sentence punctuation, stripped before pointer/heading comparisons. */
export const REGEX_MD_TRAILING_PUNCTUATION = /[.!]+$/;

/** The `1. ` / `2) ` numbering a discovery section heading carries. */
export const REGEX_MD_HEADING_NUMBERING = /^\s*\d+[.)]?\s+/;

/**
 * A key value that POINTS at other evidence instead of carrying any: `see
 * above`, `see the Root Cause Analysis section above for details`, `n/a`,
 * `TODO`, …
 *
 * Why: without this, padding four content-free bullets with a 60-character
 * pointer cleared the per-unit character floor, produced four content units and
 * released a skeleton (issue #306, AC2). A cross-reference is not evidence,
 * however long it is, so pointer-only values are never substantive units.
 *
 * Matched against a NORMALISED value: lowercased, markdown noise stripped,
 * whitespace collapsed and trailing punctuation removed.
 */

export const REGEX_MD_POINTER_ONLY_VALUE =
  /^(?:(?:see|refer\s+to)\s+(?:the\s+)?[^.!?]{0,80}?\b(?:above|below|earlier|previous)\b(?:\s+for\s+(?:details|context))?|(?:see|refer\s+to)\s+(?:above|below)|n\/?a|todo|tbd|none|ditto|as\s+above|same\s+as\s+above|null|nil)$/;


/**
 * A line that continues the bullet above it: leading whitespace, then content.
 *
 * Why `DiscoveryReport` needs it: planning subagents habitually write a key's
 * value as an indented sub-list on the FOLLOWING lines —
 *
 *     - **Relevant Code References:**
 *       - `src/application/start-planning.ts`
 *
 * — which both key-bullet regexes above (anchored to a single line) score as
 * "unfilled". That shape is the norm, not the exception, so ignoring it parked
 * 80% of this repository's own genuine RCA reports.
 */
export const REGEX_MD_INDENTED_CONTINUATION = /^[ \t]+\S/;


/**
 * A fenced code block: an opening ``` / ~~~ fence (3+ markers, optional
 * indentation, optional info string), its payload, and a closing fence of the
 * same marker. An unterminated fence runs to end-of-document.
 *
 * Why `DiscoveryReport` strips these before matching: a real discovery report
 * routinely QUOTES the pristine template it is filling in — the report for
 * issue 237 reproduces the empty `- **Key:**` scaffold inside a fence to show
 * what was replaced. Matching over the raw text scored such a report
 * "unpopulated" purely because of code it was quoting.
 *
 * Two non-obvious details keep it honest: the closing marker is a backreference
 * (`\1`) so a ```` fence may contain ``` lines, and the unterminated branch is
 * anchored with `(?![\s\S])` rather than `$` so a stray trailing fence line can
 * never swallow the rest of the document.
 */
export const REGEX_MD_FENCED_CODE_BLOCK = /^[ \t]*(`{3,}|~{3,})[^\n]*(?:\r?\n[\s\S]*?\r?\n[ \t]*\1[^\n]*(?=\r?\n|(?![\s\S]))|[\s\S]*(?![\s\S]))/gm;

/**
 * A CRLF or lone-CR line ending, normalised to `\n` before any partition runs.
 *
 * Why `DiscoveryReport` needs it: every section/key rule is anchored with `$`
 * and without the `m` flag, so a line ending in `\r` never matches — a CRLF
 * report scored zero sections, zero units, and named no empty section or blank
 * key in its park (issue #306 review). Sibling domain parsers already normalise
 * this way (`plan-document-kind.ts`, `plan-content.ts`, `plan-digest.ts`), so
 * reading raw on-disk text without it was the divergence, not the convention.
 */

export const REGEX_MD_CRLF = /\r\n?/g;


// Regular Expressions
export const REGEX_ENV_KEY_VAL = /^\s*([\w.-]+)\s*=\s*(.*)?\s*$/;

export const REGEX_JSON_CODE_BLOCK = /```(?:json)?\s*([\s\S]*?)\s*```/;

export const REGEX_SEVERITY = /^(critical|error|warning|suggestion|info)$/i;

export const REGEX_CONFIDENCE = /^(high|medium|low)$/i;


export const REGEX_CONVENTIONAL_HEADER =
  // eslint-disable-next-line no-useless-escape
  /^(?<type>[a-z]+)(?:\((?<scope>[a-z0-9_.\-\/]+)\))?(?<breaking>!)?:\s*(?<description>.+)$/i;

  // eslint-disable-next-line no-useless-escape
export const REGEX_BREAKING_CHANGE_FOOTER =
  /^BREAKING[ -]CHANGE:\s*(.+)$/im;

export const REGEX_DIFF_FILE_HEADER =
  /^diff --git\/(.+?) b\/(.+?)$/gm;

export const REGEX_ISSUE_NUMBER_REF = /#(\d+)/;

export const REGEX_POSITIONAL_ISSUE_ID = /^#?(\d+)$/;

export const REGEX_LEADING_CONVENTIONAL_PREFIX =
  /^(?:\[(?:task|feat|feature|fix|bug|refactor|chore|perf|docs)\]\s*(?:phase\s*\d+:?\s*)?|feat|fix|refactor|chore|test|perf|docs|style):\s*/i;

/**
 * Milestone and kind tags carried in every issue title of a phase milestone
 * (issue #345 in #339, AC-4.3).
 *
 * They are release-notes poison: the commit subject is the only thing
 * `ajxcodes/auto-tag` consumes, so `[Phase 6]` / `[Bug]` surviving into the
 * description propagates into the changelog. Stripped GLOBALLY (not only at
 * position 0) — a milestone/kind tag is never valid description content.
 */
export const REGEX_MILESTONE_TAG = /\[Phase\s+\d+\]/gi;

export const REGEX_KIND_TAG = /\[(?:Bug|Feature|Enhancement|Refactor)\]/gi;


/**
 * The header the review bot puts on a PR conversation summary:
 * `**Review feedback on \`src/app.ts\` (Line 42):**`.
 */
export const REGEX_PR_FEEDBACK_HEADER = /^\s*\*\*Review feedback on `[^`]*`[^*]*\*\*/;

/**
 * The attribution footer the review bot appends: `*Powered by ...*`.
 */

export const REGEX_PR_FEEDBACK_FOOTER = /\*Powered by[^*]*\*\s*$/;


/**
 * The fragment that identifies the conversation comment a dismissal reply
 * answers. Every reference the tool posts ends with it, so the ids of the
 * comments that were answered can be read back off the PR's conversation.
 */
export const REGEX_DISMISS_CONVERSATION_REFERENCE = /#issuecomment-(\d+)/g;


/**
 * Cues that a finding REQUESTS A CHANGE. Any match wins over an affirmation:
 * a body that praises and then asks for a fix is a change request.
 *
 * NO `g` / `y` flags: a shared RegExp carrying `lastIndex` state across calls
 * would make the classifier non-deterministic.
 */
export const REGEX_FINDING_CHANGE_REQUEST_CUES: readonly RegExp[] = Object.freeze([
  // imperative openers ("Revert to @v4.", "Add a test for the empty payload")
  /^(?:please\s+)?(?:add|remove|delete|revert|replace|rename|fix|change|update|refactor|extract|inline|move|switch|use|prefer|avoid|ensure|guard|validate|handle|return|throw|log|document|test|consider|make|keep|drop|bump|pin|wrap|split|dedupe|simplify|reuse|restore)\b/,
  // obligation modals
  /\b(?:must|should|shall|needs? to|has to|have to|ought to|is required to|are required to|would be better to|suggest(?:s|ed|ion)?|recommend(?:s|ed|ation)?)\b/,
  // defect vocabulary
  /\b(?:bugs?|defects?|error\w*|exception\w*|fail\w*|crash\w*|leak\w*|vulnerab\w*|injection|hazards?|race condition|deadlock\w*|regress\w*|incorrect|invalid|unsafe|insecure|broken|inconsistent|duplicat\w*|redundan\w*|unused|unreachable|undefined|dereferenc\w*|missing|absent|off-by-one|overflow|deprecated|outdated|stale|swallow\w*)\b/,
  // negated existence / correctness ("does not exist", "isn't handled")
  /\b(?:does|do|did|is|are|was|were|will|would|can|could|has|have|had)\s+not\b|\b(?:doesn|don|didn|isn|aren|wasn|weren|won|wouldn|can|couldn|hasn|haven|hadn)'t\b|\bnever\b|\bno longer\b/,
  // explicit change directives
  /\b(?:instead of|rather than|revert to|replace .{0,60} with|change .{0,60} to|should be|must be|breaks|will break|would break)\b/
]);


/** Cues that a finding ASSERTS NO DEFECT. Only consulted when no change cue matched. */
export const REGEX_FINDING_AFFIRMATION_CUES: readonly RegExp[] = Object.freeze([
  /\b(?:looks? good|lgtm|well[- ](?:written|structured|tested|documented|handled|scoped)|no (?:issues?|problems?|concerns?|defects?|regressions?)|nothing to (?:change|fix)|as expected|matches the (?:plan|spec|specification|standards?)|consistent with)\b/,
  /\b(?:correct(?:ly)?|proper(?:ly)?|safe(?:ly)?|sound|clean|fine|valid|appropriate|reasonable|idiomatic|robust)\b/,
  /\b(?:exists?|is present|are present|is defined|are defined|is available|up[- ]to[- ]date|latest|accurate)\b/
]);
