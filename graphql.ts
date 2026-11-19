// graphql.ts — a small GraphQL executor for the documents the conformance suite sends.
// Supports: query/mutation, variables, aliases, arguments (literals, enums, input objects,
// lists, null), inline fragments, and __type introspection for Issue/PullRequest/Repository/SearchType.

import { Buffer } from 'node:buffer';
import {
  VIEWER,
  commitOf,
  doMergePull,
  flattenTree,
  mergeBase,
  refCommit,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { createIssueRecord, createPullRecord, pullMergeable } from './rest.ts';

// ---------------------------------------------------------------- global ids

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

export function repoGlobalId(repo: Repo): string {
  return b64(`Repository:${repo.id}`);
}
export function issueGlobalId(repo: Repo, issue: Issue): string {
  return b64(`Issue:${repo.id}:${issue.number}`);
}
export function pullGlobalId(repo: Repo, pull: Pull): string {
  return b64(`PullRequest:${repo.id}:${pull.number}`);
}
export function commentGlobalId(repo: Repo, issue: Issue, commentId: number): string {
  return b64(`IssueComment:${repo.id}:${issue.number}:${commentId}`);
}

interface DecodedId {
  kind: string;
  repoId: number;
  number: number;
  commentId: number;
}

export function decodeGlobalId(id: string): DecodedId | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    const kind = parts[0]!;
    const repoId = Number.parseInt(parts[1]!, 10);
    if (!Number.isFinite(repoId)) return null;
    return {
      kind,
      repoId,
      number: parts.length > 2 ? Number.parseInt(parts[2]!, 10) : 0,
      commentId: parts.length > 3 ? Number.parseInt(parts[3]!, 10) : 0,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- parser

interface FieldNode {
  alias: string;
  name: string;
  args: Record<string, unknown>;
  selections: SelectionNode[];
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition: string | null; selections: SelectionNode[] };

interface Operation {
  kind: 'query' | 'mutation';
  selections: SelectionNode[];
}

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: '...' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < input.length && input[i] !== '\n') i += 1; continue; }
    if (ch === '.' && input.slice(i, i + 3) === '...') { tokens.push({ kind: 'spread', value: '...' }); i += 3; continue; }
    if ('{}()[]:!=$@'.includes(ch)) { tokens.push({ kind: 'punct', value: ch }); i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j]!;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'number', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (t === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return t;
  }

  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected ${value} in GraphQL document, got ${t.value}`);
  }

  private expectName(value?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected a name in GraphQL document, got ${t.value}`);
    if (value !== undefined && t.value !== value) throw new Error(`expected ${value} in GraphQL document, got ${t.value}`);
    return t.value;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.tokens.length) {
      ops.push(this.parseOperation());
    }
    return ops;
  }

  private parseOperation(): Operation {
    const t = this.next();
    let kind: 'query' | 'mutation' = 'query';
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      kind = t.value;
      const after = this.peek();
      if (after !== undefined && after.kind === 'name') this.next(); // operation name
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.parseVariableDefinitions();
    } else if (t.kind === 'punct' && t.value === '{') {
      this.pos -= 1; // shorthand query: rewind to the brace
    } else {
      throw new Error(`unexpected token ${t.value} in GraphQL document`);
    }
    const selections = this.parseSelectionSet();
    return { kind, selections };
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (true) {
      const t = this.next();
      if (t.kind === 'punct' && t.value === ')') return;
      if (t.kind !== 'punct' || t.value !== '$') throw new Error('expected $ in variable definitions');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
        this.next();
        this.parseValue();
      }
    }
  }

  private parseType(): void {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '[') {
      this.parseType();
      this.expectPunct(']');
    } else if (t.kind !== 'name') {
      throw new Error('expected a type in GraphQL document');
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (true) {
      const t = this.next();
      if (t.kind === 'punct' && t.value === '}') return selections;
      if (t.kind === 'spread') {
        const next = this.peek();
        if (next !== undefined && next.kind === 'name' && next.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          selections.push({ kind: 'inline', typeCondition, selections: this.parseSelectionSet() });
        } else if (next !== undefined && next.kind === 'name') {
          // Named fragment spread: not used by the suite; skip its selection set if any.
          this.next();
          selections.push({ kind: 'inline', typeCondition: null, selections: [] });
        } else {
          selections.push({ kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() });
        }
        continue;
      }
      if (t.kind !== 'name') throw new Error(`expected a field name, got ${t.value}`);
      let alias = t.value;
      let name = t.value;
      if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
        this.next();
        name = this.expectName();
      }
      let args: Record<string, unknown> = {};
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') args = this.parseArguments();
      let sub: SelectionNode[] = [];
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') sub = this.parseSelectionSet();
      selections.push({ kind: 'field', field: { alias, name, args, selections: sub } });
    }
  }

  private parseArguments(): Record<string, unknown> {
    this.expectPunct('(');
    const args: Record<string, unknown> = {};
    while (true) {
      const t = this.next();
      if (t.kind === 'punct' && t.value === ')') return args;
      if (t.kind !== 'name') throw new Error('expected an argument name');
      this.expectPunct(':');
      args[t.value] = this.parseValue();
    }
  }

  private parseValue(): unknown {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { __variable: this.expectName() };
    if (t.kind === 'string') return t.value;
    if (t.kind === 'number') return Number(t.value);
    if (t.kind === 'punct' && t.value === '[') {
      const items: unknown[] = [];
      while (true) {
        const n = this.peek();
        if (n !== undefined && n.kind === 'punct' && n.value === ']') { this.next(); return items; }
        items.push(this.parseValue());
      }
    }
    if (t.kind === 'punct' && t.value === '{') {
      const obj: Record<string, unknown> = {};
      while (true) {
        const n = this.next();
        if (n.kind === 'punct' && n.value === '}') return obj;
        if (n.kind !== 'name') throw new Error('expected an object field name');
        this.expectPunct(':');
        obj[n.value] = this.parseValue();
      }
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      return { __enum: t.value };
    }
    throw new Error(`unexpected value token ${t.value}`);
  }
}

function substitute(value: unknown, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object') {
    if ('__variable' in (value as Record<string, unknown>)) {
      return variables[(value as Record<string, unknown>).__variable as string] ?? null;
    }
    if ('__enum' in (value as Record<string, unknown>)) {
      return (value as Record<string, unknown>).__enum as string;
    }
    if (Array.isArray(value)) return value.map((v) => substitute(v, variables));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = substitute(v, variables);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------- execution

interface GqlContext {
  store: Store;
}

type GqlObject = Record<string, unknown> & { __t: string };

interface FieldResolver {
  (parent: GqlObject, args: Record<string, unknown>, ctx: GqlContext): unknown;
}

const FIELD_TABLES: Record<string, Record<string, FieldResolver>> = {};

function fields(typeName: string, table: Record<string, FieldResolver>): void {
  FIELD_TABLES[typeName] = table;
}

function repoOf(ctx: GqlContext, repoId: number): Repo | undefined {
  for (const repo of ctx.store.repos.values()) if (repo.id === repoId) return repo;
  return undefined;
}

function cursorFor(number: number): string {
  return b64(`cursor:${number}`);
}

function numberFromCursor(cursor: string | null | undefined): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

interface ConnectionResult {
  nodes: GqlObject[];
  hasNextPage: boolean;
  endCursor: string | null;
}

function issueConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  const first = typeof args.first === 'number' ? args.first : 30;
  const after = numberFromCursor(typeof args.after === 'string' ? args.after : null);
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
  let issues = [...repo.issues.values()];
  if (states !== null) {
    const wanted = new Set(states.map((s) => s.toLowerCase()));
    issues = issues.filter((i) => wanted.has(i.state));
  }
  issues.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  if (after !== null) {
    const idx = issues.findIndex((i) => i.number === after);
    if (idx >= 0) issues = issues.slice(idx + 1);
  }
  const page = issues.slice(0, first);
  const hasNextPage = issues.length > first;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null;
  return {
    __t: 'IssueConnection',
    _nodes: page.map((issue) => ({ __t: 'Issue', repo, issue }) as GqlObject),
    _hasNextPage: hasNextPage,
    _endCursor: endCursor,
  };
}

function pullConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  const first = typeof args.first === 'number' ? args.first : 30;
  const after = numberFromCursor(typeof args.after === 'string' ? args.after : null);
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  let pulls = [...repo.pulls.values()];
  if (states !== null) {
    const wanted = new Set(states.map((s) => s.toUpperCase()));
    pulls = pulls.filter((p) => {
      const st = p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED';
      return wanted.has(st);
    });
  }
  pulls.sort((a, b) => b.createdSeq - a.createdSeq);
  if (after !== null) {
    const idx = pulls.findIndex((p) => p.number === after);
    if (idx >= 0) pulls = pulls.slice(idx + 1);
  }
  const page = pulls.slice(0, first);
  return {
    __t: 'PullRequestConnection',
    _nodes: page.map((pull) => ({ __t: 'PullRequest', repo, pull }) as GqlObject),
    _hasNextPage: pulls.length > first,
    _endCursor: page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null,
  };
}

function fileConnection(repo: Repo, pull: Pull, args: Record<string, unknown>): GqlObject {
  const first = typeof args.first === 'number' ? args.first : 30;
  const base = mergeBase(repo, pull.headSha, pull.baseSha);
  const headFiles = flattenTreeOf(repo, pull.headSha);
  const baseFiles = base === null ? new Map<string, { oid: string; mode: string }>() : flattenTreeOf(repo, base);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const changed: string[] = [];
  for (const path of paths) {
    if (baseFiles.get(path)?.oid !== headFiles.get(path)?.oid) changed.push(path);
  }
  changed.sort();
  const page = changed.slice(0, first);
  return {
    __t: 'FileConnection',
    _nodes: page.map((path) => ({ __t: 'File', path }) as GqlObject),
    _hasNextPage: changed.length > first,
    _endCursor: null,
  };
}

const treeCacheByRepo = new WeakMap<Repo, Map<string, Map<string, { oid: string; mode: string }>>>();
function flattenTreeOf(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  let cache = treeCacheByRepo.get(repo);
  if (cache === undefined) {
    cache = new Map();
    treeCacheByRepo.set(repo, cache);
  }
  const c = commitOf(repo, commitOid);
  if (c === null) return new Map();
  return flattenTree(repo, c.tree, cache);
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function findRepoByOwnerName(ctx: GqlContext, owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER.login) return undefined;
  return ctx.store.getRepo(owner, name);
}

fields('Query', {
  viewer: () => ({ __t: 'User', login: VIEWER.login, id: VIEWER.id }),
  repository: (_parent, args, ctx) => {
    const repo = findRepoByOwnerName(ctx, String(args.owner ?? ''), String(args.name ?? ''));
    return repo === undefined ? null : ({ __t: 'Repository', repo } as GqlObject);
  },
  node: (_parent, args, ctx) => {
    const decoded = typeof args.id === 'string' ? decodeGlobalId(args.id) : null;
    if (decoded === null) return null;
    const repo = repoOf(ctx, decoded.repoId);
    if (repo === undefined) return null;
    if (decoded.kind === 'Repository') return { __t: 'Repository', repo } as GqlObject;
    if (decoded.kind === 'Issue') {
      const issue = repo.issues.get(decoded.number);
      return issue === undefined ? null : ({ __t: 'Issue', repo, issue } as GqlObject);
    }
    if (decoded.kind === 'PullRequest') {
      const pull = repo.pulls.get(decoded.number);
      return pull === undefined ? null : ({ __t: 'PullRequest', repo, pull } as GqlObject);
    }
    return null;
  },
  __type: (_parent, args) => {
    const name = String(args.name ?? '');
    return introspectionType(name);
  },
});

fields('User', {
  login: (parent) => parent.login,
  id: (parent) => b64(`User:${parent.id as number}`),
  name: (parent) => parent.login,
});

fields('Repository', {
  id: (parent) => repoGlobalId((parent.repo as Repo)),
  databaseId: (parent) => (parent.repo as Repo).id,
  name: (parent) => (parent.repo as Repo).name,
  nameWithOwner: (parent) => `${(parent.repo as Repo).owner}/${(parent.repo as Repo).name}`,
  description: (parent) => (parent.repo as Repo).description,
  owner: (parent) => ({ __t: 'User', login: (parent.repo as Repo).owner, id: VIEWER.id }),
  defaultBranchRef: (parent) => {
    const repo = parent.repo as Repo;
    const tip = refCommit(repo, `refs/heads/${repo.defaultBranch}`);
    return tip === null ? null : ({ __t: 'Ref', name: repo.defaultBranch } as GqlObject);
  },
  viewerPermission: () => 'ADMIN',
  hasIssuesEnabled: () => true,
  issue: (parent, args) => {
    const repo = parent.repo as Repo;
    const issue = repo.issues.get(Number(args.number));
    return issue === undefined ? null : ({ __t: 'Issue', repo, issue } as GqlObject);
  },
  issues: (parent, args) => issueConnection(parent.repo as Repo, args),
  pullRequests: (parent, args) => pullConnection(parent.repo as Repo, args),
  pullRequest: (parent, args) => {
    const repo = parent.repo as Repo;
    const pull = repo.pulls.get(Number(args.number));
    return pull === undefined ? null : ({ __t: 'PullRequest', repo, pull } as GqlObject);
  },
});

fields('Ref', {
  name: (parent) => parent.name,
});

fields('Issue', {
  id: (parent) => issueGlobalId(parent.repo as Repo, parent.issue as Issue),
  databaseId: (parent) => (parent.issue as Issue).id,
  number: (parent) => (parent.issue as Issue).number,
  title: (parent) => (parent.issue as Issue).title,
  body: (parent) => (parent.issue as Issue).body,
  state: (parent) => issueState(parent.issue as Issue),
});

fields('PullRequest', {
  id: (parent) => pullGlobalId(parent.repo as Repo, parent.pull as Pull),
  databaseId: (parent) => (parent.pull as Pull).id,
  number: (parent) => (parent.pull as Pull).number,
  title: (parent) => (parent.pull as Pull).title,
  body: (parent) => (parent.pull as Pull).body,
  state: (parent) => pullState(parent.pull as Pull),
  merged: (parent) => (parent.pull as Pull).merged,
  headRefName: (parent) => (parent.pull as Pull).headRef,
  baseRefName: (parent) => (parent.pull as Pull).baseRef,
  mergeable: (parent) => pullMergeable(parent.repo as Repo, parent.pull as Pull),
  files: (parent, args) => fileConnection(parent.repo as Repo, parent.pull as Pull, args),
});

fields('IssueConnection', {
  nodes: (parent) => parent._nodes,
  pageInfo: (parent) => ({ __t: 'PageInfo', _hasNextPage: parent._hasNextPage, _endCursor: parent._endCursor }),
  totalCount: (parent) => (parent._nodes as unknown[]).length,
});

fields('PullRequestConnection', {
  nodes: (parent) => parent._nodes,
  pageInfo: (parent) => ({ __t: 'PageInfo', _hasNextPage: parent._hasNextPage, _endCursor: parent._endCursor }),
  totalCount: (parent) => (parent._nodes as unknown[]).length,
});

fields('FileConnection', {
  nodes: (parent) => parent._nodes,
  pageInfo: (parent) => ({ __t: 'PageInfo', _hasNextPage: parent._hasNextPage, _endCursor: parent._endCursor }),
});

fields('File', {
  path: (parent) => parent.path,
});

fields('PageInfo', {
  hasNextPage: (parent) => parent._hasNextPage,
  endCursor: (parent) => parent._endCursor,
});

fields('IssueComment', {
  id: (parent) => parent.id,
  body: (parent) => parent.body,
});

fields('Mutation', {
  createIssue: (_parent, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
    if (decoded === null || decoded.kind !== 'Repository') return { __t: 'CreateIssuePayload', _issue: null } as GqlObject;
    const repo = repoOf(ctx, decoded.repoId);
    if (repo === undefined) return { __t: 'CreateIssuePayload', _issue: null } as GqlObject;
    const issue = createIssueRecord(ctx.store, repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
    return { __t: 'CreateIssuePayload', _issue: { __t: 'Issue', repo, issue } } as GqlObject;
  },
  closeIssue: (_parent, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
    if (decoded === null || decoded.kind !== 'Issue') return { __t: 'CloseIssuePayload', _issue: null } as GqlObject;
    const repo = repoOf(ctx, decoded.repoId);
    const issue = repo?.issues.get(decoded.number);
    if (issue === undefined) return { __t: 'CloseIssuePayload', _issue: null } as GqlObject;
    issue.state = 'closed';
    return { __t: 'CloseIssuePayload', _issue: { __t: 'Issue', repo, issue } } as GqlObject;
  },
  createPullRequest: (_parent, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
    if (decoded === null || decoded.kind !== 'Repository') return { __t: 'CreatePullRequestPayload', _pull: null } as GqlObject;
    const repo = repoOf(ctx, decoded.repoId);
    if (repo === undefined) return { __t: 'CreatePullRequestPayload', _pull: null } as GqlObject;
    const headRef = String(input.headRefName ?? '');
    const baseRef = String(input.baseRefName ?? '');
    const headSha = refCommit(repo, `refs/heads/${headRef}`);
    const baseSha = refCommit(repo, `refs/heads/${baseRef}`);
    if (headSha === null || baseSha === null) return { __t: 'CreatePullRequestPayload', _pull: null } as GqlObject;
    const pull = createPullRecord(ctx.store, repo, String(input.title ?? ''), '', headRef, baseRef, headSha, baseSha);
    return { __t: 'CreatePullRequestPayload', _pull: { __t: 'PullRequest', repo, pull } } as GqlObject;
  },
  mergePullRequest: (_parent, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
    if (decoded === null || decoded.kind !== 'PullRequest') return { __t: 'MergePullRequestPayload', _pull: null } as GqlObject;
    const repo = repoOf(ctx, decoded.repoId);
    const pull = repo?.pulls.get(decoded.number);
    if (pull === undefined || repo === undefined) return { __t: 'MergePullRequestPayload', _pull: null } as GqlObject;
    const merged = doMergePull(repo, pull);
    if (!merged.ok) return { __t: 'MergePullRequestPayload', _pull: null } as GqlObject;
    return { __t: 'MergePullRequestPayload', _pull: { __t: 'PullRequest', repo, pull } } as GqlObject;
  },
  addComment: (_parent, args, ctx) => {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
    if (decoded === null || decoded.kind !== 'Issue') return { __t: 'AddCommentPayload', _comment: null } as GqlObject;
    const repo = repoOf(ctx, decoded.repoId);
    const issue = repo?.issues.get(decoded.number);
    if (issue === undefined || repo === undefined) return { __t: 'AddCommentPayload', _comment: null } as GqlObject;
    const commentId = ctx.store.nextItemId();
    const comment = { id: commentId, body: String(input.body ?? ''), createdSeq: 0, authorLogin: VIEWER.login };
    issue.comments.push(comment);
    return {
      __t: 'AddCommentPayload',
      _comment: { __t: 'IssueComment', id: commentGlobalId(repo, issue, commentId), body: comment.body },
      _edge: { __t: 'IssueCommentEdge', _node: { __t: 'IssueComment', id: commentGlobalId(repo, issue, commentId), body: comment.body } },
    } as GqlObject;
  },
});

fields('CreateIssuePayload', {
  issue: (parent) => parent._issue,
});
fields('CloseIssuePayload', {
  issue: (parent) => parent._issue,
});
fields('CreatePullRequestPayload', {
  pullRequest: (parent) => parent._pull,
});
fields('MergePullRequestPayload', {
  pullRequest: (parent) => parent._pull,
});
fields('AddCommentPayload', {
  commentEdge: (parent) => parent._edge,
});
fields('IssueCommentEdge', {
  node: (parent) => parent._node,
});

fields('__Type', {
  name: (parent) => parent._name,
  kind: (parent) => parent._kind,
  fields: (parent) => (parent._fields as string[]).map((name) => ({ __t: '__Field', _name: name })),
  enumValues: (parent) => ((parent._enumValues as string[]) ?? []).map((name) => ({ __t: '__EnumValue', _name: name })),
});
fields('__Field', {
  name: (parent) => parent._name,
});
fields('__EnumValue', {
  name: (parent) => parent._name,
});

const INTROSPECTION: Record<string, { kind: string; fields: string[]; enumValues: string[] }> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'author', 'comments', 'createdAt', 'url', 'labels', 'repository'],
    enumValues: [],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'author', 'createdAt', 'url'],
    enumValues: [],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'url'],
    enumValues: [],
  },
  SearchType: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  },
};

function introspectionType(name: string): GqlObject | null {
  const def = INTROSPECTION[name];
  if (def === undefined) return null;
  return { __t: '__Type', _name: name, _kind: def.kind, _fields: def.fields, _enumValues: def.enumValues } as GqlObject;
}

// ---------------------------------------------------------------- executor

interface ExecError {
  message: string;
}

function executeSelections(
  selections: SelectionNode[],
  parent: GqlObject,
  ctx: GqlContext,
  errors: ExecError[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const table = FIELD_TABLES[parent.__t] ?? {};
  for (const sel of selections) {
    if (sel.kind === 'inline') {
      if (sel.typeCondition !== null && sel.typeCondition !== parent.__t) continue;
      Object.assign(out, executeSelections(sel.selections, parent, ctx, errors));
      continue;
    }
    const field = sel.field;
    const resolver = table[field.name];
    if (resolver === undefined) {
      errors.push({ message: `Cannot query field "${field.name}" on type "${parent.__t}".` });
      out[field.alias] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(field.args)) args[k] = substitute(v, CURRENT_VARIABLES);
    let value: unknown;
    try {
      value = resolver(parent, args, ctx);
    } catch (err) {
      errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[field.alias] = null;
      continue;
    }
    out[field.alias] = completeValue(value, field.selections, ctx, errors);
  }
  return out;
}

let CURRENT_VARIABLES: Record<string, unknown> = {};

function completeValue(value: unknown, selections: SelectionNode[], ctx: GqlContext, errors: ExecError[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => completeValue(v, selections, ctx, errors));
  if (typeof value === 'object' && selections.length > 0) {
    return executeSelections(selections, value as GqlObject, ctx, errors);
  }
  return value;
}

export interface GqlResult {
  data: unknown;
  errors?: ExecError[];
}

export function executeGraphQL(store: Store, query: string, variables: Record<string, unknown>): GqlResult {
  const ctx: GqlContext = { store };
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (operations.length === 0) return { data: null, errors: [{ message: 'no operation in document' }] };
  const op = operations[0]!;
  CURRENT_VARIABLES = variables;
  const errors: ExecError[] = [];
  const root: GqlObject = { __t: op.kind === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelections(op.selections, root, ctx, errors);
  CURRENT_VARIABLES = {};
  if (errors.length > 0) return { data, errors };
  return { data };
}
