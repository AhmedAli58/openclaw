export function extractLastJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const lastClose = trimmed.lastIndexOf("}");
  if (lastClose === -1) {
    return null;
  }

  // Try rightmost object boundaries first so we return the final JSON object
  // even when output includes nested objects or trailing non-JSON text.
  for (let end = lastClose; end >= 0; end = trimmed.lastIndexOf("}", end - 1)) {
    for (
      let start = trimmed.lastIndexOf("{", end);
      start >= 0;
      start = trimmed.lastIndexOf("{", start - 1)
    ) {
      const slice = trimmed.slice(start, end + 1);
      try {
        return JSON.parse(slice);
      } catch {
        // keep searching for the last valid object in the output
      }
    }
  }
  return null;
}

export function extractGeminiResponse(raw: string): string | null {
  const payload = extractLastJsonObject(raw);
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const response = (payload as { response?: unknown }).response;
  if (typeof response !== "string") {
    return null;
  }
  const trimmed = response.trim();
  return trimmed || null;
}
