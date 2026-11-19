// store.ts — in-memory data model and git graph operations.
// Everything lives in memory: the trial is one process, and perf is an in-memory hot path.

import { buildTree, hashObject, isObjectId, parseCommit, parseTag, parseTree, storeObject, type GitObject, type ObjectType } from './gitutil.ts';

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  email: 'adaiversen@example.invalid',
  type: 'User',
} as const;

export const DEFAULT_BRANCH = 'main';

let globalSeq = 0;
export function nextSeq(): number {
  globalSeq += 1;
  return globalSeq;
}

let nextRepoId = 5000;
let nextItemId = 1_000_000;

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
  authorLogin: string;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
  updatedSeq: number;
  authorLogin: string;
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdSeq: number;
  updatedSeq: number;
  authorLogin: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
}

export class Store {
  repos = new Map<string, Repo>();

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, opts: { private?: boolean; description?: string; defaultBranch?: string }): Repo {
    const repo: Repo = {
      id: nextRepoId++,
      name,
      owner,
      private: opts.private ?? false,
      description: opts.description ?? '',
      defaultBranch: opts.defaultBranch ?? DEFAULT_BRANCH,
      createdSeq: nextSeq(),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
    };
    // GitHub's default labels.
    for (const [lname, color] of [
      ['bug', 'd73a4a'],
      ['enhancement', 'a2eeef'],
      ['documentation', '0075ca'],
      ['question', 'd876e3'],
      ['good first issue', '7057ff'],
      ['help wanted', '008672'],
    ] as const) {
      repo.labels.set(lname, { name: lname, color, description: '' });
    }
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  nextItemId(): number {
    return nextItemId++;
  }
}

// ---------------------------------------------------------------- git graph

/** The parsed commit for an oid, or null. Cached per repo via the caller. */
export function commitOf(repo: Repo, oid: string): { tree: string; parents: string[] } | null {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return null;
  const parsed = parseCommit(obj.data);
  if (parsed === null) return null;
  return { tree: parsed.tree, parents: parsed.parents };
}

/** Peel an annotated tag (recursively) to the commit it points at. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let cur = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = repo.objects.get(cur);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') {
      const tag = parseTag(obj.data);
      if (tag === null) return null;
      cur = tag.object;
      continue;
    }
    return null;
  }
  return null;
}

/** All ancestors of `tip` (inclusive), as a set. Bounded walk; the suite's histories are small. */
export function ancestors(repo: Repo, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const c = commitOf(repo, oid);
    if (c === null) continue;
    seen.add(oid);
    for (const p of c.parents) stack.push(p);
  }
  return seen;
}

/** Is `ancestor` an ancestor of (or equal to) `tip`? */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  return ancestors(repo, tip).has(ancestor);
}

/**
 * The merge-base of two commits: the common ancestor with the greatest generation
 * (BFS from both sides, first common commit found from the second BFS).
 */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancA = ancestors(repo, a);
  if (ancA.has(b)) return b;
  // BFS from b by generation: parents first.
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancA.has(oid)) return oid;
    const c = commitOf(repo, oid);
    if (c === null) continue;
    for (const p of c.parents) queue.push(p);
  }
  return null;
}

export interface FlatFile {
  oid: string;
  mode: string;
}

/**
 * Flatten a tree (recursively) into path -> file. Directories are not files.
 * Results are cached on the repo object via a side map the caller owns.
 */
export function flattenTree(repo: Repo, treeOid: string, cache: Map<string, Map<string, FlatFile>>): Map<string, FlatFile> {
  const cached = cache.get(treeOid);
  if (cached !== undefined) return cached;
  const out = new Map<string, FlatFile>();
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') walk(entry.oid, `${prefix}${entry.name}/`);
      else out.set(`${prefix}${entry.name}`, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  cache.set(treeOid, out);
  return out;
}

/** Read one file's bytes from a tree, by path. */
export function readFileAt(repo: Repo, treeOid: string, path: string, cache: Map<string, Map<string, FlatFile>>): Buffer | null {
  const flat = flattenTree(repo, treeOid, cache);
  const file = flat.get(path);
  if (file === undefined) return null;
  const obj = repo.objects.get(file.oid);
  if (obj === undefined || obj.type !== 'blob') return null;
  return obj.data;
}

/** The tip commit oid a ref resolves to (peeling tags), or null. */
export function refCommit(repo: Repo, ref: string): string | null {
  const oid = repo.refs.get(ref);
  if (oid === undefined) return null;
  return peelToCommit(repo, oid);
}

/** Build a commit object for `message` with `tree` and `parents`, store it, return its oid. */
export function makeCommit(
  repo: Repo,
  opts: { tree: string; parents: string[]; message: string; author?: string; committer?: string; timestamp?: number },
): string {
  const ts = opts.timestamp ?? 1700000000;
  const identity = `${VIEWER.login} <${VIEWER.email}> ${ts} +0000`;
  const author = opts.author ?? identity;
  const committer = opts.committer ?? identity;
  const data = Buffer.from(
    `tree ${opts.tree}\n${opts.parents.map((p) => `parent ${p}\n`).join('')}author ${author}\ncommitter ${committer}\n\n${opts.message}`,
    'utf8',
  );
  return storeObject(repo.objects, 'commit', data);
}

/** Build a tree object from a flat file map, store it, return its oid. */
export function makeTree(repo: Repo, files: Map<string, FlatFile>): string {
  // Build nested tree structure bottom-up.
  interface Node {
    files: Map<string, FlatFile>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, file] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1]!, file);
  }
  const build = (node: Node): string => {
    const entries: Array<{ mode: string; name: string; oid: string }> = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    const data = buildTree(entries);
    return storeObject(repo.objects, 'tree', data);
  };
  return build(root);
}

/**
 * Three-way merge for a squash: base tree + head's changes relative to merge-base.
 * Returns the merged flat map, or null when the same file changed differently on both sides.
 */
export function threeWayMerge(
  repo: Repo,
  baseTree: string,
  headTree: string,
  mergeBaseTree: string,
  cache: Map<string, Map<string, FlatFile>>,
): Map<string, FlatFile> | null {
  const base = flattenTree(repo, baseTree, cache);
  const head = flattenTree(repo, headTree, cache);
  const mb = flattenTree(repo, mergeBaseTree, cache);
  const out = new Map<string, FlatFile>(base);
  const paths = new Set<string>([...mb.keys(), ...head.keys(), ...base.keys()]);
  for (const path of paths) {
    const mbFile = mb.get(path);
    const headFile = head.get(path);
    const baseFile = base.get(path);
    const headChanged = (headFile?.oid ?? null) !== (mbFile?.oid ?? null);
    const baseChanged = (baseFile?.oid ?? null) !== (mbFile?.oid ?? null);
    if (!headChanged) continue; // keep base's version
    if (!baseChanged) {
      // Only head changed: take head's version (or deletion).
      if (headFile === undefined) out.delete(path);
      else out.set(path, headFile);
      continue;
    }
    // Both changed: conflict unless identical.
    if ((headFile?.oid ?? null) !== (baseFile?.oid ?? null)) return null;
  }
  return out;
}

/** Whether a PR can merge cleanly (same three-way test, without building the tree). */
export function mergeConflicts(
  repo: Repo,
  baseTree: string,
  headTree: string,
  mergeBaseTree: string,
  cache: Map<string, Map<string, FlatFile>>,
): boolean {
  return threeWayMerge(repo, baseTree, headTree, mergeBaseTree, cache) === null;
}


/** Squash-merge an open pull request onto its base branch. Shared by REST and GraphQL. */
export function doMergePull(repo: Repo, pull: Pull): { ok: boolean; sha?: string } {
  if (pull.state !== 'open') return { ok: false };
  const headSha = refCommit(repo, `refs/heads/${pull.headRef}`);
  const baseSha = refCommit(repo, `refs/heads/${pull.baseRef}`);
  if (headSha === null || baseSha === null) return { ok: false };
  const base = mergeBase(repo, headSha, baseSha);
  if (base === null) return { ok: false };
  const baseCommit = commitOf(repo, baseSha);
  const headCommit = commitOf(repo, headSha);
  const mbCommit = commitOf(repo, base);
  if (baseCommit === null || headCommit === null || mbCommit === null) return { ok: false };
  const cache = new Map<string, Map<string, FlatFile>>();
  const merged = threeWayMerge(repo, baseCommit.tree, headCommit.tree, mbCommit.tree, cache);
  if (merged === null) return { ok: false };
  const treeOid = makeTree(repo, merged);
  const commitOid = makeCommit(repo, { tree: treeOid, parents: [baseSha], message: pull.title });
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = new Date().toISOString();
  pull.mergeCommitSha = commitOid;
  pull.headSha = headSha;
  pull.baseSha = commitOid;
  return { ok: true, sha: commitOid };
}

export function isValidRefName(ref: string): boolean {
  return /^refs\/(heads|tags)\/[A-Za-z0-9._\-/]+$/.test(ref) && !ref.includes('..') && !ref.endsWith('.lock');
}

export function isObjectIdString(value: unknown): value is string {
  return isObjectId(value);
}

export type { GitObject, ObjectType };
