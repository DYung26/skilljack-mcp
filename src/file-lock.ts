/**
 * Cross-process filesystem locks for shared Skilljack caches.
 *
 * Lock acquisition uses atomic mkdir. The owner record lets another process
 * distinguish a live owner from a crashed process and safely recover stale
 * locks. Locks are intended for processes sharing one local filesystem.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

interface LockOwner {
  pid: number;
  hostname: string;
  startedAt: number;
  token: string;
}

export interface FileLockOptions {
  /** Maximum time to wait for another process to release the lock. */
  timeoutMs?: number;
  /** Delay between acquisition attempts. */
  retryMs?: number;
  /** How long to trust an owner record from another host. */
  remoteStaleMs?: number;
}

const OWNER_FILE = "owner.json";
const OWNER_WRITE_GRACE_MS = 30_000;
const DEFAULT_REMOTE_STALE_MS = 10 * 60_000;

function readOwner(lockPath: string): LockOwner | null {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(lockPath, OWNER_FILE), "utf-8"),
    );
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("pid" in parsed) ||
      !Number.isInteger(parsed.pid) ||
      !("hostname" in parsed) ||
      typeof parsed.hostname !== "string" ||
      !("startedAt" in parsed) ||
      typeof parsed.startedAt !== "number" ||
      !("token" in parsed) ||
      typeof parsed.token !== "string"
    ) {
      return null;
    }
    return parsed as LockOwner;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isStale(lockPath: string, owner: LockOwner | null, remoteStaleMs: number): boolean {
  const now = Date.now();
  if (!owner) {
    try {
      return now - fs.statSync(lockPath).mtimeMs > OWNER_WRITE_GRACE_MS;
    } catch {
      return true;
    }
  }

  if (owner.hostname === os.hostname()) {
    return !isProcessAlive(owner.pid);
  }

  return now - owner.startedAt > remoteStaleMs;
}

/**
 * Try to acquire a lock synchronously. Returns a release function on success,
 * or null when another live process owns it.
 */
export function tryAcquireFileLockSync(
  lockPath: string,
  options: Pick<FileLockOptions, "remoteStaleMs"> = {},
): (() => void) | null {
  const absolutePath = path.resolve(lockPath);
  const remoteStaleMs = options.remoteStaleMs ?? DEFAULT_REMOTE_STALE_MS;
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });

  try {
    fs.mkdirSync(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }

    const owner = readOwner(absolutePath);
    if (!isStale(absolutePath, owner, remoteStaleMs)) {
      return null;
    }

    // Rename first so only one contender can claim the stale directory.
    const stalePath = `${absolutePath}.stale-${process.pid}-${randomUUID()}`;
    try {
      fs.renameSync(absolutePath, stalePath);
      fs.rmSync(stalePath, { recursive: true, force: true });
    } catch (renameError) {
      const code = (renameError as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") {
        throw renameError;
      }
      return null;
    }

    try {
      fs.mkdirSync(absolutePath);
    } catch (acquireError) {
      if ((acquireError as NodeJS.ErrnoException).code === "EEXIST") {
        return null;
      }
      throw acquireError;
    }
  }

  const owner: LockOwner = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: Date.now(),
    token: randomUUID(),
  };

  try {
    fs.writeFileSync(
      path.join(absolutePath, OWNER_FILE),
      JSON.stringify(owner),
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    fs.rmSync(absolutePath, { recursive: true, force: true });
    throw error;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;

    const currentOwner = readOwner(absolutePath);
    if (currentOwner?.token !== owner.token) return;

    fs.rmSync(absolutePath, { recursive: true, force: true });
  };
}

/**
 * Acquire a lock asynchronously, waiting for a live owner to finish.
 */
export async function acquireFileLock(
  lockPath: string,
  options: FileLockOptions = {},
): Promise<() => void> {
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const retryMs = options.retryMs ?? 150;
  const startedAt = Date.now();

  while (true) {
    const release = tryAcquireFileLockSync(lockPath, options);
    if (release) return release;

    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`Timed out waiting for filesystem lock: ${lockPath}`);
    }

    await new Promise<void>((resolve) => setTimeout(resolve, retryMs));
  }
}

/**
 * Run an operation while holding a cross-process filesystem lock.
 */
export async function withFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const release = await acquireFileLock(lockPath, options);
  try {
    return await operation();
  } finally {
    release();
  }
}
