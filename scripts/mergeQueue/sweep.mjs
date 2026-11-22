/**
 * Merge-queue requeue robot, I/O side (docs/specs/ci-gate-fila-de-merge.md section 5.3).
 * Reads the repo state with `gh` (GH_TOKEN), asks the pure decide() what to do and does it:
 * enqueue innocents with expectedHeadOid (never jump), comment each suspect once, keep the ledger comment.
 * Idempotent: every run re-reads the whole state, so a missed or duplicated trigger is harmless.
 *
 *   env: GH_TOKEN, GITHUB_REPOSITORY (owner/name), MQ_WORKFLOW (default "ci"), MQ_DRY_RUN=1 (decide only)
 *   exit: 0 ok; 1 breaker / stuck queue / API error (annotated with ::error::)
 */
import { execFileSync } from "node:child_process";
import { decide } from "./requeue.mjs";
import { LEDGER_MARKER, readLedger, writeLedger } from "./ledger.mjs";

const repo = process.env.GITHUB_REPOSITORY;
const [owner, name] = String(repo ?? "").split("/");
const workflowName = process.env.MQ_WORKFLOW ?? "ci";
const dry = process.env.MQ_DRY_RUN === "1";
const SUSPECT_MARKER = "<!-- merge-queue-robot-suspect";

const gh = (args, input) => execFileSync("gh", args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
const graphql = (query, vars = {}) => {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push("-F", `${k}=${v}`);
  const out = JSON.parse(gh(args));
  if (out.errors) throw new Error(JSON.stringify(out.errors));
  return out.data;
};
const rest = (path) => JSON.parse(gh(["api", path]));

const STATE_QUERY = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequests(states:OPEN,first:100){nodes{
  id number state isDraft headRefOid
  labels(first:20){nodes{name}}
  mergeQueueEntry{state enqueuedAt}
  commits(last:1){nodes{commit{committedDate}}}
  timelineItems(last:30,itemTypes:[REMOVED_FROM_MERGE_QUEUE_EVENT,ADDED_TO_MERGE_QUEUE_EVENT]){nodes{__typename
    ... on RemovedFromMergeQueueEvent{createdAt reason}
    ... on AddedToMergeQueueEvent{createdAt}}}
  comments(last:100){nodes{databaseId body}}
}}}}`;

const failedTail = (runId) => {
  try {
    const jobs = rest(`repos/${repo}/actions/runs/${runId}/jobs?per_page=50`).jobs ?? [];
    const failed = jobs.flatMap((j) => (j.steps ?? []).filter((s) => s.conclusion === "failure").map((s) => ({ job: j.name, step: s.name })));
    let tail = "";
    try {
      tail = gh(["run", "view", String(runId), "-R", repo, "--log-failed"]).trim().split("\n").slice(-40).join("\n");
    } catch {}
    return failed.map((f, i) => ({ ...f, tail: i === failed.length - 1 ? tail : "" }));
  } catch {
    return [];
  }
};

const main = () => {
  const now = Date.now();
  const prs = graphql(STATE_QUERY, { owner, name }).repository.pullRequests.nodes;
  const runs = rest(`repos/${repo}/actions/runs?event=merge_group&per_page=100`).workflow_runs.filter((r) => r.name === workflowName);

  // one ledger for the whole repo, one hidden comment per PR
  const ledger = { requeues: [] };
  const ledgerComment = new Map();
  for (const pr of prs) for (const c of pr.comments.nodes) {
    if (c.body.includes(LEDGER_MARKER)) {
      ledgerComment.set(pr.number, c.databaseId);
      ledger.requeues.push(...readLedger(c.body).requeues);
    }
  }

  // a removal counts only while it is the PR's latest queue event (an AddedToMergeQueue after it = already requeued)
  const events = [];
  const byPr = new Map(prs.map((p) => [p.number, p]));
  for (const pr of prs) {
    const items = pr.timelineItems.nodes;
    const last = items[items.length - 1];
    if (last?.__typename !== "RemovedFromMergeQueueEvent") continue;
    const committed = Date.parse(pr.commits.nodes[0]?.commit?.committedDate ?? 0);
    const removedAt = Date.parse(last.createdAt);
    const failedRun = runs.filter((r) => r.conclusion === "failure" && Date.parse(r.created_at) <= removedAt).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    events.push({
      type: "removed", pr: pr.number, headSha: pr.headRefOid,
      // a commit pushed after the removal means the head is no longer the SHA the queue removed
      currentHeadSha: committed > removedAt ? "changed-after-removal" : pr.headRefOid,
      reason: last.reason, at: last.createdAt, state: pr.state, isDraft: pr.isDraft,
      labels: pr.labels.nodes.map((l) => l.name), runUrl: failedRun?.html_url, runId: failedRun?.id,
    });
  }
  const pending = events.filter((e) => String(e.reason).toLowerCase() === "failed_checks");
  const earliest = Math.min(...pending.map((e) => Date.parse(e.at)));
  const queueEntries = prs.filter((p) => p.mergeQueueEntry);
  const greenRun = runs.find((r) => r.conclusion === "success" && Date.parse(r.created_at) > earliest);
  // the cascade is closed when a merge_group went green after the removals, or when the queue emptied
  if (pending.length && (greenRun || queueEntries.length === 0)) events.push({ type: "green", at: new Date(now).toISOString() });

  const queue = queueEntries.map((p) => ({ pr: p.number, state: p.mergeQueueEntry.state, enqueuedAt: p.mergeQueueEntry.enqueuedAt }));
  // failure details only for suspects, only when needed (cheap: decide runs first without them)
  const first = decide(events, ledger, now, { queue });
  for (const s of first.suspects) {
    const ev = events.find((e) => e.type === "removed" && e.pr === s.pr);
    if (ev?.runId) ev.failed = failedTail(ev.runId);
  }
  const result = decide(events, ledger, now, { queue });
  console.log(JSON.stringify({ events: events.map((e) => ({ type: e.type, pr: e.pr, reason: e.reason, at: e.at })), requeue: result.requeue, suspects: result.suspects, breaker: result.breaker, alerts: result.alerts }));
  if (dry) return 0;

  let failedExit = 0;
  // One requeue at a time. Putting every removed PR back together rebuilds the same failing group and the queue
  // removes the innocents first again (bench 22/11: #76 and #77 were removed twice and wrongly accused). A group of
  // one gives an exact verdict. Wait while a PR the robot put back is still in the queue.
  const inFlight = queueEntries.some((p) => ledger.requeues.some((r) => r.pr === p.number && r.headSha === p.headRefOid));
  result.requeue = inFlight ? [] : result.requeue.slice(0, 1);
  for (const a of result.alerts) {
    console.log(`::error::merge-queue-robot alert ${JSON.stringify(a)}`);
    failedExit = 1;
  }
  for (const c of result.comments) {
    const ev = events.find((e) => e.type === "removed" && e.pr === c.pr);
    const marker = `${SUSPECT_MARKER} ${ev.headSha} -->`;
    const already = byPr.get(c.pr).comments.nodes.some((x) => x.body.includes(marker));
    if (already) continue;
    gh(["api", `repos/${repo}/issues/${c.pr}/comments`, "-F", "body=@-"], `${marker}\n${c.body}`);
    console.log(`commented on suspect #${c.pr}`);
  }
  for (const r of result.requeue) {
    const pr = byPr.get(r.pr);
    try {
      graphql("mutation($id:ID!,$oid:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$oid}){mergeQueueEntry{id}}}", { id: pr.id, oid: r.headSha });
    } catch (e) {
      console.log(`::error::enqueue of #${r.pr} failed: ${String(e.message).slice(0, 300)}`);
      failedExit = 1;
      continue;
    }
    const mine = ledger.requeues.filter((x) => x.pr === r.pr);
    const body = writeLedger({ requeues: [...mine, { pr: r.pr, headSha: r.headSha, at: new Date().toISOString() }] });
    if (ledgerComment.has(r.pr)) gh(["api", "-X", "PATCH", `repos/${repo}/issues/comments/${ledgerComment.get(r.pr)}`, "-F", "body=@-"], body);
    else gh(["api", `repos/${repo}/issues/${r.pr}/comments`, "-F", "body=@-"], body);
    console.log(`requeued #${r.pr} at ${r.headSha.slice(0, 8)}`);
  }
  return failedExit;
};

try {
  process.exitCode = main();
} catch (e) {
  console.log(`::error::merge-queue-robot failed: ${String(e.message).slice(0, 500)}`);
  process.exitCode = 1;
}
