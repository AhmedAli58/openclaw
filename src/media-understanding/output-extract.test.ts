import { describe, expect, it } from "vitest";
import { extractGeminiResponse, extractLastJsonObject } from "./output-extract.js";

describe("extractLastJsonObject", () => {
  it("returns null when no JSON object is present", () => {
    expect(extractLastJsonObject("plain text only")).toBeNull();
  });

  it("extracts a nested JSON object from noisy output", () => {
    const raw = `log line 1
log line 2
{"outer":{"inner":{"value":42}}}
done`;
    expect(extractLastJsonObject(raw)).toEqual({
      outer: { inner: { value: 42 } },
    });
  });

  it("returns the last JSON object when multiple objects exist", () => {
    const raw = `{"response":"first"}
ignored
{"response":"second","meta":{"ok":true}}`;
    expect(extractLastJsonObject(raw)).toEqual({
      response: "second",
      meta: { ok: true },
    });
  });
});

describe("extractGeminiResponse", () => {
  it("extracts and trims the response from the last JSON object", () => {
    const raw = `prefix {"response":"first"} trailing
{"response":"  final answer  "}`;
    expect(extractGeminiResponse(raw)).toBe("final answer");
  });
});
