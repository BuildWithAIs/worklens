import { expect, test } from "vitest";
import i18n from "../src/renderer/src/i18n";
import { evaluateConnectorForm } from "../src/renderer/src/components/worklens/connectors/connector-validation";

const t = i18n.getFixedT("en");
const saved = {
  configured: true,
  url: "https://example.test/jira/",
  deployment: "cloud",
  email: "user@example.test",
  tokenType: "scoped",
  cloudId: "saved-id",
};

test("Jira retains optional Cloud ID discovery while Confluence requires it", () => {
  const form = { ...saved, cloudId: "", token: "" };
  const jira = evaluateConnectorForm("jira", form, saved, t);
  const confluence = evaluateConnectorForm("confluence", form, saved, t);
  expect(jira.canReuseToken).toBe(true);
  expect(jira.errors).toEqual({});
  expect(confluence.canReuseToken).toBe(false);
  expect(confluence.errors.cloudId).toBeTruthy();
  expect(confluence.errors.token).toBeTruthy();
});

test("saved credentials cannot satisfy a changed site or account", () => {
  for (const patch of [
    { url: "https://other.test" },
    { email: "other@example.test" },
  ]) {
    const result = evaluateConnectorForm(
      "jira",
      { ...saved, ...patch, token: "" },
      saved,
      t,
    );
    expect(result.canReuseToken).toBe(false);
    expect(result.missing).toBe(true);
    expect(result.errors.token).toBeTruthy();
  }
});

test("a typed token remains valid when the site changes", () => {
  const result = evaluateConnectorForm(
    "jira",
    { ...saved, url: "https://other.test", token: "new-token" },
    saved,
    t,
  );
  expect(result.canReuseToken).toBe(false);
  expect(result.missing).toBe(false);
  expect(result.errors).toEqual({});
});

test("complete but invalid input stays enabled until explicit validation", () => {
  const result = evaluateConnectorForm(
    "github",
    { url: "https://github.com/repo", token: "token" },
    undefined,
    t,
  );
  expect(result.missing).toBe(false);
  expect(result.errors.url).toBeTruthy();
});
