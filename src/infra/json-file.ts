import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function loadJsonFile(pathname: string): unknown {
  try {
    if (!fs.existsSync(pathname)) {
      return undefined;
    }
    const raw = fs.readFileSync(pathname, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function saveJsonFile(pathname: string, data: unknown) {
  const dir = path.dirname(pathname);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmpPath = `${pathname}.${randomUUID()}.tmp`;
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  fs.writeFileSync(tmpPath, payload, "utf8");
  try {
    fs.chmodSync(tmpPath, 0o600);
  } catch {
    // best-effort; keep going on platforms where chmod is unavailable/restricted
  }

  try {
    fs.renameSync(tmpPath, pathname);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }

  try {
    fs.chmodSync(pathname, 0o600);
  } catch {
    // best-effort; keep file persisted even if mode update fails
  }
}
