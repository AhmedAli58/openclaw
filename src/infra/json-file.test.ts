import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadJsonFile, saveJsonFile } from "./json-file.js";

function withTempDirSync<T>(prefix: string, run: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadJsonFile", () => {
  it("returns undefined for missing files", () => {
    withTempDirSync("openclaw-json-file-", (dir) => {
      const pathname = path.join(dir, "missing.json");
      expect(loadJsonFile(pathname)).toBeUndefined();
    });
  });

  it("returns undefined for invalid JSON", () => {
    withTempDirSync("openclaw-json-file-", (dir) => {
      const pathname = path.join(dir, "invalid.json");
      fs.writeFileSync(pathname, "{bad json");
      expect(loadJsonFile(pathname)).toBeUndefined();
    });
  });
});

describe("saveJsonFile", () => {
  it("creates the target directory and writes JSON", () => {
    withTempDirSync("openclaw-json-file-", (dir) => {
      const pathname = path.join(dir, "nested", "state.json");
      saveJsonFile(pathname, { ok: true, count: 2 });
      expect(loadJsonFile(pathname)).toEqual({ ok: true, count: 2 });
    });
  });

  it("cleans up temp files and preserves existing file when rename fails", () => {
    withTempDirSync("openclaw-json-file-", (dir) => {
      const pathname = path.join(dir, "state.json");
      saveJsonFile(pathname, { value: "old" });

      const originalRename = fs.renameSync;
      const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((oldPath, newPath) => {
        if (newPath === pathname) {
          throw new Error("simulated rename failure");
        }
        return originalRename(oldPath, newPath);
      });

      expect(() => saveJsonFile(pathname, { value: "new" })).toThrow("simulated rename failure");
      expect(loadJsonFile(pathname)).toEqual({ value: "old" });

      const leftovers = fs
        .readdirSync(dir)
        .filter((entry) => entry.startsWith("state.json.") && entry.endsWith(".tmp"));
      expect(leftovers).toHaveLength(0);
      expect(renameSpy).toHaveBeenCalled();
    });
  });
});
