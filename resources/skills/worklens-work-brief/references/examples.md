# Evidence interpretation examples

All names and events below are fictional. These examples illustrate decisions;
they are not a report template, sample data to reuse, or evidence for user work.

## Linked work and different states

A Jira issue for a search fix links to a PR. The PR merged during the requested
week. A design page still says "implementation pending"; its last edit predates
the merge. No release or deployment record was reviewed.

Describe one work item: the search fix was merged, with the PR as evidence. Do
not count the issue, PR, and design page as three completed tasks. The PR establishes
merge status; the older page does not overturn it, and neither proves deployment.

## Activity after the reporting period

The requested period is April 5–11, 2027. A task was in progress on April 11 and
completed on April 13. The brief is prepared on April 14, when the task is closed.

Report the in-period state supported by its history. If useful, add "Current
status as of April 14: completed on April 13." Do not include that completion
among April 5–11 accomplishments. Without history, report only the verified
current status and explain that the earlier state could not be established.

## A decision conflict

A current issue says a rollout is blocked pending approval. A similarly dated
meeting note says approval was proposed, without recording a decision.

Retain the documented blocker and identify the proposed approval as pending,
with links to both records. Do not turn a proposal into an agreed next step. If
the sources instead make incompatible explicit claims and neither resolves the
conflict, present the discrepancy as needing confirmation.

## Partial access and an old blocker

Jira is available, a linked repository is inaccessible, and document search
returns only its first page. A known issue has been blocked since before the
requested week and is still marked blocked.

Include that unresolved issue as current context, not a newly occurring blocker.
Continue or narrow the document search if possible. Deliver a Jira-based brief
with any documents actually read, naming the repository access and remaining
pagination gaps. Do not claim no PR activity or no blockers because results are
missing.
