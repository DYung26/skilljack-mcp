import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPollingManager, PollingManager } from "./github-polling.js";
import { GitHubRepoSpec } from "./github-config.js";
import { SyncOptions } from "./github-sync.js";

const { tryAcquireFileLockSync } = vi.hoisted(() => ({
  tryAcquireFileLockSync: vi.fn(() => vi.fn()),
}));

vi.mock("./file-lock.js", () => ({ tryAcquireFileLockSync }));

vi.mock("./github-sync.js", () => ({
  hasRemoteUpdates: vi.fn().mockResolvedValue(false),
  syncRepo: vi.fn().mockResolvedValue({ updated: false }),
}));

import { hasRemoteUpdates, syncRepo } from "./github-sync.js";

describe("createPollingManager", () => {
  const specs: GitHubRepoSpec[] = [
    { owner: "owner1", repo: "repo1" },
    { owner: "owner2", repo: "repo2" },
  ];
  const syncOptions: SyncOptions = { cacheDir: "/cache" };
  const onUpdate = vi.fn();
  const onError = vi.fn();

  let manager: PollingManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tryAcquireFileLockSync).mockReturnValue(vi.fn());
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    manager?.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("isRunning returns false initially", () => {
    manager = createPollingManager(specs, syncOptions, { intervalMs: 1000, onUpdate });
    expect(manager.isRunning()).toBe(false);
  });

  it("start sets up interval and isRunning returns true", () => {
    manager = createPollingManager(specs, syncOptions, { intervalMs: 1000, onUpdate });
    manager.start();
    expect(manager.isRunning()).toBe(true);
  });

  it("stop clears interval and isRunning returns false", () => {
    manager = createPollingManager(specs, syncOptions, { intervalMs: 1000, onUpdate });
    manager.start();
    manager.stop();
    expect(manager.isRunning()).toBe(false);
  });

  it("does not start when intervalMs <= 0", () => {
    manager = createPollingManager(specs, syncOptions, { intervalMs: 0, onUpdate });
    manager.start();
    expect(manager.isRunning()).toBe(false);
  });

  it("filters out version tag refs from polling", () => {
    const pinnedSpecs: GitHubRepoSpec[] = [
      { owner: "owner1", repo: "repo1", ref: "v1.0.0" },
      { owner: "owner2", repo: "repo2", ref: "v2.3.4" },
    ];
    manager = createPollingManager(pinnedSpecs, syncOptions, { intervalMs: 1000, onUpdate });
    manager.start();
    expect(manager.isRunning()).toBe(false);
  });

  it("filters out commit hash refs from polling", () => {
    const pinnedSpecs: GitHubRepoSpec[] = [{ owner: "owner1", repo: "repo1", ref: "abc1234567" }];
    manager = createPollingManager(pinnedSpecs, syncOptions, { intervalMs: 1000, onUpdate });
    manager.start();
    expect(manager.isRunning()).toBe(false);
  });

  it("checkNow calls hasRemoteUpdates for each spec while holding the shared lease", async () => {
    manager = createPollingManager(specs, syncOptions, { intervalMs: 60000, onUpdate });
    await manager.checkNow();
    expect(tryAcquireFileLockSync).toHaveBeenCalledWith("/cache/.skilljack-github-polling.lock");
    expect(hasRemoteUpdates).toHaveBeenCalledTimes(2);
    expect(vi.mocked(tryAcquireFileLockSync).mock.results[0].value).toHaveBeenCalledOnce();
  });

  it("skips polling when another process owns the shared lease", async () => {
    vi.mocked(tryAcquireFileLockSync).mockReturnValue(null);
    manager = createPollingManager(specs, syncOptions, { intervalMs: 60000, onUpdate });
    await manager.checkNow();
    expect(hasRemoteUpdates).not.toHaveBeenCalled();
  });

  it("calls onUpdate when updates are synced", async () => {
    vi.mocked(hasRemoteUpdates).mockResolvedValue(true);
    vi.mocked(syncRepo).mockResolvedValue({
      spec: specs[0],
      localPath: "/cache/owner1/repo1",
      clonePath: "/cache/owner1/repo1",
      updated: true,
    });
    manager = createPollingManager(specs, syncOptions, { intervalMs: 60000, onUpdate });
    await manager.checkNow();
    expect(onUpdate).toHaveBeenCalled();
  });

  it("calls onError when a repository check fails", async () => {
    vi.mocked(hasRemoteUpdates).mockRejectedValue(new Error("network error"));
    manager = createPollingManager(specs, syncOptions, { intervalMs: 60000, onUpdate, onError });
    await manager.checkNow();
    expect(onError).toHaveBeenCalled();
  });

  it("releases the lease and recovers its guard when an error callback throws", async () => {
    let throwOnce = true;
    const throwingOnError = vi.fn(() => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error("callback failed");
      }
    });
    vi.mocked(hasRemoteUpdates).mockRejectedValue(new Error("network error"));
    manager = createPollingManager(specs, syncOptions, {
      intervalMs: 60000,
      onUpdate,
      onError: throwingOnError,
    });

    await expect(manager.checkNow()).rejects.toThrow("callback failed");
    expect(vi.mocked(tryAcquireFileLockSync).mock.results[0].value).toHaveBeenCalledOnce();

    vi.mocked(hasRemoteUpdates).mockResolvedValue(false);
    await manager.checkNow();
    expect(hasRemoteUpdates).toHaveBeenCalledTimes(3);
  });

  it("triggers check after interval elapses", async () => {
    manager = createPollingManager(specs, syncOptions, { intervalMs: 5000, onUpdate });
    manager.start();
    expect(hasRemoteUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(hasRemoteUpdates).toHaveBeenCalled();
  });

  it("does not start twice", () => {
    manager = createPollingManager(specs, syncOptions, { intervalMs: 1000, onUpdate });
    manager.start();
    manager.start();
    expect(manager.isRunning()).toBe(true);
  });
});
