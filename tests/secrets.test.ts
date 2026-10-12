import { expect, test } from "vitest";
import { SecretSet } from "../src/main/secrets";

test("redacts raw and JSON-escaped secrets in one pass", () => {
  const secrets = new SecretSet();
  expect(secrets.redact("nothing known")).toBe("nothing known");
  secrets.add('pa"ss\\word');
  secrets.add("token-a.b*c");
  expect(
    secrets.redact(
      `raw pa"ss\\word json ${JSON.stringify('pa"ss\\word')} token-a.b*c token-aXb*c`,
    ),
  ).toBe('raw [redacted] json "[redacted]" [redacted] token-aXb*c');
});

test("replaces the longest overlapping secret whole", () => {
  const secrets = new SecretSet();
  secrets.add("abc");
  secrets.add("abcdef");
  expect(secrets.redact("abcdef abc")).toBe("[redacted] [redacted]");
});

test("ignores empty secrets and recompiles after a new secret", () => {
  const secrets = new SecretSet();
  secrets.add("");
  expect(secrets.redact("value")).toBe("value");
  secrets.add("first-secret");
  expect(secrets.redact("first-secret second-secret")).toBe(
    "[redacted] second-secret",
  );
  secrets.add("second-secret");
  expect(secrets.redact("first-secret second-secret")).toBe(
    "[redacted] [redacted]",
  );
});
