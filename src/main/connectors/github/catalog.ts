import { z } from "zod";

export const text = z.string().max(1000000);
export const name = z.string().min(1).max(300);
export const id = z.number().int().positive();
export const sha = z.string().regex(/^[a-f0-9]{40}$/i);
export const repo = z
  .string()
  .min(3)
  .max(2000)
  .describe("Exact owner/repository or repository URL on the configured site");
export const filePath = z
  .string()
  .min(1)
  .max(2000)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      !p.split("/").some((s) => !s || s === "." || s === "..") &&
      !/[\x00-\x1f]/.test(p),
    "Use a relative repository file path without traversal",
  );
export const page = {
  page: id.max(10000).optional(),
  per_page: id.max(100).optional(),
};
export const names = z.array(name).max(100);
export const destination = z
  .object({
    path: text.optional(),
    directory: text.optional(),
    overwrite: z.boolean().optional(),
    expectedFile: text.optional(),
  })
  .strict();
const issue = { repo, issue_number: id };
const pr = { repo, pull_number: id };
const comment = { repo, comment_id: id };
const body = { body: text };
const optionalBody = { body: text.optional() };
const metadata = {
  labels: names.optional(),
  assignees: names.optional(),
  milestone: id.nullable().optional(),
  type: name.nullable().optional(),
};
const reaction = z.enum([
  "+1",
  "-1",
  "laugh",
  "confused",
  "heart",
  "hooray",
  "rocket",
  "eyes",
]);
export interface Operation {
  description: string;
  write: boolean;
  schema: z.ZodObject<any>;
  route?: string;
  paginated?: boolean;
  collection?: string;
  accepted?: boolean;
  defaults?: Record<string, unknown>;
}
export const operations: Record<string, Operation> = {};
export function define(
  key: string,
  description: string,
  fields: z.ZodRawShape,
  options: Omit<Operation, "description" | "schema" | "write"> & {
    write?: boolean;
  } = {},
) {
  operations[key] = {
    ...options,
    description,
    write: options.write ?? false,
    schema: z.object({ operation: z.literal(key), ...fields }).strict(),
  };
}
function read(
  key: string,
  description: string,
  route: string,
  fields: z.ZodRawShape = {},
  collection?: string | boolean,
) {
  define(
    key,
    description,
    { ...fields, ...(collection ? page : {}) },
    {
      route,
      paginated: !!collection,
      collection: typeof collection === "string" ? collection : undefined,
    },
  );
}
function write(
  key: string,
  description: string,
  route: string,
  fields: z.ZodRawShape,
  defaults?: Record<string, unknown>,
  accepted = false,
) {
  define(key, description, fields, { write: true, route, defaults, accepted });
}
const R = "/repos/{owner}/{repo}";
read("current_user", "Read the authenticated account", "GET /user");
read("server_info", "Read server metadata", "GET /meta");
read("rate_limit", "Read current API quotas", "GET /rate_limit");
read(
  "list_repositories",
  "List repositories accessible to this account",
  "GET /user/repos",
  {
    affiliation: name.optional(),
    visibility: z.enum(["all", "public", "private"]).optional(),
    sort: z.enum(["created", "updated", "pushed", "full_name"]).optional(),
    direction: z.enum(["asc", "desc"]).optional(),
  },
  true,
);
read(
  "list_organizations",
  "List organizations for this account",
  "GET /user/orgs",
  {},
  true,
);
read(
  "list_teams",
  "Discover organization teams",
  "GET /orgs/{org}/teams",
  { org: name },
  true,
);
read("read_user", "Read a user by exact login", "GET /users/{username}", {
  username: name,
});
read(
  "list_collaborators",
  "Discover repository collaborators",
  `GET ${R}/collaborators`,
  { repo },
  true,
);
for (const [kind, sorts] of Object.entries({
  repositories: ["stars", "forks", "help-wanted-issues", "updated"],
  code: ["indexed"],
  issues: ["comments", "reactions", "created", "updated"],
  commits: ["author-date", "committer-date"],
  users: ["followers", "repositories", "joined"],
})) {
  read(
    `search_${kind}`,
    `Search ${kind} with native GitHub qualifiers; maximum 1000 searchable matches`,
    `GET /search/${kind}`,
    {
      q: name.max(10000),
      sort: z.enum(sorts as [string, ...string[]]).optional(),
      order: z.enum(["asc", "desc"]).optional(),
    },
    "items",
  );
}
read(
  "search_prs",
  "Search pull requests with native qualifiers",
  "GET /search/issues",
  {
    q: text,
    sort: z.enum(["comments", "created", "updated"]).optional(),
    order: z.enum(["asc", "desc"]).optional(),
  },
  "items",
);
read(
  "read_repository",
  "Read repository metadata, permissions and merge settings",
  `GET ${R}`,
  { repo },
);
read("read_readme", "Read repository README at a ref", `GET ${R}/readme`, {
  repo,
  ref: name.optional(),
});
read(
  "read_content",
  "Read a file or directory at an explicit branch, tag or SHA; content may be base64",
  `GET ${R}/contents/{path}`,
  { repo, path: filePath.or(z.literal("")), ref: name },
);
read(
  "read_tree",
  "Read a Git tree; inspect truncated before treating it as complete",
  `GET ${R}/git/trees/{tree_sha}`,
  { repo, tree_sha: name, recursive: z.literal("1").optional() },
);
read("read_blob", "Read a blob by SHA", `GET ${R}/git/blobs/{file_sha}`, {
  repo,
  file_sha: sha,
});
read(
  "list_branches",
  "List remote branches",
  `GET ${R}/branches`,
  { repo },
  true,
);
read(
  "read_branch",
  "Read a remote branch and protection information",
  `GET ${R}/branches/{branch}`,
  { repo, branch: name },
);
read("list_tags", "List remote tags", `GET ${R}/tags`, { repo }, true);
read(
  "list_commits",
  "Read commit history",
  `GET ${R}/commits`,
  {
    repo,
    sha: name.optional(),
    path: filePath.optional(),
    author: name.optional(),
    since: z.iso.datetime().optional(),
    until: z.iso.datetime().optional(),
  },
  true,
);
read(
  "read_commit",
  "Read commit metadata and changed files; file list may need pagination",
  `GET ${R}/commits/{ref}`,
  { repo, ref: name },
  "files",
);
read(
  "compare",
  "Compare base and head; GitHub may cap changed files independently of commits",
  `GET ${R}/compare/{basehead}`,
  { repo, basehead: name },
  "commits",
);
write(
  "create_branch",
  "Create a remote branch at a known commit SHA",
  `POST ${R}/git/refs`,
  { repo, branch: name, sha },
  undefined,
);
define(
  "delete_branch",
  "Delete a named remote branch after checking expected SHA and protection; separate from merge",
  { repo, branch: name, expectedHeadSha: sha },
  { write: true },
);
write(
  "create_fork",
  "Create a remote fork; accepted does not mean fork provisioning has finished",
  `POST ${R}/forks`,
  {
    repo,
    organization: name.optional(),
    name: name.optional(),
    default_branch_only: z.boolean().optional(),
  },
  undefined,
  true,
);
define(
  "commit_files",
  "Atomically add/update/delete multiple files on an existing branch, using expected head SHA. File contents are UTF-8 text. No force push.",
  {
    repo,
    branch: name,
    expectedHeadSha: sha,
    message: name,
    additions: z
      .array(z.object({ path: filePath, contents: text }).strict())
      .max(100)
      .optional(),
    deletions: z.array(filePath).max(100).optional(),
  },
  { write: true },
);
read(
  "list_issues",
  "List issues (PR entries are separately identified by pull_request)",
  `GET ${R}/issues`,
  {
    repo,
    state: z.enum(["open", "closed", "all"]).optional(),
    labels: text.optional(),
    assignee: name.optional(),
    creator: name.optional(),
    mentioned: name.optional(),
    milestone: name.optional(),
    since: z.iso.datetime().optional(),
    sort: z.enum(["created", "updated", "comments"]).optional(),
    direction: z.enum(["asc", "desc"]).optional(),
  },
  true,
);
read(
  "read_issue",
  "Read an issue including node ID and current metadata",
  `GET ${R}/issues/{issue_number}`,
  issue,
);
read(
  "issue_timeline",
  "Read issue timeline events",
  `GET ${R}/issues/{issue_number}/timeline`,
  issue,
  true,
);
read(
  "list_comments",
  "Read issue or PR conversation comments",
  `GET ${R}/issues/{issue_number}/comments`,
  issue,
  true,
);
read(
  "read_comment",
  "Read one issue/PR conversation comment",
  `GET ${R}/issues/comments/{comment_id}`,
  comment,
);
write(
  "create_issue",
  "Create an issue with explicit repository and metadata",
  `POST ${R}/issues`,
  { repo, title: name, ...optionalBody, ...metadata },
);
write(
  "update_issue",
  "Update only supplied fields; omitted metadata is preserved",
  `PATCH ${R}/issues/{issue_number}`,
  {
    ...issue,
    title: name.optional(),
    ...optionalBody,
    ...metadata,
    state: z.enum(["open", "closed"]).optional(),
    state_reason: z
      .enum(["completed", "not_planned", "reopened"])
      .nullable()
      .optional(),
  },
);
write(
  "close_issue",
  "Close an issue",
  `PATCH ${R}/issues/{issue_number}`,
  { ...issue, state_reason: z.enum(["completed", "not_planned"]).optional() },
  { state: "closed" },
);
write(
  "reopen_issue",
  "Reopen an issue",
  `PATCH ${R}/issues/{issue_number}`,
  issue,
  { state: "open" },
);
write(
  "add_comment",
  "Add an issue/PR conversation comment",
  `POST ${R}/issues/{issue_number}/comments`,
  { ...issue, ...body },
);
write(
  "edit_comment",
  "Edit an issue/PR conversation comment",
  `PATCH ${R}/issues/comments/{comment_id}`,
  { ...comment, ...body },
);
write(
  "delete_comment",
  "Delete a specific issue/PR conversation comment",
  `DELETE ${R}/issues/comments/{comment_id}`,
  comment,
);
write(
  "add_labels",
  "Add labels while preserving unrelated labels",
  `POST ${R}/issues/{issue_number}/labels`,
  { ...issue, labels: names },
);
write(
  "remove_label",
  "Remove one label while preserving other labels",
  `DELETE ${R}/issues/{issue_number}/labels/{name}`,
  { ...issue, name },
);
write(
  "add_assignees",
  "Add issue assignees",
  `POST ${R}/issues/{issue_number}/assignees`,
  { ...issue, assignees: names },
);
write(
  "remove_assignees",
  "Remove selected issue assignees",
  `DELETE ${R}/issues/{issue_number}/assignees`,
  { ...issue, assignees: names },
);
write(
  "lock_issue",
  "Lock issue/PR conversation",
  `PUT ${R}/issues/{issue_number}/lock`,
  {
    ...issue,
    lock_reason: z
      .enum(["off-topic", "too heated", "resolved", "spam"])
      .optional(),
  },
);
write(
  "unlock_issue",
  "Unlock issue/PR conversation",
  `DELETE ${R}/issues/{issue_number}/lock`,
  issue,
);
read(
  "list_labels",
  "Discover repository labels",
  `GET ${R}/labels`,
  { repo },
  true,
);
write("create_label", "Create a repository label", `POST ${R}/labels`, {
  repo,
  name,
  color: z.string().regex(/^[a-f0-9]{6}$/i),
  description: text.optional(),
});
write("update_label", "Edit a repository label", `PATCH ${R}/labels/{name}`, {
  repo,
  name,
  new_name: name.optional(),
  color: z
    .string()
    .regex(/^[a-f0-9]{6}$/i)
    .optional(),
  description: text.optional(),
});
write(
  "delete_label",
  "Delete a repository label, removing it from issues and PRs",
  `DELETE ${R}/labels/{name}`,
  { repo, name },
);
read(
  "list_milestones",
  "Discover milestones",
  `GET ${R}/milestones`,
  { repo, state: z.enum(["open", "closed", "all"]).optional() },
  true,
);
read(
  "read_milestone",
  "Read milestone",
  `GET ${R}/milestones/{milestone_number}`,
  { repo, milestone_number: id },
);
write("create_milestone", "Create milestone", `POST ${R}/milestones`, {
  repo,
  title: name,
  description: text.optional(),
  due_on: z.iso.datetime().optional(),
  state: z.enum(["open", "closed"]).optional(),
});
write(
  "update_milestone",
  "Edit, close or reopen milestone",
  `PATCH ${R}/milestones/{milestone_number}`,
  {
    repo,
    milestone_number: id,
    title: name.optional(),
    description: text.optional(),
    due_on: z.iso.datetime().nullable().optional(),
    state: z.enum(["open", "closed"]).optional(),
  },
);
write(
  "delete_milestone",
  "Delete milestone",
  `DELETE ${R}/milestones/{milestone_number}`,
  { repo, milestone_number: id },
);
read(
  "list_issue_types",
  "Discover organization issue types where available",
  "GET /orgs/{org}/issue-types",
  { org: name },
);
read(
  "list_sub_issues",
  "List sub-issues",
  `GET ${R}/issues/{issue_number}/sub_issues`,
  issue,
  true,
);
read(
  "read_parent_issue",
  "Read the parent issue",
  `GET ${R}/issues/{issue_number}/parent`,
  issue,
);
write(
  "add_sub_issue",
  "Add a sub-issue by its numeric database ID, optionally reparent",
  `POST ${R}/issues/{issue_number}/sub_issues`,
  { ...issue, sub_issue_id: id, replace_parent: z.boolean().optional() },
);
write(
  "remove_sub_issue",
  "Remove a sub-issue relationship",
  `DELETE ${R}/issues/{issue_number}/sub_issue`,
  { ...issue, sub_issue_id: id },
);
for (const relation of ["blocked_by", "blocking"])
  read(
    `list_${relation}`,
    `List ${relation} issue dependencies`,
    `GET ${R}/issues/{issue_number}/dependencies/${relation}`,
    issue,
    true,
  );
write(
  "add_dependency",
  "Mark this issue as blocked by another issue's database ID",
  `POST ${R}/issues/{issue_number}/dependencies/blocked_by`,
  { ...issue, issue_id: id },
);
write(
  "remove_dependency",
  "Remove a blocking dependency",
  `DELETE ${R}/issues/{issue_number}/dependencies/blocked_by/{issue_id}`,
  { ...issue, issue_id: id },
);
for (const target of ["issue", "comment"]) {
  const base =
    target === "issue"
      ? `${R}/issues/{issue_number}`
      : `${R}/issues/comments/{comment_id}`;
  const fields = target === "issue" ? issue : comment;
  read(
    `list_${target}_reactions`,
    "Read reactions",
    `GET ${base}/reactions`,
    fields,
    true,
  );
  write(`add_${target}_reaction`, "Add reaction", `POST ${base}/reactions`, {
    ...fields,
    content: reaction,
  });
  write(
    `delete_${target}_reaction`,
    "Delete a reaction",
    `DELETE ${base}/reactions/{reaction_id}`,
    { ...fields, reaction_id: id },
  );
}
read(
  "list_prs",
  "List pull requests",
  `GET ${R}/pulls`,
  {
    repo,
    state: z.enum(["open", "closed", "all"]).optional(),
    head: name.optional(),
    base: name.optional(),
    sort: z
      .enum(["created", "updated", "popularity", "long-running"])
      .optional(),
    direction: z.enum(["asc", "desc"]).optional(),
  },
  true,
);
read(
  "read_pr",
  "Read pull request, head/base SHAs and mergeability (null means still computing)",
  `GET ${R}/pulls/{pull_number}`,
  pr,
);
read(
  "pr_files",
  "Read changed files and patches; GitHub caps the list at 3000 files",
  `GET ${R}/pulls/{pull_number}/files`,
  pr,
  true,
);
read(
  "pr_commits",
  "Read PR commits (GitHub caps this endpoint at 250)",
  `GET ${R}/pulls/{pull_number}/commits`,
  pr,
  true,
);
read(
  "list_reviews",
  "Read PR reviews",
  `GET ${R}/pulls/{pull_number}/reviews`,
  pr,
  true,
);
read(
  "read_review",
  "Read a review including pending state and commit anchor",
  `GET ${R}/pulls/{pull_number}/reviews/{review_id}`,
  { ...pr, review_id: id },
);
read(
  "review_comments",
  "Read comments belonging to one review",
  `GET ${R}/pulls/{pull_number}/reviews/{review_id}/comments`,
  { ...pr, review_id: id },
  true,
);
read(
  "list_review_comments",
  "Read inline review comments",
  `GET ${R}/pulls/{pull_number}/comments`,
  pr,
  true,
);
read(
  "requested_reviewers",
  "Read requested user/team reviewers",
  `GET ${R}/pulls/{pull_number}/requested_reviewers`,
  pr,
);
write(
  "create_pr",
  "Create a PR from existing remote refs, including forks",
  `POST ${R}/pulls`,
  {
    repo,
    title: name,
    ...optionalBody,
    head: name,
    head_repo: name.optional(),
    base: name,
    draft: z.boolean().optional(),
    maintainer_can_modify: z.boolean().optional(),
  },
);
write(
  "update_pr",
  "Edit title/body/base, close or reopen PR; use issue operations for labels and assignees",
  `PATCH ${R}/pulls/{pull_number}`,
  {
    ...pr,
    title: name.optional(),
    ...optionalBody,
    base: name.optional(),
    state: z.enum(["open", "closed"]).optional(),
    maintainer_can_modify: z.boolean().optional(),
  },
);
write(
  "request_reviewers",
  "Request user/team reviews by login/team slug",
  `POST ${R}/pulls/{pull_number}/requested_reviewers`,
  { ...pr, reviewers: names.optional(), team_reviewers: names.optional() },
);
write(
  "remove_reviewers",
  "Remove review requests",
  `DELETE ${R}/pulls/{pull_number}/requested_reviewers`,
  { ...pr, reviewers: names.optional(), team_reviewers: names.optional() },
);
write(
  "update_pr_branch",
  "Update PR branch only if the head still matches; accepted is asynchronous",
  `PUT ${R}/pulls/{pull_number}/update-branch`,
  { ...pr, expected_head_sha: sha },
  undefined,
  true,
);
const inline = z
  .object({
    path: filePath,
    body: text,
    line: id,
    side: z.enum(["LEFT", "RIGHT"]),
    start_line: id.optional(),
    start_side: z.enum(["LEFT", "RIGHT"]).optional(),
  })
  .strict();
define(
  "create_review",
  "Create a pending review or submit COMMENT/APPROVE/REQUEST_CHANGES. Read code and checks first; comments must anchor to expected head and actual diff lines.",
  {
    ...pr,
    expectedHeadSha: sha,
    body: text.optional(),
    event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]).optional(),
    comments: z.array(inline).max(100).optional(),
  },
  { write: true },
);
define(
  "submit_review",
  "Submit an existing pending review after rechecking its commit and current head",
  {
    ...pr,
    review_id: id,
    expectedHeadSha: sha,
    body: text.optional(),
    event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]),
  },
  { write: true },
);
write(
  "edit_review",
  "Edit a review body",
  `PUT ${R}/pulls/{pull_number}/reviews/{review_id}`,
  { ...pr, review_id: id, body: text },
);
write(
  "delete_pending_review",
  "Delete a pending review",
  `DELETE ${R}/pulls/{pull_number}/reviews/{review_id}`,
  { ...pr, review_id: id },
);
define(
  "add_review_comment",
  "Add an inline comment anchored to an actual diff line and current head",
  { ...pr, expectedHeadSha: sha, ...inline.shape },
  { write: true },
);
write(
  "reply_review_comment",
  "Reply to an inline review comment",
  `POST ${R}/pulls/{pull_number}/comments/{comment_id}/replies`,
  { ...pr, comment_id: id, body: text },
);
write(
  "edit_review_comment",
  "Edit an inline review comment body",
  `PATCH ${R}/pulls/comments/{comment_id}`,
  { ...comment, body: text },
);
write(
  "delete_review_comment",
  "Delete an inline review comment",
  `DELETE ${R}/pulls/comments/{comment_id}`,
  comment,
);
define(
  "merge_pr",
  "Merge with expected reviewed head SHA, respecting server checks and branch rules. Does not delete the branch.",
  {
    ...pr,
    expectedHeadSha: sha,
    merge_method: z.enum(["merge", "squash", "rebase"]),
    commit_title: name.optional(),
    commit_message: text.optional(),
  },
  { write: true },
);
read(
  "list_check_runs",
  "Read check runs at a ref",
  `GET ${R}/commits/{ref}/check-runs`,
  { repo, ref: name },
  "check_runs",
);
read(
  "list_check_suites",
  "Read check suites",
  `GET ${R}/commits/{ref}/check-suites`,
  { repo, ref: name },
  "check_suites",
);
read(
  "check_annotations",
  "Read check annotations",
  `GET ${R}/check-runs/{check_run_id}/annotations`,
  { repo, check_run_id: id },
  true,
);
read(
  "commit_status",
  "Read combined commit status",
  `GET ${R}/commits/{ref}/status`,
  { repo, ref: name },
  "statuses",
);
read(
  "list_workflows",
  "Discover workflows",
  `GET ${R}/actions/workflows`,
  { repo },
  "workflows",
);
read(
  "read_workflow",
  "Read workflow metadata; read its YAML to discover dispatch inputs",
  `GET ${R}/actions/workflows/{workflow_id}`,
  { repo, workflow_id: name.or(id) },
);
read(
  "list_runs",
  "List workflow runs",
  `GET ${R}/actions/runs`,
  {
    repo,
    branch: name.optional(),
    event: name.optional(),
    status: name.optional(),
    actor: name.optional(),
    created: name.optional(),
    head_sha: sha.optional(),
  },
  "workflow_runs",
);
read(
  "read_run",
  "Read workflow run and attempt",
  `GET ${R}/actions/runs/{run_id}`,
  { repo, run_id: id },
);
read(
  "list_jobs",
  "Read workflow jobs and steps",
  `GET ${R}/actions/runs/{run_id}/jobs`,
  { repo, run_id: id, filter: z.enum(["latest", "all"]).optional() },
  "jobs",
);
read("read_job", "Read one workflow job", `GET ${R}/actions/jobs/{job_id}`, {
  repo,
  job_id: id,
});
read(
  "attempt_jobs",
  "Read jobs from a particular attempt",
  `GET ${R}/actions/runs/{run_id}/attempts/{attempt_number}/jobs`,
  { repo, run_id: id, attempt_number: id },
  "jobs",
);
define(
  "dispatch_workflow",
  "Run a workflow on a discovered ref with validated workflow_dispatch inputs. Executes code and consumes resources; accepted is not completion.",
  {
    repo,
    workflow_id: name.or(id),
    ref: name,
    inputs: z.record(name, z.union([text, z.boolean(), z.number()])).optional(),
  },
  { write: true },
);
for (const [key, suffix] of [
  ["rerun_run", "rerun"],
  ["rerun_failed_jobs", "rerun-failed-jobs"],
  ["cancel_run", "cancel"],
])
  write(
    key,
    "Schedule workflow action; may execute code and consume resources",
    `POST ${R}/actions/runs/{run_id}/${suffix}`,
    { repo, run_id: id },
    undefined,
    true,
  );
write(
  "rerun_job",
  "Rerun a selected job and dependent jobs; executes code and consumes resources",
  `POST ${R}/actions/jobs/{job_id}/rerun`,
  { repo, job_id: id, enable_debug_logging: z.boolean().optional() },
  undefined,
  true,
);
write(
  "delete_run",
  "Delete workflow run and its associated logs",
  `DELETE ${R}/actions/runs/{run_id}`,
  { repo, run_id: id },
);
read(
  "list_artifacts",
  "List retained Actions artifacts",
  `GET ${R}/actions/artifacts`,
  { repo, name: name.optional() },
  "artifacts",
);
read(
  "run_artifacts",
  "List artifacts for one run",
  `GET ${R}/actions/runs/{run_id}/artifacts`,
  { repo, run_id: id },
  "artifacts",
);
read(
  "read_artifact",
  "Read artifact metadata and expiration",
  `GET ${R}/actions/artifacts/{artifact_id}`,
  { repo, artifact_id: id },
);
write(
  "delete_artifact",
  "Delete an Actions artifact",
  `DELETE ${R}/actions/artifacts/{artifact_id}`,
  { repo, artifact_id: id },
);
read(
  "list_deployments",
  "Read deployments",
  `GET ${R}/deployments`,
  { repo, ref: name.optional(), environment: name.optional() },
  true,
);
read(
  "deployment_statuses",
  "Read deployment status history",
  `GET ${R}/deployments/{deployment_id}/statuses`,
  { repo, deployment_id: id },
  true,
);
read(
  "list_environments",
  "Read environments without changing protections",
  `GET ${R}/environments`,
  { repo },
  "environments",
);
read("list_releases", "List releases", `GET ${R}/releases`, { repo }, true);
read(
  "read_release",
  "Read release metadata and asset identities",
  `GET ${R}/releases/{release_id}`,
  { repo, release_id: id },
);
read(
  "release_by_tag",
  "Read a release by tag",
  `GET ${R}/releases/tags/{tag}`,
  { repo, tag: name },
);
read(
  "list_release_assets",
  "Read release assets",
  `GET ${R}/releases/{release_id}/assets`,
  { repo, release_id: id },
  true,
);
define("generate_release_notes", "Generate release notes without publishing", {
  repo,
  tag_name: name,
  target_commitish: name.optional(),
  previous_tag_name: name.optional(),
  configuration_file_path: filePath.optional(),
});
define(
  "create_release",
  "Create a release for an existing tag; tag creation is a separate operation. Default is draft.",
  {
    repo,
    tag_name: name,
    name: name.optional(),
    body: text.optional(),
    draft: z.boolean().optional(),
    prerelease: z.boolean().optional(),
    make_latest: z.enum(["true", "false", "legacy"]).optional(),
  },
  { write: true },
);
define(
  "update_release",
  "Edit or publish an existing release; cannot implicitly create a tag",
  {
    repo,
    release_id: id,
    tag_name: name.optional(),
    name: name.optional(),
    body: text.optional(),
    draft: z.boolean().optional(),
    prerelease: z.boolean().optional(),
    make_latest: z.enum(["true", "false", "legacy"]).optional(),
  },
  { write: true },
);
write(
  "delete_release",
  "Delete release and its assets; Git tag is preserved",
  `DELETE ${R}/releases/{release_id}`,
  { repo, release_id: id },
);
write(
  "delete_release_asset",
  "Delete a specific release asset",
  `DELETE ${R}/releases/assets/{asset_id}`,
  { repo, asset_id: id },
);
define(
  "upload_release_asset",
  "Upload a local file to a release. Duplicate asset names fail; delete an old asset explicitly before replacing.",
  {
    repo,
    release_id: id,
    path: text,
    name: name.optional(),
    contentType: name.optional(),
    expectedFile: text.optional(),
  },
  { write: true },
);
write(
  "create_tag",
  "Create a lightweight Git tag at an exact commit SHA, separately from release creation",
  `POST ${R}/git/refs`,
  { repo, tag: name, sha },
);
define(
  "delete_tag",
  "Delete an exact Git tag after comparing its current object SHA",
  { repo, tag: name, expectedSha: sha },
  { write: true },
);
for (const [key, fields, description] of [
  [
    "download_file",
    { repo, path: filePath, ref: name },
    "Download repository file at a ref",
  ],
  [
    "download_artifact",
    { repo, artifact_id: id },
    "Download artifact ZIP without extracting or executing",
  ],
  ["download_release_asset", { repo, asset_id: id }, "Download release asset"],
  [
    "download_run_logs",
    { repo, run_id: id },
    "Download complete run log ZIP without extracting",
  ],
  [
    "read_job_logs",
    { repo, job_id: id },
    "Retrieve job log as a bounded artifact; read_job identifies failed steps",
  ],
] as const)
  define(key, description, { ...fields, destination: destination.optional() });
read(
  "list_notifications",
  "Read personal notifications",
  "GET /notifications",
  {
    all: z.boolean().optional(),
    participating: z.boolean().optional(),
    since: z.iso.datetime().optional(),
    before: z.iso.datetime().optional(),
  },
  true,
);
write(
  "mark_notification_read",
  "Mark notification thread read",
  "PATCH /notifications/threads/{thread_id}",
  { thread_id: name },
);
write(
  "mark_notification_done",
  "Mark notification thread done",
  "DELETE /notifications/threads/{thread_id}",
  { thread_id: name },
);
read(
  "read_thread_subscription",
  "Read notification subscription",
  "GET /notifications/threads/{thread_id}/subscription",
  { thread_id: name },
);
write(
  "set_thread_subscription",
  "Subscribe or ignore a notification thread",
  "PUT /notifications/threads/{thread_id}/subscription",
  { thread_id: name, ignored: z.boolean().optional() },
);
write(
  "delete_thread_subscription",
  "Remove notification thread subscription",
  "DELETE /notifications/threads/{thread_id}/subscription",
  { thread_id: name },
);
read(
  "read_subscription",
  "Read repository watch subscription",
  `GET ${R}/subscription`,
  { repo },
);
write(
  "set_subscription",
  "Set repository watch subscription",
  `PUT ${R}/subscription`,
  { repo, subscribed: z.boolean().optional(), ignored: z.boolean().optional() },
);
write("delete_subscription", "Unwatch repository", `DELETE ${R}/subscription`, {
  repo,
});
write(
  "star_repository",
  "Star repository",
  "PUT /user/starred/{owner}/{repo}",
  { repo },
);
write(
  "unstar_repository",
  "Unstar repository",
  "DELETE /user/starred/{owner}/{repo}",
  { repo },
);
define(
  "capabilities",
  "List implemented operations and deployment/permission caveats",
  {},
);
define("describe_operation", "Discover exact operation schema before use", {
  name,
});
define("continue", "Continue a previous bounded result in this session", {
  continuation: z.uuid(),
});
define("read_operation", "Read a prior write outcome in this session", {
  operationId: z.string().regex(/^[a-f0-9]{64}$/),
});
define(
  "preview_batch",
  "Preview exact bounded issue triage targets without writing",
  {
    repo,
    issue_numbers: z.array(id).min(1).max(50),
    action: z.enum([
      "add_labels",
      "add_assignees",
      "close_issue",
      "update_issue",
    ]),
    changes: z
      .object({
        labels: names.optional(),
        assignees: names.optional(),
        milestone: id.nullable().optional(),
      })
      .strict()
      .optional(),
  },
);
define(
  "batch",
  "Apply a previously prepared issue triage batch; preserves successful steps and reports each item",
  { preview: z.uuid() },
  { write: true },
);
