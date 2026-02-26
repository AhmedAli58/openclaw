function isAllowedWebhookProtocol(protocol: string) {
  return protocol === "http:" || protocol === "https:";
}

function hasForbiddenWebhookParts(parsed: URL): boolean {
  if (parsed.username || parsed.password) {
    return true;
  }
  if (parsed.hash) {
    return true;
  }
  return false;
}

export function normalizeHttpWebhookUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (!isAllowedWebhookProtocol(parsed.protocol)) {
      return null;
    }
    if (hasForbiddenWebhookParts(parsed)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}
