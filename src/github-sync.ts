/**
 * GitHub repository synchronization.
 * Handles cloning and pulling repositories to local cache.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { simpleGit, SimpleGit, TagResult } from "simple-git";
import { GitHubRepoSpec, getRepoClonePath, getRepoCachePath } from "./github-config.js";
import { withFileLock } from "./file-lock.js";

/**
 * Options for syncing GitHub repositories.
 */
export interface SyncOptions {
  cacheDir: string;
  token?: string;
  shallowClone?: boolean; // Default: true
  /** Skip network work when a valid cache already exists (startup only). */
  skipIfExists?: boolean;
}

/**
 * Result of a sync operation.
 */
export interface SyncResult {
  spec: GitHubRepoSpec;
  localPath: string; // Path to skills directory (may include subpath)
  clonePath: string; // Path to git repo root
  updated: boolean; // Whether files changed
  error?: string;
}

/**
 * Maximum retry attempts for network operations.
 */
const MAX_RETRIES = 3;

/**
 * Initial backoff delay in milliseconds.
 */
const INITIAL_BACKOFF_MS = 1000;
const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;
const VERSION_TAG_RE = /^v?\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the HTTPS URL for a GitHub repository.
 * Includes token for authentication if provided.
 */
function buildRepoUrl(spec: GitHubRepoSpec, token?: string): string {
  if (token) {
    return `https://${token}@github.com/${spec.owner}/${spec.repo}.git`;
  }
  return `https://github.com/${spec.owner}/${spec.repo}.git`;
}

/**
 * Ensure the parent directory exists.
 */
function ensureParentDir(filePath: string): void {
  const parentDir = path.dirname(filePath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }
}

/**
 * Check if a directory is a git repository.
 */
function isGitRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}

/**
 * Clone a repository with retry logic.
 */
async function cloneWithRetry(
  git: SimpleGit,
  url: string,
  destPath: string,
  ref: string | undefined,
  shallowClone: boolean
): Promise<void> {
  const cloneOptions: string[] = [];
  if (shallowClone) {
    cloneOptions.push("--depth", "1");
  }
  if (ref && !COMMIT_HASH_RE.test(ref)) {
    cloneOptions.push("--branch", ref);
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      await git.clone(url, destPath, cloneOptions);
      break;
    } catch (error) {
      const isLastAttempt = attempt === MAX_RETRIES - 1;
      if (isLastAttempt) {
        throw error;
      }

      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      console.error(`Clone attempt ${attempt + 1}/${MAX_RETRIES} failed, retrying in ${backoff}ms...`);
      await sleep(backoff);
    }
  }

  if (ref && COMMIT_HASH_RE.test(ref)) {
    const repoGit = simpleGit(destPath);
    await repoGit.fetch(["origin", ref]);
    await repoGit.checkout(ref);
  }
}

/**
 * Pull updates with retry logic.
 * Returns true if there were changes.
 */
async function pullWithRetry(git: SimpleGit, ref: string | undefined): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      // Get current HEAD before pull
      const beforeHead = await git.revparse(["HEAD"]);

      // Pull changes
      if (ref) {
        await git.fetch(["origin", ref]);
        await git.checkout(ref);
        await git.pull("origin", ref, ["--ff-only"]);
      } else {
        await git.pull(["--ff-only"]);
      }

      // Check if HEAD changed
      const afterHead = await git.revparse(["HEAD"]);
      return beforeHead !== afterHead;
    } catch (error) {
      const isLastAttempt = attempt === MAX_RETRIES - 1;
      if (isLastAttempt) {
        throw error;
      }

      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      console.error(`Pull attempt ${attempt + 1}/${MAX_RETRIES} failed, retrying in ${backoff}ms...`);
      await sleep(backoff);
    }
  }
  return false;
}

async function getDefaultBranch(git: SimpleGit): Promise<string | undefined> {
  try {
    const remoteHead = (
      await git.raw(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
    ).trim();
    if (remoteHead) {
      return remoteHead.startsWith("origin/")
        ? remoteHead.slice("origin/".length)
        : remoteHead;
    }
  } catch {
    // Fall back to conventional default branch names when origin/HEAD is unset.
  }

  for (const branch of ["main", "master"]) {
    try {
      await git.revparse(["refs/remotes/origin/" + branch]);
      return branch;
    } catch {
      continue;
    }
  }

  return undefined;
}

async function isCachedRefCurrent(spec: GitHubRepoSpec, git: SimpleGit): Promise<boolean> {
  if (!spec.ref) {
    const defaultBranch = await getDefaultBranch(git);
    return defaultBranch !== undefined && (await git.branchLocal()).current === defaultBranch;
  }

  const tags = await git.tags();
  if (tags.all.includes(spec.ref)) {
    const [head, tagHead] = await Promise.all([
      git.revparse(["HEAD"]),
      git.revparse([spec.ref + "^{commit}"]),
    ]);
    return head === tagHead;
  }

  if (COMMIT_HASH_RE.test(spec.ref)) {
    const head = (await git.revparse(["HEAD"])).toLowerCase();
    return head.startsWith(spec.ref.toLowerCase());
  }

  if (VERSION_TAG_RE.test(spec.ref)) return false;
  return (await git.branchLocal()).current === spec.ref;
}

/**
 * Sync a single GitHub repository.
 * Clones if not present, pulls if already cloned.
 *
 * @param spec - Repository specification
 * @param options - Sync options
 * @returns Sync result
 */
async function syncRepoUnlocked(spec: GitHubRepoSpec, options: SyncOptions): Promise<SyncResult> {
  const clonePath = getRepoClonePath(spec, options.cacheDir);
  const localPath = getRepoCachePath(spec, options.cacheDir);
  const shallowClone = options.shallowClone !== false; // Default true

  const result: SyncResult = {
    spec,
    localPath,
    clonePath,
    updated: false,
  };

  if (options.skipIfExists && isGitRepo(clonePath)) {
    const repoGit = simpleGit(clonePath);
    const cacheMatchesRef = await isCachedRefCurrent(spec, repoGit).catch((error) => {
      console.error(`Could not verify cached ref for ${spec.owner}/${spec.repo}: ${error}`);
      return false;
    });

    if (cacheMatchesRef) {
      if (spec.subpath && !fs.existsSync(localPath)) {
        result.error = `Subpath not found in repository: ${spec.subpath}`;
      }
      return result;
    }
  }

  try {
    const url = buildRepoUrl(spec, options.token);
    const git = simpleGit();

    if (!isGitRepo(clonePath)) {
      // Clone the repository
      console.error(`Cloning ${spec.owner}/${spec.repo}...`);
      ensureParentDir(clonePath);
      await cloneWithRetry(git, url, clonePath, spec.ref, shallowClone);
      result.updated = true;
      console.error(`Cloned ${spec.owner}/${spec.repo} to ${clonePath}`);
    } else {
      // Pull updates
      console.error(`Pulling updates for ${spec.owner}/${spec.repo}...`);
      const repoGit = simpleGit(clonePath);

      if (spec.ref) {
        const tags = await repoGit.tags();
        const isTag = tags.all.includes(spec.ref);
        const isCommit = COMMIT_HASH_RE.test(spec.ref);
        const isVersionTag = VERSION_TAG_RE.test(spec.ref);

        if (isTag || isCommit || isVersionTag) {
          const beforeHead = await repoGit.revparse(["HEAD"]);
          if (isCommit) {
            await repoGit.fetch(["origin", spec.ref]);
          } else if (!isTag) {
            await repoGit.fetch(["origin", "refs/tags/" + spec.ref + ":refs/tags/" + spec.ref]);
          }
          await repoGit.checkout(spec.ref);
          const afterHead = await repoGit.revparse(["HEAD"]);
          result.updated = beforeHead !== afterHead;
          if (spec.subpath && !fs.existsSync(localPath)) {
            result.error = `Subpath not found in repository: ${spec.subpath}`;
          }
          return result;
        }
      }

      const currentBranch = (await repoGit.branchLocal()).current;
      const defaultBranch = spec.ref ? undefined : await getDefaultBranch(repoGit);
      const targetRef = spec.ref ?? defaultBranch ?? currentBranch;
      if (!targetRef) {
        throw new Error(`Could not determine the default branch for ${spec.owner}/${spec.repo}`);
      }
      result.updated = await pullWithRetry(repoGit, targetRef);
      if (result.updated) {
        console.error(`Updated ${spec.owner}/${spec.repo}`);
      } else {
        console.error(`${spec.owner}/${spec.repo} is up to date`);
      }
    }

    // Verify the subpath exists if specified
    if (spec.subpath && !fs.existsSync(localPath)) {
      result.error = `Subpath not found in repository: ${spec.subpath}`;
      console.error(`Warning: ${result.error}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Provide helpful error messages
    if (errorMessage.includes("Authentication failed") || errorMessage.includes("403")) {
      result.error = `Authentication failed for ${spec.owner}/${spec.repo}. For private repos, set GITHUB_TOKEN environment variable.`;
    } else if (errorMessage.includes("rate limit")) {
      result.error = `Rate limited when accessing ${spec.owner}/${spec.repo}. Try again later.`;
    } else if (errorMessage.includes("not found") || errorMessage.includes("404")) {
      result.error = `Repository not found: ${spec.owner}/${spec.repo}`;
    } else {
      result.error = `Failed to sync ${spec.owner}/${spec.repo}: ${errorMessage}`;
    }

    console.error(result.error);
  }

  return result;
}

/**
 * Sync a repository while holding its cache lock so concurrent Skilljack
 * processes cannot clone, fetch, or pull the same working tree at once.
 */
export async function syncRepo(
  spec: GitHubRepoSpec,
  options: SyncOptions,
): Promise<SyncResult> {
  const clonePath = getRepoClonePath(spec, options.cacheDir);
  return withFileLock(`${clonePath}.skilljack-lock`, () =>
    syncRepoUnlocked(spec, options),
  );
}

/**
 * Sync multiple GitHub repositories.
 *
 * @param specs - Repository specifications
 * @param options - Sync options
 * @returns Array of sync results
 */
export async function syncAllRepos(
  specs: GitHubRepoSpec[],
  options: SyncOptions
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];

  for (const spec of specs) {
    const result = await syncRepo(spec, options);
    results.push(result);
  }

  return results;
}

/**
 * Check if a repository has remote updates available.
 * Uses git fetch --dry-run to check without downloading.
 *
 * @param spec - Repository specification
 * @param options - Sync options
 * @returns true if updates are available
 */
async function hasRemoteUpdatesUnlocked(
  spec: GitHubRepoSpec,
  options: SyncOptions,
): Promise<boolean> {
  const clonePath = getRepoClonePath(spec, options.cacheDir);

  if (!isGitRepo(clonePath)) {
    // Not cloned yet, so yes there are "updates"
    return true;
  }

  // Skip check for pinned refs
  if (spec.ref) {
    const git = simpleGit(clonePath);
    const isTag = await git
      .tags()
      .then((tags: TagResult) => tags.all.includes(spec.ref!))
      .catch(() => false);
    const isCommit = /^[0-9a-f]{7,40}$/i.test(spec.ref);

    if (isTag || isCommit) {
      return false;
    }
  }

  try {
    const git = simpleGit(clonePath);
    const url = buildRepoUrl(spec, options.token);

    // Fetch to update remote refs
    await git.fetch(["origin"]);

    // Compare local and remote
    const localHead = await git.revparse(["HEAD"]);
    const remoteRef = spec.ref ? `origin/${spec.ref}` : "origin/HEAD";

    try {
      const remoteHead = await git.revparse([remoteRef]);
      return localHead !== remoteHead;
    } catch {
      // Remote ref might not exist, try origin/main or origin/master
      for (const branch of ["origin/main", "origin/master"]) {
        try {
          const remoteHead = await git.revparse([branch]);
          return localHead !== remoteHead;
        } catch {
          continue;
        }
      }
      return false;
    }
  } catch (error) {
    console.error(`Failed to check for updates: ${error}`);
    return false;
  }
}

/** Serialize fetches with clone/pull operations for this repository. */
export async function hasRemoteUpdates(
  spec: GitHubRepoSpec,
  options: SyncOptions,
): Promise<boolean> {
  const clonePath = getRepoClonePath(spec, options.cacheDir);
  return withFileLock(`${clonePath}.skilljack-lock`, () =>
    hasRemoteUpdatesUnlocked(spec, options),
  );
}
