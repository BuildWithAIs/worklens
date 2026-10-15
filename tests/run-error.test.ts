import { describe, expect, test } from "vitest";
import { parseRunError } from "../src/shared/run-error";

describe("parseRunError", () => {
  test.each([
    {
      raw: '503: {"message":"Service is too busy. We advise users to temporarily switch to alternative LLM API service providers. (request_id: 40ee2127-9214-448d-a299-5c0b7e1d93fa)"}',
      kind: "unavailable",
      status: 503,
      detail:
        "Service is too busy. We advise users to temporarily switch to alternative LLM API service providers.",
    },
    {
      raw: '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CTqv8NfX2kJ4bP7mR9aZs"}',
      kind: "unavailable",
      status: 529,
    },
    {
      raw: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit for your organization of 30,000 input tokens per minute."}}',
      kind: "rate_limit",
      status: 429,
      detail:
        "This request would exceed the rate limit for your organization of 30,000 input tokens per minute.",
    },
    {
      raw: '{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}',
      kind: "rate_limit",
      status: 429,
      detail: "Resource has been exhausted (e.g. check quota).",
    },
    {
      raw: '500: {"error":{"message":"The server had an error while processing your request.","type":"server_error"}}',
      kind: "server",
      status: 500,
      detail: "The server had an error while processing your request.",
    },
    { raw: "502 status code (no body)", kind: "server", status: 502 },
    { raw: "Connection error.", kind: "network" },
    { raw: "Error: getaddrinfo ENOTFOUND api.example.com", kind: "network" },
    { raw: "Request timed out.", kind: "timeout" },
    { raw: "Connection timed out", kind: "timeout" },
    { raw: "terminated", kind: "interrupted" },
    {
      raw: "CHAT_IMAGE_TIMEOUT",
      kind: "image_processing",
      code: "CHAT_IMAGE_TIMEOUT",
    },
    {
      raw: "CHAT_IMAGE_REQUEST",
      kind: "image_limit",
      code: "CHAT_IMAGE_REQUEST",
    },
    {
      raw: '401: {"error":{"message":"Incorrect API key provided: [redacted].","type":"invalid_request_error","code":"invalid_api_key"}}',
      kind: "auth",
      status: 401,
      detail: "Incorrect API key provided: [redacted].",
    },
    {
      raw: "401 Invalid API key",
      kind: "auth",
      status: 401,
      detail: "Invalid API key",
    },
    {
      raw: '402: {"error":{"message":"Insufficient Balance","type":"unknown_error"}}',
      kind: "quota",
      status: 402,
      detail: "Insufficient Balance",
    },
    {
      raw: "429 You exceeded your current quota, please check your plan and billing details.",
      kind: "quota",
      status: 429,
      detail:
        "You exceeded your current quota, please check your plan and billing details.",
    },
    {
      raw: '404: {"error":{"message":"The model `gpt-x` does not exist or you do not have access to it.","code":"model_not_found"}}',
      kind: "model_missing",
      status: 404,
      detail:
        "The model `gpt-x` does not exist or you do not have access to it.",
    },
    {
      raw: '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 213462 tokens > 200000 maximum"}}',
      kind: "context_overflow",
      status: 400,
      detail: "prompt is too long: 213462 tokens > 200000 maximum",
    },
    {
      raw: '400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.4.content.1.image.source.base64: image exceeds 5 MB maximum: 7340032 bytes > 5242880 bytes"}}',
      kind: "image_limit",
      status: 400,
      detail: "image exceeds 5 MB maximum: 7340032 bytes > 5242880 bytes",
    },
    {
      raw: `400: {"error":{"message":"Unsupported value: 'reasoning_effort' does not support 'high' with this model.","param":"reasoning_effort"}}`,
      kind: "rejected",
      status: 400,
      detail:
        "Unsupported value: 'reasoning_effort' does not support 'high' with this model.",
    },
    { raw: "Provider finish_reason: content_filter", kind: "content_filter" },
    { raw: "The model refused to complete the request", kind: "refusal" },
    { raw: "", kind: "unknown" },
    { raw: "模型请求失败", kind: "unknown" },
    {
      raw: "Provider rejected the request",
      kind: "unknown",
      detail: "Provider rejected the request",
    },
  ])("$raw", ({ raw, ...expected }) => {
    const result = parseRunError(raw);
    expect(result).toMatchObject({ raw, ...expected });
    if (!("detail" in expected) && !result.code)
      expect(result.detail).toBeUndefined();
  });

  test("reads the message from a truncated body", () => {
    const result = parseRunError(
      '503: {"message":"Service is too busy and the rest... [truncated 120 chars]',
    );
    expect(result).toMatchObject({
      kind: "unavailable",
      detail: "Service is too busy and the rest…",
    });
  });

  test("does not treat throttling as context overflow", () => {
    expect(
      parseRunError("ThrottlingException: Too many tokens, please wait").kind,
    ).toBe("rate_limit");
  });
});
