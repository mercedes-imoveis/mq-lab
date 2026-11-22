/**
 * The requeue robot's ledger: a hidden comment on the PR (docs/specs/ci-gate-fila-de-merge.md §5.3).
 * It remembers which (PR, head SHA) pairs the robot already put back in the queue, so a SHA is never
 * requeued twice and the global breaker can count the last hour.
 *
 * Pure string in, string out: the workflow reads and writes the comment, this file only (de)serialises it.
 * Shape: { requeues: [{ pr, headSha, at }] } with `at` an ISO date.
 */

export const LEDGER_MARKER = "<!-- merge-queue-robot-ledger";

export const emptyLedger = () => ({ requeues: [] });

/** The comment body that carries the ledger. A corrupt or foreign body never throws: it reads as empty. */
export const writeLedger = (ledger) => `${LEDGER_MARKER} ${JSON.stringify({ requeues: ledger.requeues })} -->`;

export const readLedger = (body) => {
  const text = String(body ?? "");
  const start = text.indexOf(LEDGER_MARKER);
  if (start === -1) return emptyLedger();
  const end = text.indexOf("-->", start);
  if (end === -1) return emptyLedger();
  try {
    const parsed = JSON.parse(text.slice(start + LEDGER_MARKER.length, end));
    if (!Array.isArray(parsed?.requeues)) return emptyLedger();
    return { requeues: parsed.requeues.filter((r) => r && Number.isInteger(r.pr) && typeof r.headSha === "string" && typeof r.at === "string") };
  } catch {
    return emptyLedger();
  }
};