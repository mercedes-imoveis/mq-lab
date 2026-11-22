# mq-lab: merge queue experiment (throwaway, safe to delete)

Workflow: PR build and merge_group build, 1 job "gate" (sleep 90). Runner time per build is about 94s. Ruleset "main-mq" is set to disabled.

| Round | Config | PRs | Builds (merge_group) | Complete | Cancelled | Failed | Runner s (merge_group) | Enqueue to main | Entered main |
|---|---|---|---|---|---|---|---|---|---|
| A | ALLGREEN, no cancel, build 5, min 1 | #1-#4 | 4 | 4 | 0 | 0 | 379 | 2m28s | 4 of 4 |
| B | HEADGREEN, cancel-in-progress, min 4, wait 5 | #5-#8 | 4 | 1 | 3 | 0 | 96 | 2m33s | 4 of 4, together |
| C | B config, PR #11 (3rd) adds files/FAIL* | #9-#12 | 10 | 1 | 6 | 3 | 376 | 9m14s | only #12 (after 3 rebuilds); #9, #10, #11 removed (failed_checks) |

Findings
- B: cancelled builds of #5-#7 did not remove those PRs; the head build (#8, cumulative) passed and the whole group merged. Main tip = the tested head commit (f174b0b1).
- C: a cancelled build counts as a failed check for the entry (state UNMERGEABLE). When the head build failed, the queue removed the first entry of the group (#9, innocent), rebuilt the rest, the head failed again, removed #10, and so on, until #11 (culprit) was removed. Each round cost a full head build.
