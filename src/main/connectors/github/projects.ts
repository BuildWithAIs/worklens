import { projectItemValues } from "./project-values";
import { z } from "zod";
import { define, repo, id, name, text } from "./catalog";
import { type Context, resource, node, graphWrite, graphPage } from "./context";
import { ServiceError, type Json } from "./http";

const project = {
  owner: name,
  ownerType: z.enum(["organization", "user"]),
  number: id,
};
const item = { ...project, itemId: name };
define("list_projects", "List accessible Projects for an exact owner", {
  owner: name,
  ownerType: z.enum(["organization", "user"]),
  after: text.optional(),
});
define("read_project", "Read a Project and its permissions", project);
define(
  "project_fields",
  "Discover project fields, select options and iterations",
  { ...project, after: text.optional() },
);
define("project_views", "Read project views exposed by the API", {
  ...project,
  after: text.optional(),
});
define(
  "project_items",
  "Read project items and content identities; field values paginate separately",
  { ...project, after: text.optional() },
);
define(
  "project_item_fields",
  "Read project item field values. Follow continuation for more fields and fieldContinuations for nested lists. Unsupported types are reported explicitly.",
  {
    ...item,
    fieldName: name.optional(),
    after: text.optional(),
  },
);
define(
  "add_project_item",
  "Add an issue or PR to a Project",
  { ...project, repo, issue_number: id },
  { write: true },
);
for (const operation of [
  "remove_project_item",
  "archive_project_item",
  "unarchive_project_item",
])
  define(operation, operation.replaceAll("_", " "), item, { write: true });
define(
  "update_project_field",
  "Set a discovered Project field. For select fields use option name; iterations use discovered iteration ID. Issue state is independent.",
  { ...item, field: name, value: z.union([text, z.number()]) },
  { write: true },
);
define(
  "clear_project_field",
  "Clear a discovered Project field",
  { ...item, field: name },
  { write: true },
);
define(
  "create_project_draft",
  "Create a Project draft issue",
  { ...project, title: name, body: text.optional() },
  { write: true },
);
define(
  "edit_project_draft",
  "Edit a Project draft issue",
  { ...item, title: name.optional(), body: text.optional() },
  { write: true },
);
define(
  "convert_project_draft",
  "Convert a Project draft item to an issue in a specified repository",
  { ...item, repo },
  { write: true },
);
const projectSelection =
  "id number title url shortDescription closed viewerCanUpdate";
const fieldSelection =
  "__typename ... on ProjectV2Field{id name dataType} ... on ProjectV2SingleSelectField{id name dataType options{id name}} ... on ProjectV2IterationField{id name dataType configuration{iterations{id title startDate duration} completedIterations{id title startDate duration}}}";
async function getProject(ctx: Context, request: Json) {
  const value = await ctx.http.graphql(
    `query($owner:String!,$number:Int!){${request.ownerType}(login:$owner){projectV2(number:$number){${projectSelection}}}}`,
    { owner: request.owner, number: request.number },
  );
  const project = value[request.ownerType]?.projectV2;
  if (!project)
    throw new ServiceError("not_found_or_forbidden", "无法访问指定 Project");
  return project;
}
async function getItem(ctx: Context, request: Json, project: Json) {
  const item = await node(
    ctx,
    request.itemId,
    "ProjectV2Item",
    "id project{id} content{__typename ... on DraftIssue{id title body}}",
  );
  if (item.project.id !== project.id)
    throw new ServiceError("invalid_target", "条目不属于指定 Project");
  return item;
}
async function fields(ctx: Context, project: Json) {
  const result: Json[] = [];
  let after: string | undefined;
  for (let page = 0; page < 100; page++) {
    const data = await ctx.http.graphql(
      `query($id:ID!,$after:String){node(id:$id){... on ProjectV2{fields(first:100,after:$after){nodes{${fieldSelection}}pageInfo{hasNextPage endCursor}}}}}`,
      { id: project.id, after },
    );
    result.push(...data.node.fields.nodes);
    if (!data.node.fields.pageInfo.hasNextPage) return result;
    after = data.node.fields.pageInfo.endCursor;
  }
  throw new ServiceError("incomplete", "Project 字段过多，无法完整校验");
}
export async function projectOperation(
  ctx: Context,
  request: Json,
): Promise<Json | undefined> {
  if (!request.operation.includes("project")) return;
  if (request.operation === "list_projects") {
    const value = await ctx.http.graphql(
      `query($owner:String!,$after:String){${request.ownerType}(login:$owner){projectsV2(first:50,after:$after){nodes{${projectSelection}}pageInfo{hasNextPage endCursor}}}}`,
      { owner: request.owner, after: request.after },
    );
    return graphPage(ctx, request, value[request.ownerType]?.projectsV2);
  }
  const project = await getProject(ctx, request);
  if (request.operation === "read_project") return project;
  if (
    ["project_fields", "project_views", "project_items"].includes(
      request.operation,
    )
  ) {
    const field =
      request.operation === "project_fields"
        ? "fields"
        : request.operation === "project_views"
          ? "views"
          : "items";
    const selection =
      field === "fields"
        ? fieldSelection
        : field === "views"
          ? "id name number layout filter"
          : "id type isArchived content{__typename ... on Issue{id number title url repository{nameWithOwner}} ... on PullRequest{id number title url repository{nameWithOwner}} ... on DraftIssue{id title body}}";
    const value = await ctx.http.graphql(
      `query($id:ID!,$after:String){node(id:$id){... on ProjectV2{${field}(first:50,after:$after){nodes{${selection}}pageInfo{hasNextPage endCursor}}}}}`,
      { id: project.id, after: request.after },
    );
    return graphPage(ctx, request, value.node?.[field], { project });
  }
  const item = request.itemId
    ? await getItem(ctx, request, project)
    : undefined;
  if (request.operation === "project_item_fields")
    return projectItemValues(ctx, request);
  if (!project.viewerCanUpdate)
    throw new ServiceError("permission", "当前账号不能修改此 Project");
  const input = { projectId: project.id, itemId: request.itemId };
  if (request.operation === "add_project_item") {
    const issue = await resource(ctx, request, "issue");
    return graphWrite(
      ctx,
      "addProjectV2ItemById",
      "AddProjectV2ItemByIdInput",
      { projectId: project.id, contentId: issue.node_id },
      "item{id}",
    );
  }
  const actions: Record<string, [string, string, string]> = {
    remove_project_item: [
      "deleteProjectV2Item",
      "DeleteProjectV2ItemInput",
      "deletedItemId",
    ],
    archive_project_item: [
      "archiveProjectV2Item",
      "ArchiveProjectV2ItemInput",
      "item{id isArchived}",
    ],
    unarchive_project_item: [
      "unarchiveProjectV2Item",
      "UnarchiveProjectV2ItemInput",
      "item{id isArchived}",
    ],
  };
  if (actions[request.operation]) {
    const [field, type, selection] = actions[request.operation];
    return graphWrite(ctx, field, type, input, selection);
  }
  if (
    ["update_project_field", "clear_project_field"].includes(request.operation)
  ) {
    const matches = (await fields(ctx, project)).filter(
      (f) => f.id === request.field || f.name === request.field,
    );
    if (matches.length !== 1)
      throw new ServiceError(
        "invalid_target",
        "Project 字段不存在或名称不唯一，请使用发现的字段 ID",
      );
    const field = matches[0];
    if (request.operation === "clear_project_field")
      return graphWrite(
        ctx,
        "clearProjectV2ItemFieldValue",
        "ClearProjectV2ItemFieldValueInput",
        { ...input, fieldId: field.id },
        "projectV2Item{id}",
      );
    let value: Json;
    if (field.dataType === "TEXT" && typeof request.value === "string")
      value = { text: request.value };
    else if (field.dataType === "NUMBER" && typeof request.value === "number")
      value = { number: request.value };
    else if (
      field.dataType === "DATE" &&
      z.iso.date().safeParse(request.value).success
    )
      value = { date: request.value };
    else if (field.dataType === "SINGLE_SELECT") {
      const options = field.options.filter(
        (o: Json) => o.id === request.value || o.name === request.value,
      );
      if (options.length !== 1)
        throw new ServiceError("invalid_request", "Project 选项不存在或不唯一");
      value = { singleSelectOptionId: options[0].id };
    } else if (
      field.dataType === "ITERATION" &&
      [
        ...field.configuration.iterations,
        ...field.configuration.completedIterations,
      ].some((i: Json) => i.id === request.value)
    )
      value = { iterationId: request.value };
    else
      throw new ServiceError(
        "invalid_request",
        "此字段类型或值不能通过 Project 字段操作更新；Issue/PR 元数据请使用对应操作",
      );
    return graphWrite(
      ctx,
      "updateProjectV2ItemFieldValue",
      "UpdateProjectV2ItemFieldValueInput",
      { ...input, fieldId: field.id, value },
      "projectV2Item{id}",
    );
  }
  if (request.operation === "create_project_draft")
    return graphWrite(
      ctx,
      "addProjectV2DraftIssue",
      "AddProjectV2DraftIssueInput",
      { projectId: project.id, title: request.title, body: request.body },
      "projectItem{id}",
    );
  if (item?.content?.__typename !== "DraftIssue")
    throw new ServiceError("invalid_target", "此条目不是 Project 草稿");
  if (request.operation === "edit_project_draft")
    return graphWrite(
      ctx,
      "updateProjectV2DraftIssue",
      "UpdateProjectV2DraftIssueInput",
      {
        draftIssueId: item.content.id,
        title: request.title,
        body: request.body,
      },
      "draftIssue{id title}",
    );
  if (request.operation === "convert_project_draft") {
    const repository = await resource(ctx, request, "repository");
    return graphWrite(
      ctx,
      "convertProjectV2DraftIssueItemToIssue",
      "ConvertProjectV2DraftIssueItemToIssueInput",
      { itemId: request.itemId, repositoryId: repository.node_id },
      "item{id content{... on Issue{id number url}}}",
    );
  }
}
