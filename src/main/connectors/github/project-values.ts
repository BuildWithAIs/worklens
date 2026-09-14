import { type Context, graphPage } from "./context";
import { ServiceError, type Json } from "./http";

const scalarSelections: Record<string, string> = {
  ProjectV2ItemFieldTextValue: "text",
  ProjectV2ItemFieldNumberValue: "number",
  ProjectV2ItemFieldDateValue: "date",
  ProjectV2ItemFieldSingleSelectValue: "name optionId",
  ProjectV2ItemFieldIterationValue: "iterationId title startDate duration",
  ProjectV2ItemFieldMilestoneValue: "milestone{id number title url}",
  ProjectV2ItemFieldRepositoryValue: "repository{id nameWithOwner url}",
};
const collections: Record<string, [string, string]> = {
  ProjectV2ItemFieldUserValue: ["users", "id login name url"],
  ProjectV2ItemFieldLabelValue: ["labels", "id name color description"],
  ProjectV2ItemFieldPullRequestValue: [
    "pullRequests",
    "id number title url repository{nameWithOwner}",
  ],
  ProjectV2ItemFieldReviewerValue: [
    "reviewers",
    "__typename ... on User{id login url} ... on Team{id name slug url} ... on Bot{id login url} ... on Mannequin{id login url}",
  ],
};

export async function projectItemValues(ctx: Context, request: Json) {
  const single = request.fieldName !== undefined;
  const selection = [
    "__typename",
    ...Object.entries(scalarSelections).map(
      ([type, fields]) =>
        `... on ${type}{${fields} field{... on ProjectV2FieldCommon{id name}}}`,
    ),
    ...Object.entries(collections).map(
      ([type, [field, fields]]) =>
        `... on ${type}{field{... on ProjectV2FieldCommon{id name}} ${field}(first:50${single ? ",after:$after" : ""}){nodes{${fields}}pageInfo{hasNextPage endCursor}}}`,
    ),
  ].join(" ");
  const value = await ctx.http.graphql(
    single
      ? `query($id:ID!,$fieldName:String!,$after:String){node(id:$id){... on ProjectV2Item{fieldValueByName(name:$fieldName){${selection}}}}}`
      : `query($id:ID!,$after:String){node(id:$id){... on ProjectV2Item{fieldValues(first:50,after:$after){nodes{${selection}}pageInfo{hasNextPage endCursor}}}}}`,
    {
      id: request.itemId,
      after: request.after,
      ...(single ? { fieldName: request.fieldName } : {}),
    },
  );
  if (single && !value.node?.fieldValueByName)
    throw new ServiceError(
      "not_found_or_forbidden",
      "无法读取指定 Project 字段值",
    );
  const connection = single
    ? { nodes: [value.node.fieldValueByName], pageInfo: { hasNextPage: false } }
    : value.node?.fieldValues;
  const result = await graphPage(ctx, request, connection);
  const fieldContinuations: Json[] = [];
  const unsupportedFields: Json[] = [];
  for (const field of connection.nodes) {
    if (
      !Object.hasOwn(scalarSelections, field.__typename) &&
      !Object.hasOwn(collections, field.__typename)
    ) {
      unsupportedFields.push({ type: field.__typename, field: field.field });
      continue;
    }
    const nested = collections[field.__typename];
    if (nested) {
      if (!field.field?.name)
        throw new ServiceError(
          "invalid_response",
          "Project 字段缺少名称，无法续读",
        );
      const page = await graphPage(
        ctx,
        { ...request, fieldName: field.field.name },
        field[nested[0]],
      );
      if (page.continuation)
        fieldContinuations.push({
          fieldId: field.field.id,
          fieldName: field.field.name,
          continuation: page.continuation,
        });
    }
  }
  return {
    ...result,
    fieldsPageComplete: result.complete,
    complete:
      result.complete &&
      !fieldContinuations.length &&
      !unsupportedFields.length,
    fieldContinuations,
    unsupportedFields,
  };
}
