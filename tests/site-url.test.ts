import { expect, test } from "vitest";
import { completeSiteUrl } from "../src/renderer/src/components/worklens/connectors/site-url";

test.each([
  ["github.com", "https://github.com"],
  ["jira.example.com/jira", "https://jira.example.com/jira"],
  [
    " wiki.example.com:8443/confluence ",
    "https://wiki.example.com:8443/confluence",
  ],
  ["192.168.1.20/jira", "https://192.168.1.20/jira"],
])("completes %s", (value, expected) =>
  expect(completeSiteUrl(value)).toBe(expected),
);
test.each([
  "",
  "abc",
  "hello world",
  "https://jira",
  "http://jira.example.com/jira",
  "https://github.com",
  "ftp://example.com",
  "javascript:alert(1)",
  "mailto:a@example.com",
  "example..com",
  "-example.com",
  "example.com:bad",
  "example.com:99999",
  "//example.com",
  "user:password@example.com",
  "example.com?x=1",
  "example.com/#fragment",
  "127.1",
  "999.999.999.999",
  "example.com\\path",
])("leaves %s unchanged", (value) =>
  expect(completeSiteUrl(value)).toBe(value),
);
