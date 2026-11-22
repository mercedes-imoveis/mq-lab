/**
 * The merge-queue requeue robot's brain: pure, no network (docs/specs/ci-gate-fila-de-merge.md §5).
 *
 * When the head build of a merge group fails, GitHub removes the FIRST entry of the group, rebuilds, fails
 * again, removes the next... Which one is guilty is NOT readable from the order: a later rebuild can contain
 * the culprit's file, so an innocent may leave last (bench round F: #39, #40, #41 culprit, #42 innocent last).
 * So the order never accuses. Everybody removed for failed_checks goes back once per head SHA; removed again
 * with the same SHA is the suspect and gets the comment with the failing run link.
 *
 *   decide(events, ledger, now, { queue, stuckMinutes }) -> { requeue, suspect, suspects, comment, comments, breaker, alerts }
 *
 *   events  (any order; sorted here by `at`) since the last closed cascade:
 *     { type: "removed", pr, headSha, currentHeadSha, reason, at, state, isDraft, labels, runUrl?, failed? }
 *         headSha = the SHA the queue removed; currentHeadSha = the PR's head now;
 *         failed = [{ job, step, tail }] from the failed run, optional.
 *     { type: "green", at }   a merge_group `quality` run concluded success: the cascade is closed.
 *   ledger  { requeues: [{ pr, headSha, at }] } (ledger.mjs)
 *   now     epoch ms
 *
 *   queue   optional [{ pr, state, enqueuedAt }]: entries in AWAITING_CHECKS longer than stuckMinutes
 *           (default STUCK_MINUTES) raise a "stuck" alert; the robot never requeues for that.
 *
 * Rules: requeue every PR removed for failed_checks once per (PR, headSha), after a merge_group went green,
 * only while the PR is open, not a draft, not labelled fila:segurar and its head is still the SHA the queue
 * removed; a PR removed again with a SHA already in the ledger is a suspect (no green needed); at most 10
 * requeues in 60 minutes (the 11th trips the breaker and the robot stops). The caller enqueues with
 * expectedHeadOid = headSha, never with jump.
 */

export const HOLD_LABEL = "fila:segurar";
export const MAX_REQUEUES_PER_HOUR = 10;
export const STUCK_MINUTES = 45;
const HOUR_MS = 60 * 60 * 1000;

const time = (event) => Date.parse(event.at);

const mayAct = (e) => e.state === "OPEN" && !e.isDraft && !(e.labels ?? []).includes(HOLD_LABEL) && e.currentHeadSha === e.headSha;

const accusation = (e) => {
  const failed = (e.failed ?? []).map((f) => `- \`${f.job}\` / \`${f.step}\`${f.tail ? `\n\`\`\`\n${f.tail}\n\`\`\`` : ""}`).join("\n");
  return [
    `The merge_group build failed with this PR as the suspect (\`${e.headSha.slice(0, 8)}\`).`,
    e.runUrl ? `Run: ${e.runUrl}` : null,
    failed ? `Failed steps:\n${failed}` : null,
    "It was not put back in the queue. Fix and push, or run `gh pr merge " + e.pr + "` if it was a flake.",
  ].filter(Boolean).join("\n\n");
};

export const decide = (events, ledger, now, { queue = [], stuckMinutes = STUCK_MINUTES } = {}) => {
  const ordered = [...events].sort((a, b) => time(a) - time(b));
  const green = ordered.some((e) => e.type === "green");
  const removals = ordered.filter((e) => e.type === "removed");
  const alerts = removals.filter((e) => String(e.reason).toLowerCase() === "timeout").map((e) => ({ type: "timeout", pr: e.pr }));
  for (const q of queue) {
    const minutes = Math.floor((now - Date.parse(q.enqueuedAt)) / 60_000);
    if (q.state === "AWAITING_CHECKS" && minutes > stuckMinutes) alerts.push({ type: "stuck", pr: q.pr, minutes });
  }
  const failures = removals.filter((e) => String(e.reason).toLowerCase() === "failed_checks");
  const result = { requeue: [], suspect: null, suspects: [], comment: null, comments: [], breaker: false, alerts };

  const seen = new Set((ledger.requeues ?? []).map((r) => `${r.pr}@${r.headSha}`));
  const suspects = failures.filter((e) => mayAct(e) && seen.has(`${e.pr}@${e.headSha}`));
  const candidates = green ? failures.filter((e) => mayAct(e) && !seen.has(`${e.pr}@${e.headSha}`)) : [];

  const recent = (ledger.requeues ?? []).filter((r) => now - Date.parse(r.at) < HOUR_MS).length;
  if (recent + candidates.length > MAX_REQUEUES_PER_HOUR) {
    result.breaker = true;
    result.alerts.push({ type: "breaker", recent });
  } else {
    result.requeue = candidates.map((e) => ({ pr: e.pr, headSha: e.headSha }));
  }

  result.suspects = suspects.map((e) => ({ pr: e.pr, headSha: e.headSha }));
  result.comments = suspects.map((e) => ({ pr: e.pr, body: accusation(e) }));
  const last = suspects[suspects.length - 1] ?? null;
  result.suspect = last ? { pr: last.pr, headSha: last.headSha } : null;
  result.comment = last ? result.comments[result.comments.length - 1] : null;
  return result;
};