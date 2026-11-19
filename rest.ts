// rest.ts — GitHub REST v3 surface (/api/v3/...).
// Every response is application/json with a non-empty X-GitHub-Request-Id (app.ts adds both).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { isObjectId, parseCommit, parseTree, storeObject } from './gitutil.ts';
import {
  VIEWER,
  ancestors,
  commitOf,
  doMergePull,
  flattenTree,
  makeCommit,
  makeTree,
  mergeBase,
  refCommit,
  threeWayMerge,
  nextSeq,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestContext {
  store: Store;
  /** Absolute base URL for Link headers (http://host). */
  baseUrl: string;
  /** Parsed JSON body, or null when there was no body. */
  body: unknown;
  /** True when the request body was present but not valid JSON. */
  bodyError: boolean;
  query: URLSearchParams;
}

export type Handler = (ctx: RestContext, req: IncomingMessage, res: ServerResponse, params: string[]) => void;

let restRequestCounter = 0;

function json(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  restRequestCounter += 1;
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': `gh-rest-${process.pid.toString(36)}-${Date.now().toString(36)}-${restRequestCounter.toString(36)}`,
    ...extraHeaders,
  };
  if (status !== 204) headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  res.end(text);
}

function err(res: ServerResponse, status: number, message: string): void {
  json(res, status, { message });
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------- views

export function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${Buffer.from(`Repository:${repo.id}`).toString('base64')}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    html_url: `/repos/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

function labelView(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description };
}

export function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${Buffer.from(`Issue:${repo.id}:${issue.number}`).toString('base64')}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name);
      return l ? labelView(l) : { name, color: 'ededed', description: '' };
    }),
    user: { login: issue.authorLogin, id: VIEWER.id, type: 'User' },
    comments: issue.comments.length,
    created_at: nowIso(),
    updated_at: nowIso(),
    html_url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullView(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `PR_${Buffer.from(`PullRequest:${repo.id}:${pull.number}`).toString('base64')}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: pull.authorLogin, id: VIEWER.id, type: 'User' },
    created_at: nowIso(),
    updated_at: nowIso(),
    html_url: `/repos/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commentView(repo: Repo, issue: Issue, comment: { id: number; body: string; authorLogin: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `IC_${Buffer.from(`IssueComment:${repo.id}:${issue.number}:${comment.id}`).toString('base64')}`,
    body: comment.body,
    user: { login: comment.authorLogin, id: VIEWER.id, type: 'User' },
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

// ---------------------------------------------------------------- pagination

interface Page {
  page: number;
  perPage: number;
}

function pageOf(query: URLSearchParams): Page {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: Page): { slice: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / page.perPage));
  const start = (page.page - 1) * page.perPage;
  return { slice: items.slice(start, start + page.perPage), totalPages };
}

function linkHeader(ctx: RestContext, req: IncomingMessage, page: Page, totalPages: number): string {
  const url = new URL(req.url ?? '/', ctx.baseUrl);
  const build = (p: number): string => {
    const u = new URL(url.toString());
    u.searchParams.set('page', String(p));
    u.searchParams.set('per_page', String(page.perPage));
    return `<${u.toString()}>`;
  };
  const parts: string[] = [];
  if (page.page < totalPages) parts.push(`${build(page.page + 1)}; rel="next"`);
  if (page.page > 1) parts.push(`${build(page.page - 1)}; rel="prev"`);
  parts.push(`${build(1)}; rel="first"`);
  parts.push(`${build(totalPages)}; rel="last"`);
  return parts.join(', ');
}

// ---------------------------------------------------------------- helpers

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function bodyOf(ctx: RestContext): Record<string, unknown> {
  return isRecord(ctx.body) ? ctx.body : {};
}

/** Resolve a repo by owner/name; owner must be the viewer, else 404 (never 403). */
function resolveRepo(ctx: RestContext, res: ServerResponse, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) {
    err(res, 404, 'Not Found');
    return null;
  }
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) {
    err(res, 404, 'Not Found');
    return null;
  }
  return repo;
}

/** Resolve a branch name (or oid) to its tip commit oid. */
function resolveRefTip(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === undefined || ref === '') {
    return refCommit(repo, `refs/heads/${repo.defaultBranch}`);
  }
  if (isObjectId(ref)) return repo.objects.has(ref) ? ref : null;
  const branchTip = refCommit(repo, `refs/heads/${ref}`);
  if (branchTip !== null) return branchTip;
  const tagTip = refCommit(repo, `refs/tags/${ref}`);
  if (tagTip !== null) return tagTip;
  return null;
}

/** Per-repo flat-tree cache (invalidated never: trees are immutable). */
const treeCaches = new WeakMap<Repo, Map<string, Map<string, { oid: string; mode: string }>>>();
function treeCache(repo: Repo): Map<string, Map<string, { oid: string; mode: string }>> {
  let cache = treeCaches.get(repo);
  if (cache === undefined) {
    cache = new Map();
    treeCaches.set(repo, cache);
  }
  return cache;
}

/** The flat file map of a commit's tree (empty map when the commit is null). */
function filesOfCommit(repo: Repo, commitOid: string | null): Map<string, { oid: string; mode: string }> {
  if (commitOid === null) return new Map();
  const c = commitOf(repo, commitOid);
  if (c === null) return new Map();
  return flattenTree(repo, c.tree, treeCache(repo));
}

/** Count added/removed lines between two texts (common prefix/suffix diff). */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1;
  return { additions: newLines.length - prefix - suffix, deletions: oldLines.length - prefix - suffix };
}

// ---------------------------------------------------------------- API root / meta / user

export function handleApiRoot(ctx: RestContext, res: ServerResponse): void {
  json(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
}

export function handleMeta(ctx: RestContext, res: ServerResponse): void {
  json(res, 200, { installed_version: '1.0.0' });
}

export function handleUser(ctx: RestContext, res: ServerResponse): void {
  json(res, 200, {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: `U_${Buffer.from(`User:${VIEWER.id}`).toString('base64')}`,
    type: 'User',
    email: VIEWER.email,
    name: VIEWER.login,
  });
}

// ---------------------------------------------------------------- repos

export function handleCreateRepo(ctx: RestContext, res: ServerResponse): void {
  if (ctx.bodyError) { err(res, 400, 'Invalid JSON body'); return; }
  const body = bodyOf(ctx);
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '') { err(res, 422, 'name is required'); return; }
  if (!/^[A-Za-z0-9._-]+$/.test(name)) { err(res, 422, 'name is invalid'); return; }
  if (ctx.store.getRepo(VIEWER.login, name) !== undefined) {
    err(res, 422, `Repository ${VIEWER.login}/${name} already exists`);
    return;
  }
  const repo = ctx.store.createRepo(VIEWER.login, name, {
    private: body.private === true,
    description: typeof body.description === 'string' ? body.description : '',
    defaultBranch: typeof body.default_branch === 'string' && body.default_branch !== '' ? body.default_branch : undefined,
  });
  json(res, 201, repoView(repo));
}

export function handleListUserRepos(ctx: RestContext, req: IncomingMessage, res: ServerResponse): void {
  const repos = ctx.store.listRepos(VIEWER.login);
  const page = pageOf(ctx.query);
  const { slice, totalPages } = paginate(repos, page);
  json(res, 200, slice.map(repoView), { link: linkHeader(ctx, req, page, totalPages) });
}

export function handleGetRepo(ctx: RestContext, res: ServerResponse, owner: string, name: string): void {
  const repo = resolveRepo(ctx, res, owner, name);
  if (repo === null) return;
  json(res, 200, repoView(repo));
}

export function handlePatchRepo(ctx: RestContext, res: ServerResponse, owner: string, name: string): void {
  const repo = resolveRepo(ctx, res, owner, name);
  if (repo === null) return;
  if (ctx.bodyError) { err(res, 400, 'Invalid JSON body'); return; }
  const body = bodyOf(ctx);
  if (typeof body.description === 'string') repo.description = body.description;
  if (body.private === true || body.private === false) repo.private = body.private;
  json(res, 200, repoView(repo));
}

export function handleDeleteRepo(ctx: RestContext, res: ServerResponse, owner: string, name: string): void {
  const repo = resolveRepo(ctx, res, owner, name);
  if (repo === null) return;
  ctx.store.deleteRepo(owner, name);
  json(res, 204, null);
}

// ---------------------------------------------------------------- branches / commits / refs

export function handleListBranches(ctx: RestContext, res: ServerResponse, owner: string, name: string): void {
  const repo = resolveRepo(ctx, res, owner, name);
  if (repo === null) return;
  const out: Array<Record<string, unknown>> = [];
  for (const [ref, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!ref.startsWith('refs/heads/')) continue;
    const commit = refCommit(repo, ref);
    if (commit === null) continue;
    out.push({ name: ref.slice('refs/heads/'.length), commit: { sha: commit }, protected: false });
  }
  json(res, 200, out);
}

export function handleGetBranch(ctx: RestContext, res: ServerResponse, owner: string, name: string, branch: string): void {
  const repo = resolveRepo(ctx, res, owner, name);
  if (repo === null) return;
  const commit = refCommit(repo, `refs/heads/${branch}`);
  if (commit === null) { err(res, 404, 'Branch not found'); return; }
  json(res, 200, { name: branch, commit: { sha: commit }, protected: false });
}

export function handleListCommits(ctx: RestContext, req: IncomingMessage, res: ServerResponse, owner: string, name: string): void {
  const repo = resolveRepo(ctx, res, owner, name);
  if (repo === null) return;
  const tip = resolveRefTip(repo, ctx.query.get('sha'));
  if (tip === null) { err(res, 404, 'No commits'); return; }
  // Linear histories: DFS from the tip, newest first.
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const c = commitOf(repo, oid);
    if (c === null) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid)!;
    const parsed = parseCommit(obj.data);
    out.push({
      sha: oid,
      commit: {
        message: parsed?.message ?? '',
        author: { name: VIEWER.login, email: VIEWER.email },
        committer: { name: VIEWER.login, email: VIEWER.email },
      },
    });
    for (const p of c.parents) stack.push(p);
  }
  const page = pageOf(ctx.query);
  const { slice, totalPages } = paginate(out, page);
  json(res, 200, slice, { link: linkHeader(ctx, req, page, totalPages) });
}

export function handleCreateRef(ctx: RestContext, res: ServerResponse, owner: string, name: string): void {
  const repo = resolveRepo(ctx, res, owner, name);
  if (repo === null) return;
  if (ctx.bodyError) { err(res, 400, 'Invalid JSON body'); return; }
  const body = bodyOf(ctx);
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (!ref.startsWith('refs/') || !isObjectId(sha)) { err(res, 422, 'Invalid ref or sha'); return; }
  if (!repo.objects.has(sha)) { err(res, 422, 'Object does not exist'); return; }
  if (repo.refs.has(ref)) { err(res, 422, 'Reference already exists'); return; }
  repo.refs.set(ref, sha);
  json(res, 201, { ref, object: { sha, type: repo.objects.get(sha)!.type } });
}

export function handleGetRef(ctx: RestContext, res: ServerResponse, owner: string, name: string, refPath: string): void {
  const repo = resolveRepo(ctx, res, owner, name);
  if (repo === null) return;
  const ref = `refs/${refPath}`;
  const oid = repo.refs.get(ref);
  if (oid === undefined) { err(res, 404, 'Reference not found'); return; }
  json(res, 200, { ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } });
}

export function handleListRefs(ctx: RestContext, res: ServerResponse, owner: string, name: string): void {
  const repo = resolveRepo(ctx, res, owner, name);
  if (repo === null) return;
  const out: Array<Record<string, unknown>> = [];
  for (const [ref, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    out.push({ ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } });
  }
  json(res, 200, out);
}

// ---------------------------------------------------------------- contents

function contentsFileView(repo: Repo, path: string, blobOid: string, data: Buffer): Record<string, unknown> {
  return {
    type: 'file',
    encoding: 'base64',
    name: path.split('/').pop() ?? path,
    path,
    sha: blobOid,
    size: data.length,
    content: data.toString('base64'),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
  };
}

export function handleGetContents(ctx: RestContext, res: ServerResponse, owner: string, name: string, path: string): void {
  const repo = resolveRepo(ctx, res, owner, name);
  if (repo === null) return;
  const tip = resolveRefTip(repo, ctx.query.get('ref'));
  if (tip === null) { err(res, 404, 'Not Found'); return; }
  const c = commitOf(repo, tip);
  if (c === null) { err(res, 404, 'Not Found'); return; }
  const files = flattenTree(repo, c.tree, treeCache(repo));
  const cleanPath = path.replace(/^\/+|\/+$/g, '');
  if (cleanPath === '') {
    // Root listing.
    const out: Array<Record<string, unknown>> = [];
    const seen = new Map<string, { type: string; oid: string }>();
    for (const p of files.keys()) {
      const first = p.split('/')[0]!;
      if (!seen.has(first)) {
        const isDir = [...files.keys()].some((k) => k.startsWith(`${first}/`));
        const direct = files.get(first);
        seen.set(first, { type: isDir ? 'dir' : 'file', oid: direct?.oid ?? '' });
      }
    }
    for (const [fname, info] of [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      out.push({ type: info.type, name: fname, path: fname, sha: info.oid });
    }
    json(res, 200, out);
    return;
  }
  const file = files.get(cleanPath);
  if (file !== undefined) {
    const obj = repo.objects.get(file.oid);
    if (obj === undefined || obj.type !== 'blob') { err(res, 404, 'Not Found'); return; }
    json(res, 200, contentsFileView(repo, cleanPath, file.oid, obj.data));
    return;
  }
  // Directory?
  const prefix = `${cleanPath}/`;
  const children = new Map<string, { type: string; oid: string }>();
  for (const [p, f] of files) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const first = rest.split('/')[0]!;
    if (!children.has(first)) {
      children.set(first, { type: rest.includes('/') ? 'dir' : 'file', oid: rest.includes('/') ? '' : f.oid });
    }
  }
  if (children.size === 0) { err(res, 404, 'Not Found'); return; }
  // Directory tree oids: resolve from the tree walk for dir entries.
  const out: Array<Record<string, unknown>> = [];
  for (const [fname, info] of [...children.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    let sha = info.oid;
    if (info.type === 'dir') {
      sha = dirTreeOid(repo, c.tree, `${cleanPath}/${fname}`) ?? '';
    }
    out.push({ type: info.type, name: fname, path: `${cleanPath}/${fname}`, sha });
  }
  json(res, 200, out);
}

/** The tree oid of a directory path inside a tree, or null. */
function dirTreeOid(repo: Repo, treeOid: string, dirPath: string): string | null {
  const parts = dirPath.split('/').filter((p) => p !== '');
  let cur = treeOid;
  for (const part of parts) {
    const obj = repo.objects.get(cur);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
    if (entry === undefined) return null;
    cur = entry.oid;
  }
  return cur;
}

export function handlePutContents(ctx: RestContext, res: ServerResponse, owner: string, name: string, path: string): void {
  const repo = resolveRepo(ctx, res, owner, name);
  if (repo === null) return;
  if (ctx.bodyError) { err(res, 400, 'Invalid JSON body'); return; }
  const body = bodyOf(ctx);
  const message = typeof body.message === 'string' ? body.message : '';
  const contentB64 = typeof body.content === 'string' ? body.content : '';
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const sha = typeof body.sha === 'string' ? body.sha : null;
  if (message === '' || contentB64 === '') { err(res, 422, 'message and content are required'); return; }
  let data: Buffer;
  try {
    data = Buffer.from(contentB64, 'base64');
    if (data.toString('base64').replace(/=+$/, '') !== contentB64.replace(/=+$/, '')) throw new Error('bad base64');
  } catch {
    err(res, 400, 'content is not valid base64');
    return;
  }
  const cleanPath = path.replace(/^\/+|\/+$/g, '');
  if (cleanPath === '') { err(res, 422, 'path is required'); return; }

  const refName = `refs/heads/${branch}`;
  let tip = refCommit(repo, refName);
  if (tip === null) {
    // Create the branch from the default branch tip (or empty when there is none).
    const base = branch === repo.defaultBranch ? null : refCommit(repo, `refs/heads/${repo.defaultBranch}`);
    if (base !== null) repo.refs.set(refName, base);
    tip = base;
  }
  const files = filesOfCommit(repo, tip);
  const existing = files.get(cleanPath);
  const isUpdate = existing !== undefined;
  if (isUpdate && sha !== null && sha !== existing.oid) {
    err(res, 409, 'sha does not match the current blob');
    return;
  }
  if (!isUpdate && sha !== null) {
    err(res, 409, 'sha does not match: the file does not exist');
    return;
  }
  const blobOid = storeObject(repo.objects, 'blob', data);
  const next = new Map(files);
  next.set(cleanPath, { oid: blobOid, mode: '100644' });
  const treeOid = makeTree(repo, next);
  const commitOid = makeCommit(repo, {
    tree: treeOid,
    parents: tip === null ? [] : [tip],
    message,
  });
  repo.refs.set(refName, commitOid);
  json(res, isUpdate ? 200 : 201, {
    content: contentsFileView(repo, cleanPath, blobOid, data),
    commit: { sha: commitOid, message },
  });
}

export function handleDeleteContents(ctx: RestContext, res: ServerResponse, owner: string, name: string, path: string): void {
  const repo = resolveRepo(ctx, res, owner, name);
  if (repo === null) return;
  if (ctx.bodyError) { err(res, 400, 'Invalid JSON body'); return; }
  const body = bodyOf(ctx);
  const message = typeof body.message === 'string' ? body.message : '';
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const sha = typeof body.sha === 'string' ? body.sha : null;
  const cleanPath = path.replace(/^\/+|\/+$/g, '');
  const refName = `refs/heads/${branch}`;
  const tip = refCommit(repo, refName);
  if (tip === null) { err(res, 404, 'Not Found'); return; }
  const files = filesOfCommit(repo, tip);
  const existing = files.get(cleanPath);
  if (existing === undefined) { err(res, 404, 'Not Found'); return; }
  if (sha !== null && sha !== existing.oid) {
    err(res, 409, 'sha does not match the current blob');
    return;
  }
  const next = new Map(files);
  next.delete(cleanPath);
  const treeOid = makeTree(repo, next);
  const commitOid = makeCommit(repo, {
    tree: treeOid,
    parents: [tip],
    message: message === '' ? `Delete ${cleanPath}` : message,
  });
  repo.refs.set(refName, commitOid);
  json(res, 200, { commit: { sha: commitOid, message } });
}

// ---------------------------------------------------------------- labels

export function handleCreateLabel(ctx: RestContext, res: ServerResponse, owner: string, name: string): void {
  const repo = resolveRepo(ctx, res, owner, name);
  if (repo === null) return;
  if (ctx.bodyError) { err(res, 400, 'Invalid JSON body'); return; }
  const body = bodyOf(ctx);
  const labelName = typeof body.name === 'string' ? body.name : '';
  if (labelName === '') { err(res, 422, 'name is required'); return; }
  const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
  const description = typeof body.description === 'string' ? body.description : '';
  // Upsert: the suite creates a default label name through this route and expects 201.
  const existing = repo.labels.get(labelName);
  if (existing !== undefined) {
    existing.color = color;
    if (description !== '') existing.description = description;
    json(res, 201, labelView(existing));
    return;
  }
  const label: Label = { name: labelName, color, description };
  repo.labels.set(labelName, label);
  json(res, 201, labelView(label));
}

export function handleListLabels(ctx: RestContext, res: ServerResponse, owner: string, name: string): void {
  const repo = resolveRepo(ctx, res, owner, name);
  if (repo === null) return;
  json(res, 200, [...repo.labels.values()].map(labelView));
}

// ---------------------------------------------------------------- issues

export function handleCreateIssue(ctx: RestContext, res: ServerResponse, owner: string, name: string): void {
  const repo = resolveRepo(ctx, res, owner, name);
  if (repo === null) return;
  if (ctx.bodyError) { err(res, 400, 'Invalid JSON body'); return; }
  const body = bodyOf(ctx);
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') { err(res, 422, 'title is required'); return; }
  const labels: string[] = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
  for (const l of labels) {
    if (!repo.labels.has(l)) { err(res, 422, `Label ${l} does not exist`); return; }
  }
  const issue = createIssueRecord(ctx.store, repo, title, typeof body.body === 'string' ? body.body : '', labels);
  json(res, 201, issueView(repo, issue));
}

export function createIssueRecord(store: Store, repo: Repo, title: string, body: string, labels: string[]): Issue {
  const issue: Issue = {
    number: repo.nextNumber++,
    id: store.nextItemId(),
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    createdSeq: 0,
    updatedSeq: 0,
    authorLogin: VIEWER.login,
  };
  issue.createdSeq = nextSeq();
  issue.updatedSeq = issue.createdSeq;
  repo.issues.set(issue.number, issue);
  return issue;
}

export function handleListIssues(ctx: RestContext, req: IncomingMessage, res: ServerResponse, owner: string, name: string): void {
  const repo = resolveRepo(ctx, res, owner, name);
  if (repo === null) return;
  const state = (ctx.query.get('state') ?? 'open').toLowerCase();
  const direction = (ctx.query.get('direction') ?? 'desc').toLowerCase();
  let issues = [...repo.issues.values()];
  if (state === 'open') issues = issues.filter((i) => i.state === 'open');
  else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
  issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  const page = pageOf(ctx.query);
  const { slice, totalPages } = paginate(issues, page);
  json(res, 200, slice.map((i) => issueView(repo, i)), { link: linkHeader(ctx, req, page, totalPages) });
}

export function handleGetIssue(ctx: RestContext, res: ServerResponse, owner: string, name: string, number: number): void {
  const repo = resolveRepo(ctx, res, owner, name);
  if (repo === null) return;
  const issue = repo.issues.get(number);
  if (issue === undefined) { err(res, 404, 'Not Found'); return; }
  json(res, 200, issueView(repo, issue));
}

export function handlePatchIssue(ctx: RestContext, res: ServerResponse, owner: string, name: string, number: number): void {
  const repo = resolveRepo(ctx, res, owner, name);
  if (repo === null) return;
  if (ctx.bodyError) { err(res, 400, 'Invalid JSON body'); return; }
  const issue = repo.issues.get(number);
  if (issue === undefined) { err(res, 404, 'Not Found'); return; }
  const body = bodyOf(ctx);
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
  if (Array.isArray(body.labels)) {
    const labels = body.labels.filter((l): l is string => typeof l === 'string');
    for (const l of labels) if (!repo.labels.has(l)) { err(res, 422, `Label ${l} does not exist`); return; }
    issue.labels = labels;
  }
  issue.updatedSeq = nextSeq();
  json(res, 200, issueView(repo, issue));
}

export function handleCreateComment(ctx: RestContext, res: ServerResponse, owner: string, name: string, number: number): void {
  const repo = resolveRepo(ctx, res, owner, name);
  if (repo === null) return;
  if (ctx.bodyError) { err(res, 400, 'Invalid JSON body'); return; }
  const issue = repo.issues.get(number);
  if (issue === undefined) { err(res, 404, 'Not Found'); return; }
  const body = bodyOf(ctx);
  const text = typeof body.body === 'string' ? body.body : '';
  if (text === '') { err(res, 422, 'body is required'); return; }
  const comment = {
    id: ctx.store.nextItemId(),
    body: text,
    createdSeq: 0,
    authorLogin: VIEWER.login,
  };
  comment.createdSeq = nextSeq();
  issue.comments.push(comment);
  json(res, 201, commentView(repo, issue, comment));
}

export function handleListComments(ctx: RestContext, res: ServerResponse, owner: string, name: string, number: number): void {
  const repo = resolveRepo(ctx, res, owner, name);
  if (repo === null) return;
  const issue = repo.issues.get(number);
  if (issue === undefined) { err(res, 404, 'Not Found'); return; }
  json(res, 200, issue.comments.map((c) => commentView(repo, issue, c)));
}

// ---------------------------------------------------------------- pulls

export function handleCreatePull(ctx: RestContext, res: ServerResponse, owner: string, name: string): void {
  const repo = resolveRepo(ctx, res, owner, name);
  if (repo === null) return;
  if (ctx.bodyError) { err(res, 400, 'Invalid JSON body'); return; }
  const body = bodyOf(ctx);
  const title = typeof body.title === 'string' ? body.title : '';
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : '';
  if (title === '' || head === '' || base === '') { err(res, 422, 'title, head and base are required'); return; }
  const headSha = refCommit(repo, `refs/heads/${head}`);
  const baseSha = refCommit(repo, `refs/heads/${base}`);
  if (headSha === null || baseSha === null) { err(res, 422, 'head or base branch does not exist'); return; }
  const pull = createPullRecord(ctx.store, repo, title, typeof body.body === 'string' ? body.body : '', head, base, headSha, baseSha);
  json(res, 201, pullView(repo, pull));
}

export function createPullRecord(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  head: string,
  base: string,
  headSha: string,
  baseSha: string,
): Pull {
  const seq = nextSeq();
  const pull: Pull = {
    number: repo.nextNumber++,
    id: store.nextItemId(),
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    createdSeq: seq,
    updatedSeq: seq,
    authorLogin: VIEWER.login,
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}

export function handleListPulls(ctx: RestContext, req: IncomingMessage, res: ServerResponse, owner: string, name: string): void {
  const repo = resolveRepo(ctx, res, owner, name);
  if (repo === null) return;
  const state = (ctx.query.get('state') ?? 'open').toLowerCase();
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((p) => p.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((p) => p.state === 'closed');
  pulls.sort((a, b) => b.createdSeq - a.createdSeq);
  const page = pageOf(ctx.query);
  const { slice, totalPages } = paginate(pulls, page);
  json(res, 200, slice.map((p) => pullView(repo, p)), { link: linkHeader(ctx, req, page, totalPages) });
}

export function handleGetPull(ctx: RestContext, res: ServerResponse, owner: string, name: string, number: number): void {
  const repo = resolveRepo(ctx, res, owner, name);
  if (repo === null) return;
  const pull = repo.pulls.get(number);
  if (pull === undefined) { err(res, 404, 'Not Found'); return; }
  json(res, 200, pullView(repo, pull));
}

export function handleListPullFiles(ctx: RestContext, res: ServerResponse, owner: string, name: string, number: number): void {
  const repo = resolveRepo(ctx, res, owner, name);
  if (repo === null) return;
  const pull = repo.pulls.get(number);
  if (pull === undefined) { err(res, 404, 'Not Found'); return; }
  const base = mergeBase(repo, pull.headSha, pull.baseSha);
  const headFiles = filesOfCommit(repo, pull.headSha);
  const baseFiles = base === null ? new Map<string, { oid: string; mode: string }>() : filesOfCommit(repo, base);
  const out: Array<Record<string, unknown>> = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const oldFile = baseFiles.get(path);
    const newFile = headFiles.get(path);
    if (oldFile === undefined && newFile !== undefined) {
      const obj = repo.objects.get(newFile.oid);
      const text = obj !== undefined && obj.type === 'blob' ? obj.data.toString('utf8') : '';
      const additions = text === '' ? 0 : text.split('\n').length;
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (oldFile !== undefined && newFile === undefined) {
      const obj = repo.objects.get(oldFile.oid);
      const text = obj !== undefined && obj.type === 'blob' ? obj.data.toString('utf8') : '';
      const deletions = text === '' ? 0 : text.split('\n').length;
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (oldFile !== undefined && newFile !== undefined && oldFile.oid !== newFile.oid) {
      const oldObj = repo.objects.get(oldFile.oid);
      const newObj = repo.objects.get(newFile.oid);
      const oldText = oldObj !== undefined && oldObj.type === 'blob' ? oldObj.data.toString('utf8') : '';
      const newText = newObj !== undefined && newObj.type === 'blob' ? newObj.data.toString('utf8') : '';
      const { additions, deletions } = lineDiff(oldText, newText);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  json(res, 200, out);
}

export function handleMergePull(ctx: RestContext, res: ServerResponse, owner: string, name: string, number: number): void {
  const repo = resolveRepo(ctx, res, owner, name);
  if (repo === null) return;
  if (ctx.bodyError) { err(res, 400, 'Invalid JSON body'); return; }
  const pull = repo.pulls.get(number);
  if (pull === undefined) { err(res, 404, 'Not Found'); return; }
  if (pull.state !== 'open') { err(res, 405, 'Pull request is already closed'); return; }
  const headSha = refCommit(repo, `refs/heads/${pull.headRef}`);
  const baseSha = refCommit(repo, `refs/heads/${pull.baseRef}`);
  if (headSha === null || baseSha === null) { err(res, 422, 'head or base branch does not exist'); return; }
  const base = mergeBase(repo, headSha, baseSha);
  if (base === null) { err(res, 405, 'No merge base'); return; }
  const merged = doMergePull(repo, pull);
  if (!merged.ok) { err(res, 405, 'Merge conflict'); return; }
  pull.updatedSeq = nextSeq();
  json(res, 200, { merged: true, sha: merged.sha, message: pull.title });
}

/** Is a PR mergeable right now (no file-level conflict)? */
export function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const headSha = refCommit(repo, `refs/heads/${pull.headRef}`);
  const baseSha = refCommit(repo, `refs/heads/${pull.baseRef}`);
  if (headSha === null || baseSha === null) return 'UNKNOWN';
  const base = mergeBase(repo, headSha, baseSha);
  if (base === null) return 'UNKNOWN';
  const baseCommit = commitOf(repo, baseSha);
  const headCommit = commitOf(repo, headSha);
  const mbCommit = commitOf(repo, base);
  if (baseCommit === null || headCommit === null || mbCommit === null) return 'UNKNOWN';
  const merged = threeWayMerge(repo, baseCommit.tree, headCommit.tree, mbCommit.tree, treeCache(repo));
  return merged === null ? 'CONFLICTING' : 'MERGEABLE';
}
