import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquireFileLock, tryAcquireFileLockSync, withFileLock } from "./file-lock.js";

describe("filesystem locks", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeLockPath(): string {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "skilljack-lock-"));
    return path.join(tempDir, "cache.lock");
  }

  it("allows only one owner and releases idempotently", () => {
    const lockPath = makeLockPath();
    const release = tryAcquireFileLockSync(lockPath);
    expect(release).toBeTypeOf("function");
    expect(tryAcquireFileLockSync(lockPath)).toBeNull();
    release?.();
    release?.();
    const nextRelease = tryAcquireFileLockSync(lockPath);
    expect(nextRelease).toBeTypeOf("function");
    nextRelease?.();
  });

  it("recovers a lock whose local owner process no longer exists", () => {
    const lockPath = makeLockPath();
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({
      pid: 2147483647,
      hostname: os.hostname(),
      startedAt: Date.now() - 60_000,
      token: "dead-owner",
    }));
    const release = tryAcquireFileLockSync(lockPath);
    expect(release).toBeTypeOf("function");
    release?.();
  });

  it("waits for a live owner and then acquires the lock", async () => {
    const lockPath = makeLockPath();
    const release = tryAcquireFileLockSync(lockPath);
    let acquired = false;
    const waiting = acquireFileLock(lockPath, { timeoutMs: 1000, retryMs: 5 }).then((unlock) => {
      acquired = true;
      unlock();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(acquired).toBe(false);
    release?.();
    await waiting;
    expect(acquired).toBe(true);
  });

  it("always releases the lock when the operation throws", async () => {
    const lockPath = makeLockPath();
    await expect(withFileLock(lockPath, async () => {
      throw new Error("operation failed");
    })).rejects.toThrow("operation failed");
    const release = tryAcquireFileLockSync(lockPath);
    expect(release).toBeTypeOf("function");
    release?.();
  });
});
