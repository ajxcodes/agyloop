/**
 * agyloop - CliGitHubGateway Infrastructure Adapter
 *
 * Implements GitHubGateway by invoking the GitHub CLI (`gh`).
 * Strictly prefixes all invocations with `env GITHUB_TOKEN=''` to use the authenticated local keyring.
 */

import { execSync, execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import {
  GitHubGateway,
  GitHubGatewayOptions,
  GitHubIssueData,
  GitHubComment,
  PRCommentCategory,
  PullRequestReviewComment,
  ReviewThread,
  UnresolvedReviewThread,
  GitHubPullRequestData,
  FindPullRequestOptions,
  CreatePullRequestOptions,
  formatIssueForPrompt
} from '../ports';
import {
  GitHubContextError,
  prAssertsIssueDelivery,
  PR_CATEGORY_ERROR,
  PR_CATEGORY_QUESTION,
  PR_CATEGORY_GENERAL,
  PR_SEVERITY_CATEGORY_MAPPING,
  PR_MARKER_QUESTION,
  PR_MARKER_NIT,
  PR_MARKDOWN_MARKER_TEMPLATE,
  PR_BRACKET_MARKER_TEMPLATE,
  REGEX_PR_FEEDBACK_HEADER,
  SEVERITY_CRITICAL,
  SEVERITY_ERROR,
  SEVERITY_WARNING,
  SEVERITY_SUGGESTION,
  SEVERITY_INFO,
  SEVERITY_ICON_CRITICAL,
  SEVERITY_ICON_WARNING,
  SEVERITY_ICON_SUGGESTION,
  SEVERITY_ICON_INFO,
  ReviewSeverity,
  DISMISS_CONVERSATION_REPLY_REFERENCE,
  DISMISS_CONVERSATION_PERMALINK_TEMPLATE
} from '../domain';

/**
 * The severity classification of a single PR comment.
 */
export interface PrCommentClassification {
  readonly category: PRCommentCategory;
  readonly severity: ReviewSeverity;
}

/**
 * Builds the markdown bold form of a marker: `**CRITICAL**`.
 */
function markdownMarker(marker: string): string {
  return PR_MARKDOWN_MARKER_TEMPLATE.replace('{marker}', marker.toLowerCase());
}

/**
 * Builds the legacy bracket form of a marker: `[error]`.
 */
function bracketMarker(marker: string): string {
  return PR_BRACKET_MARKER_TEMPLATE.replace('{marker}', marker.toLowerCase());
}

/**
 * The markers that may LEAD a comment's headline, most severe first.
 *
 * The markdown form the review bots emit (`**CRITICAL**`) and the legacy
 * bracket form (`[critical]`) are both honoured, but only at the head of the
 * headline — see {@link leadingMarkerOf}.
 */
const LEADING_MARKERS: readonly string[] = Object.freeze([
  SEVERITY_CRITICAL,
  SEVERITY_ERROR,
  SEVERITY_WARNING,
  SEVERITY_SUGGESTION,
  PR_MARKER_NIT,
  PR_MARKER_QUESTION,
  SEVERITY_INFO
]);

/**
 * The severity icons a headline may lead with.
 */
const LEADING_SEVERITY_ICONS: readonly string[] = Object.freeze([
  SEVERITY_ICON_CRITICAL,
  SEVERITY_ICON_WARNING,
  SEVERITY_ICON_SUGGESTION,
  SEVERITY_ICON_INFO
]);

/**
 * The headline of a comment — the line a reader recognises it by.
 *
 * The review bot's `**Review feedback on ...**` line is a HEADER, not the
 * headline: the finding itself follows on the next line, and that is where
 * the severity marker sits (`ℹ️ **INFO**: ...`).
 */
function headlineOf(body: string): string {
  const withoutHeader = (body || '').replace(REGEX_PR_FEEDBACK_HEADER, '');
  for (const line of withoutHeader.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

/**
 * Strips a leading severity icon (`ℹ️`, `💡`, …) from a headline.
 */
function stripLeadingSeverityIcon(headline: string): string {
  for (const icon of LEADING_SEVERITY_ICONS) {
    if (headline.startsWith(icon)) {
      return headline.slice(icon.length).trimStart();
    }
  }
  return headline;
}

/**
 * The marker a comment LEADS with, or null when it leads with none.
 *
 * The marker is anchored to the START of the headline (after an optional
 * severity icon). A body that merely QUOTES a marker — a run summary that
 * lists the markers it saw, a dismissal reply that quotes the feedback it
 * answers, prose that mentions "the `**error**` path" — is not classified by
 * the quoted marker: the marker says what the comment is ABOUT, and only the
 * leading one does.
 */
function leadingMarkerOf(headline: string): string | null {
  const candidate = stripLeadingSeverityIcon(headline).toLowerCase();
  for (const marker of LEADING_MARKERS) {
    if (
      candidate.startsWith(markdownMarker(marker)) ||
      candidate.startsWith(bracketMarker(marker))
    ) {
      return marker;
    }
  }
  return null;
}

/**
 * The classification a leading marker implies.
 *
 * The CATEGORY is derived from the SEVERITY through the domain's mapping, so
 * the two can never disagree: a critical/error finding is ERROR, a
 * warning/suggestion is SUGGESTION, an informational one is INFO.
 *
 * Two categories sit outside the mapping on purpose: QUESTION (a comment that
 * IS a question) and GENERAL (a comment with no marker at all).
 */
function classificationOfMarker(marker: string): PrCommentClassification {
  switch (marker) {
    case SEVERITY_CRITICAL:
      return {
        category: PR_SEVERITY_CATEGORY_MAPPING[SEVERITY_CRITICAL],
        severity: SEVERITY_CRITICAL
      };
    case SEVERITY_ERROR:
      return { category: PR_SEVERITY_CATEGORY_MAPPING[SEVERITY_ERROR], severity: SEVERITY_ERROR };
    case SEVERITY_WARNING:
      return {
        category: PR_SEVERITY_CATEGORY_MAPPING[SEVERITY_WARNING],
        severity: SEVERITY_WARNING
      };
    case SEVERITY_SUGGESTION:
      return {
        category: PR_SEVERITY_CATEGORY_MAPPING[SEVERITY_SUGGESTION],
        severity: SEVERITY_SUGGESTION
      };
    case PR_MARKER_NIT:
      return {
        category: PR_SEVERITY_CATEGORY_MAPPING[SEVERITY_SUGGESTION],
        severity: SEVERITY_SUGGESTION
      };
    case PR_MARKER_QUESTION:
      return { category: PR_CATEGORY_QUESTION, severity: SEVERITY_INFO };
    case SEVERITY_INFO:
      return { category: PR_SEVERITY_CATEGORY_MAPPING[SEVERITY_INFO], severity: SEVERITY_INFO };
    default:
      return { category: PR_CATEGORY_GENERAL, severity: SEVERITY_INFO };
  }
}

/**
 * Classifies a PR review comment by severity.
 *
 * The review bots emit markdown markers (`ℹ️ **INFO**`, `💡 **SUGGESTION**`,
 * `**CRITICAL**`, `**ERROR**`, `**WARNING**`); the legacy bracket forms
 * (`[error]`, `[critical]`, ...) are still honoured. A `CHANGES_REQUESTED`
 * review is a blocking verdict regardless of its body.
 *
 * The marker is read from the LEADING position of the comment's headline —
 * the same anchoring the emoji form has always used. A marker quoted
 * anywhere else in the body classifies nothing: a run summary that lists the
 * markers it saw is not a suggestion, and prose that mentions "the
 * `**error**` path" is not an error.
 *
 * A bare `?` in prose is NOT a question marker: only an explicit question
 * marker, or a comment whose headline is itself a question, is a question.
 */
export function classifyPrCommentSeverity(
  body: string,
  reviewState?: string
): PrCommentClassification {
  const text = body || '';

  if ((reviewState || '').toUpperCase() === 'CHANGES_REQUESTED') {
    return { category: PR_CATEGORY_ERROR, severity: SEVERITY_ERROR };
  }

  const headline = headlineOf(text);

  // The leading marker of the headline decides the severity.
  const marker = leadingMarkerOf(headline);
  if (marker) {
    return classificationOfMarker(marker);
  }

  // A headline that is only a severity icon carries that icon's severity.
  if (headline.startsWith(SEVERITY_ICON_CRITICAL)) {
    return {
      category: PR_SEVERITY_CATEGORY_MAPPING[SEVERITY_CRITICAL],
      severity: SEVERITY_CRITICAL
    };
  }
  if (headline.startsWith(SEVERITY_ICON_WARNING)) {
    return {
      category: PR_SEVERITY_CATEGORY_MAPPING[SEVERITY_WARNING],
      severity: SEVERITY_WARNING
    };
  }
  if (headline.startsWith(SEVERITY_ICON_SUGGESTION)) {
    return {
      category: PR_SEVERITY_CATEGORY_MAPPING[SEVERITY_SUGGESTION],
      severity: SEVERITY_SUGGESTION
    };
  }
  if (headline.startsWith(SEVERITY_ICON_INFO)) {
    return { category: PR_SEVERITY_CATEGORY_MAPPING[SEVERITY_INFO], severity: SEVERITY_INFO };
  }

  // A comment is a question when it IS a question — not when its prose merely
  // contains a question mark.
  if (headline.endsWith('?')) {
    return { category: PR_CATEGORY_QUESTION, severity: SEVERITY_INFO };
  }

  // Nothing was detected: the comment carries no review marker at all.
  return { category: PR_CATEGORY_GENERAL, severity: SEVERITY_INFO };
}

/**
 * Parses the payload of a paginated `gh api` call.
 *
 * `gh api --paginate` returns every page of a REST list endpoint. Depending on
 * the `gh` version the pages arrive either merged into a single JSON array or
 * as consecutive JSON arrays, so both shapes are accepted and merged.
 */
export function parsePaginatedJsonArray(raw: string): unknown[] {
  const text = (raw || '').trim();
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Fall through: the payload is a sequence of JSON arrays.
  }

  const merged: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '[') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === ']') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const page = JSON.parse(text.slice(start, i + 1));
          if (Array.isArray(page)) merged.push(...page);
        } catch {
          // A page that is not valid JSON contributes nothing.
        }
        start = -1;
      }
    }
  }

  return merged;
}


export class CliGitHubGateway implements GitHubGateway {
  /**
   * Executes a `gh` command prefixed with `env GITHUB_TOKEN=''`.
   */
  public runGh(commandArgs: string, options: { cwd?: string } = {}): string {
    const cwd = options.cwd || process.cwd();
    const cmd = `env GITHUB_TOKEN='' gh ${commandArgs}`;

    try {
      return execSync(cmd, {
        cwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GITHUB_TOKEN: ''
        }
      }).trim();
    } catch (err: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const errorMessage = err instanceof Error ? err.message : String(err);
      throw new GitHubContextError(`runGh: ${commandArgs}`, { commandArgs, cwd }, err);
    }
  }

  /**
   * Executes `gh` with an argv array (no shell involved), so arguments are passed verbatim.
   */
  public runGhArgs(args: readonly string[], options: { cwd?: string } = {}): string {
    const cwd = options.cwd || process.cwd();
    try {
      return execFileSync('gh', [...args], {
        cwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, GITHUB_TOKEN: '' }
      }).trim();
    } catch (err: unknown) {
      throw new GitHubContextError(`runGhArgs: ${args[0] ?? ''}`, { cwd }, err);
    }
  }

  public getCurrentRepo(cwd: string = process.cwd()): string | null {
    // 1. Try git remote get-url origin
    try {
      const remoteUrl = execSync('git remote get-url origin', {
        cwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();

      const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
      if (match) {
        return `${match[1]}/${match[2]}`;
      }
    } catch {
      // Remote fetch failed, fall through to package.json
    }

    // 2. Try package.json repository field
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const repoUrl =
          typeof pkg.repository === 'string'
            ? pkg.repository
            : pkg.repository && pkg.repository.url;
        if (repoUrl) {
          const match = repoUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
          if (match) {
            return `${match[1]}/${match[2]}`;
          }
        }
      } catch {
        // Ignore read/parse error
      }
    }

    return null;
  }

  public fetchIssue(
    issueNumber: number,
    options: GitHubGatewayOptions = {}
  ): GitHubIssueData | null {
    if (!issueNumber || issueNumber <= 0) {
      return null;
    }

    const repo = options.repo || this.getCurrentRepo(options.cwd);
    const repoFlag = repo ? `--repo ${repo}` : '';

    try {
      const rawJson = this.runGh(
        `issue view ${issueNumber} ${repoFlag} --json number,title,body,state,labels`,
        { cwd: options.cwd }
      );

      interface RawGhIssue {
        number?: number;
        title?: string;
        body?: string;
        state?: string;
        labels?: Array<{ name?: string } | string>;
        comments?: Array<{ author?: { login?: string }; body?: string; createdAt?: string }>;
        milestone?: { title?: string } | null;
      }

      const parsed = JSON.parse(rawJson) as RawGhIssue;
      const labels = (parsed.labels || []).map((l) => (typeof l === 'string' ? l : l.name || ''));
      const comments: GitHubComment[] = (parsed.comments || []).map((c) => ({
        author: (c.author && c.author.login) || 'unknown',
        body: c.body || '',
        createdAt: c.createdAt
      }));

      return {
        repo: repo || 'unknown',
        number: parsed.number || issueNumber,
        title: parsed.title || '',
        body: parsed.body || '',
        state: (parsed.state || 'OPEN').toUpperCase(),
        labels,
        comments,
        milestone: parsed.milestone?.title ? { title: parsed.milestone.title } : undefined
      };
    } catch (err: unknown) {
      return {
        repo: repo || 'unknown',
        number: issueNumber,
        title: '',
        body: '',
        state: 'UNKNOWN',
        labels: [],
        comments: [],
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  public findPullRequest(options: FindPullRequestOptions): GitHubPullRequestData | null {
    const repo = options.repo || this.getCurrentRepo(options.cwd);
    const repoFlag = repo ? `--repo ${repo}` : '';
    const state = options.state || 'all';

    try {
      let cmd: string;
      if (options.headBranch) {
        cmd = `pr list ${repoFlag} --head "${options.headBranch}" --state ${state} --json number,title,body,state,baseRefName,headRefName,url,mergedAt,labels,mergeStateStatus,mergeable --limit 1`;
      } else if (options.issueNumber) {
        cmd = `pr list ${repoFlag} --search "${options.issueNumber}" --state ${state} --json number,title,body,state,baseRefName,headRefName,url,mergedAt,labels,mergeStateStatus,mergeable --limit 10`;
      } else {
        return null;
      }

      const raw = this.runGh(cmd, { cwd: options.cwd });
      interface RawGhPr {
        number?: number;
        title?: string;
        body?: string;
        state?: string;
        baseRefName?: string;
        headRefName?: string;
        url?: string;
        mergedAt?: string | null;
        labels?: Array<{ name?: string } | string>;
        mergeStateStatus?: string;
        mergeable?: string;
      }

      const parsed = JSON.parse(raw) as RawGhPr[];
      if (!parsed || parsed.length === 0) {
        return null;
      }

      let pr: RawGhPr | undefined;
      if (options.issueNumber) {
        const numStr = String(options.issueNumber);
        const branchPattern = new RegExp(
          `^(?:task|fix|feature|issue|bugfix)?[-_/]?${numStr}(?:[-_/]|$)`,
          'i'
        );

        // 1. (#226) A PR whose BODY asserts delivery of this issue is authoritative:
        // if several PRs mention the issue, this is the one that delivered it.
        pr = parsed.find((p) => prAssertsIssueDelivery(p, numStr));

        // 2. Prefer head branch matching over title matching
        if (!pr) {
          pr = parsed.find((p) => branchPattern.test(p.headRefName || ''));
        }

        // 3. Fallback to title matching if no head branch match found
        if (!pr) {
          const titlePattern = new RegExp(`(^|\\s|[\\[(])#${numStr}([\\])\\s,.:;]|$)`, 'i');
          const branchIssuePattern = /^(?:task|fix|feature|issue|bugfix)?[-_/]?(\d+)(?:[-_/]|$)/i;

          pr = parsed.find((p) => {
            const head = p.headRefName || '';
            const title = p.title || '';

            if (!titlePattern.test(title)) {
              return false;
            }

            // Reject title matches if head branch explicitly points to a different issue number
            const branchIssueMatch = head.match(branchIssuePattern);
            if (branchIssueMatch && branchIssueMatch[1] !== numStr) {
              return false;
            }

            return true;
          });
        }

        if (!pr) {
          return null;
        }
      } else {
        pr = parsed[0];
      }

      const prLabels = (pr.labels || []).map((l) => (typeof l === 'string' ? l : l.name || ''));
      const isMerged = Boolean(pr.mergedAt || (pr.state || '').toUpperCase() === 'MERGED');

      return {
        number: pr.number || 0,
        title: pr.title || '',
        body: pr.body || '',
        state: isMerged ? 'MERGED' : (pr.state || 'OPEN').toUpperCase(),
        baseRefName: pr.baseRefName || '',
        headRefName: pr.headRefName || '',
        url: pr.url || '',
        merged: isMerged,
        labels: prLabels,
        mergeStateStatus: pr.mergeStateStatus,
        mergeable: pr.mergeable
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const lower = msg.toLowerCase();
      // Distinguish critical auth, credential, and network/repo failures from simply "no pull requests found"
      if (
        lower.includes('authentication') ||
        lower.includes('bad credentials') ||
        lower.includes('could not resolve to a repository') ||
        lower.includes('permission to') ||
        (lower.includes('graphql') && !lower.includes('deprecated'))
      ) {
        throw new GitHubContextError(`GitHub CLI failure in findPullRequest: ${msg}`);
      }
      return null;
    }
  }

  /**
   * Lists the review threads of a pull request, RESOLVED ones included.
   *
   * The resolution state is the cross-run memory of the inline surface: a
   * thread that is already resolved was answered by an earlier run.
   */
  public listReviewThreads(
    prNumber: number,
    options: GitHubGatewayOptions = {}
  ): ReviewThread[] {
    const repo = options.repo || this.getCurrentRepo(options.cwd);
    if (!repo || !prNumber || prNumber <= 0) return [];
    const [owner, name] = repo.split('/');
    const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved comments(first:100){nodes{databaseId}}}}}}}`;
    const raw = this.runGhArgs(
      ['api', 'graphql', '-f', `query=${query}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${prNumber}`],
      { cwd: options.cwd }
    );
    const parsed = JSON.parse(raw);
    const nodes: Array<{ id: string; isResolved: boolean; comments?: { nodes?: Array<{ databaseId?: number }> } }> =
      parsed?.data?.repository?.pullRequest?.reviewThreads?.nodes || [];
    return nodes.map((n) => ({
      id: n.id,
      isResolved: Boolean(n.isResolved),
      commentIds: (n.comments?.nodes || [])
        .map((c) => c.databaseId)
        .filter((x): x is number => typeof x === 'number')
    }));
  }

  public listUnresolvedReviewThreads(
    prNumber: number,
    options: GitHubGatewayOptions = {}
  ): UnresolvedReviewThread[] {
    return this.listReviewThreads(prNumber, options).filter((t) => !t.isResolved);
  }

  public replyToThread(
    threadId: string,
    body: string,
    options: GitHubGatewayOptions = {}
  ): void {
    const query = `mutation($threadId:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){comment{id}}}`;
    this.runGhArgs(
      ['api', 'graphql', '-f', `query=${query}`, '-f', `threadId=${threadId}`, '-f', `body=${body}`],
      { cwd: options.cwd }
    );
  }

  public resolveReviewThread(
    threadId: string,
    options: GitHubGatewayOptions = {}
  ): void {
    const query = `mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}`;
    this.runGhArgs(
      ['api', 'graphql', '-f', `query=${query}`, '-f', `threadId=${threadId}`],
      { cwd: options.cwd }
    );
  }

  public replyToConversationComment(
    prNumber: number,
    commentId: number,
    body: string,
    options: GitHubGatewayOptions = {}
  ): void {
    const repo = options.repo || this.getCurrentRepo(options.cwd);
    if (!repo || !prNumber || prNumber <= 0) return;

    // GitHub has no threaded reply for PR conversation comments: the dismissal
    // is posted as a conversation comment that references the one it answers.
    // The reference is what gives a LATER run the cross-run memory: it can
    // read the id of the comment that was already answered off the PR.
    const permalink = DISMISS_CONVERSATION_PERMALINK_TEMPLATE.replace(
      '{repo}',
      repo
    )
      .replace('{prNumber}', String(prNumber))
      .replace('{commentId}', String(commentId));
    const payload = `${body}\n\n${DISMISS_CONVERSATION_REPLY_REFERENCE.replace('{permalink}', permalink)}`;

    this.runGhArgs(
      [
        'api',
        '--method',
        'POST',
        `repos/${repo}/issues/${prNumber}/comments`,
        '-f',
        `body=${payload}`
      ],
      { cwd: options.cwd }
    );
  }

  public fetchPullRequestComments(
    prNumber: number,
    options: GitHubGatewayOptions = {}
  ): PullRequestReviewComment[] {
    if (!prNumber || prNumber <= 0) {
      return [];
    }

    const repo = options.repo || this.getCurrentRepo(options.cwd);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const repoFlag = repo ? `--repo ${repo}` : '';

    try {
      const repoPath = repo || this.getCurrentRepo(options.cwd);
      if (!repoPath) return [];

      // `--paginate` is mandatory: without it every surface is truncated at the
      // first page (30 records), so the triage silently misses most of the PR's
      // feedback — including a `CHANGES_REQUESTED` review verdict.
      const issueCommentsRaw = this.runGh(
        `api repos/${repoPath}/issues/${prNumber}/comments --paginate`,
        { cwd: options.cwd }
      );
      const reviewsRaw = this.runGh(
        `api repos/${repoPath}/pulls/${prNumber}/reviews --paginate`,
        { cwd: options.cwd }
      );
      const reviewCommentsRaw = this.runGh(
        `api repos/${repoPath}/pulls/${prNumber}/comments --paginate`,
        { cwd: options.cwd }
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parsedComments = parsePaginatedJsonArray(issueCommentsRaw) as Array<any>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parsedReviews = parsePaginatedJsonArray(reviewsRaw) as Array<any>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parsedReviewComments = parsePaginatedJsonArray(reviewCommentsRaw) as Array<any>;

      const results: PullRequestReviewComment[] = [];

      for (const c of parsedComments) {
        if (c.body && c.body.trim()) {
          const cat = classifyPrCommentSeverity(c.body);
          results.push({
            id: typeof c.id === 'number' ? c.id : undefined,
            surface: 'conversation',
            author: (c.user && c.user.login) || 'unknown',
            body: c.body,
            createdAt: c.created_at,
            category: cat.category,
            severity: cat.severity
          });
        }
      }

      for (const r of parsedReviews) {
        if (r.body && r.body.trim()) {
          const cat = classifyPrCommentSeverity(r.body, r.state);
          results.push({
            id: typeof r.id === 'number' ? r.id : undefined,
            surface: 'review',
            author: (r.user && r.user.login) || 'unknown',
            body: r.body,
            state: r.state,
            createdAt: r.submitted_at || r.created_at,
            category: cat.category,
            severity: cat.severity
          });
        }
      }

      for (const rc of parsedReviewComments) {
        if (rc.body && rc.body.trim()) {
          const parentReview = parsedReviews.find(r => r.id === rc.pull_request_review_id);
          const reviewState = parentReview ? parentReview.state : undefined;

          const cat = classifyPrCommentSeverity(rc.body, reviewState);
          results.push({
            id: rc.id,
            surface: 'inline',
            author: (rc.user && rc.user.login) || 'unknown',
            body: rc.body,
            path: rc.path,
            line: rc.line,
            state: reviewState,
            createdAt: rc.created_at,
            category: cat.category,
            severity: cat.severity
          });
        }
      }

      return results;
    } catch {
      return [];
    }
  }

  public createPullRequest(options: CreatePullRequestOptions): GitHubPullRequestData {
    const repo = options.repo || this.getCurrentRepo(options.cwd);
    const repoFlag = repo ? `--repo ${repo}` : '';
    const draftFlag = options.draft ? '--draft' : '';
    const labelsFlag =
      options.labels && options.labels.length > 0
        ? `--label "${options.labels.join(',')}"`
        : '';

    const titleEscaped = options.title.replace(/"/g, '\\"');
    const bodyEscaped = options.body.replace(/"/g, '\\"');

    const cmd = `pr create ${repoFlag} --base "${options.baseBranch}" --head "${options.headBranch}" --title "${titleEscaped}" --body "${bodyEscaped}" ${draftFlag} ${labelsFlag}`;

    const url = this.runGh(cmd, { cwd: options.cwd });

    // Parse PR number from created URL if available (e.g. .../pull/42)
    const match = url.match(/\/pull\/(\d+)/);
    const prNumber = match ? parseInt(match[1], 10) : 0;

    return {
      number: prNumber,
      title: options.title,
      state: 'OPEN',
      baseRefName: options.baseBranch,
      headRefName: options.headBranch,
      url,
      merged: false,
      labels: options.labels || []
    };
  }

  public applyLabels(
    targetNumber: number,
    labels: readonly string[],
    options: GitHubGatewayOptions = {}
  ): void {
    if (!labels || labels.length === 0 || !targetNumber) return;
    const repo = options.repo || this.getCurrentRepo(options.cwd);
    const repoFlag = repo ? `--repo ${repo}` : '';
    const labelArgs = labels.map((l) => `--add-label "${l}"`).join(' ');

    this.runGh(`issue edit ${targetNumber} ${repoFlag} ${labelArgs}`, { cwd: options.cwd });
  }

  public commentOnIssue(
    issueNumber: number,
    comment: string,
    options: GitHubGatewayOptions = {}
  ): void {
    if (!issueNumber || !comment) return;
    const repo = options.repo || this.getCurrentRepo(options.cwd);
    const repoFlag = repo ? `--repo ${repo}` : '';
    const commentEscaped = comment.replace(/"/g, '\\"');

    this.runGh(`issue comment ${issueNumber} ${repoFlag} --body "${commentEscaped}"`, {
      cwd: options.cwd
    });
  }

  public closeIssue(
    issueNumber: number,
    options: GitHubGatewayOptions = {}
  ): void {
    if (!issueNumber) return;
    const repo = options.repo || this.getCurrentRepo(options.cwd);
    const repoFlag = repo ? `--repo ${repo}` : '';

    this.runGh(`issue close ${issueNumber} ${repoFlag}`, { cwd: options.cwd });
  }

  public static formatIssueForPrompt(issueData: GitHubIssueData | null): string {
    return formatIssueForPrompt(issueData);
  }
}
