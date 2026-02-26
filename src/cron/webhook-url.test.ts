import { describe, expect, it } from "vitest";
import { normalizeHttpWebhookUrl } from "./webhook-url.js";

describe("normalizeHttpWebhookUrl", () => {
  it("accepts http(s) URLs and returns canonical output", () => {
    expect(normalizeHttpWebhookUrl(" https://Example.com/hooks?id=1 ")).toBe(
      "https://example.com/hooks?id=1",
    );
    expect(normalizeHttpWebhookUrl("http://example.com")).toBe("http://example.com/");
  });

  it("rejects non-string, blank, and non-http protocols", () => {
    expect(normalizeHttpWebhookUrl(undefined)).toBeNull();
    expect(normalizeHttpWebhookUrl("   ")).toBeNull();
    expect(normalizeHttpWebhookUrl("ftp://example.com/hook")).toBeNull();
  });

  it("rejects credentialed webhook URLs", () => {
    expect(normalizeHttpWebhookUrl("https://user:secret@example.com/hook")).toBeNull();
    expect(normalizeHttpWebhookUrl("https://user@example.com/hook")).toBeNull();
  });

  it("rejects fragment-bearing webhook URLs", () => {
    expect(normalizeHttpWebhookUrl("https://example.com/hook#token")).toBeNull();
  });
});
