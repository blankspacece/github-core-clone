// mcp.ts — Model Context Protocol endpoint (POST /mcp, streamable HTTP, plain JSON bodies).
// Supports the modern 2026-07-28 era (server/discover) and the legacy initialize handshake.

import { Buffer } from 'node:buffer';
import { VIEWER, doMergePull, refCommit, type Repo, type Store } from './store.ts';
import { createIssueRecord, createPullRecord, issueView, pullView, repoView } from './rest.ts';

export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
  handler: (store: Store, args: Record<string, unknown>) => unknown;
}

function repoJson(store: Store, owner: string, repoName: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, repoName) ?? null;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
    handler: (store, args) => {
      const name = String(args.name ?? '');
      if (name === '') throw new Error('name is required');
      const existing = store.getRepo(VIEWER.login, name);
      if (existing !== undefined) throw new Error(`repository ${name} already exists`);
      const repo = store.createRepo(VIEWER.login, name, {
        private: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
      });
      return repoView(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
    handler: (store, args) => {
      const repo = repoJson(store, String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === null) throw new Error('repository not found');
      return repoView(repo);
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
    handler: (store, args) => {
      const repo = repoJson(store, String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === null) throw new Error('repository not found');
      const issue = createIssueRecord(store, repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', []);
      return issueView(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
    },
    required: ['owner', 'repo'],
    handler: (store, args) => {
      const repo = repoJson(store, String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === null) throw new Error('repository not found');
      const state = String(args.state ?? 'open').toLowerCase();
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((i) => i.state === 'open');
      else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
      issues.sort((a, b) => b.createdSeq - a.createdSeq);
      return issues.map((i) => issueView(repo, i));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
    handler: (store, args) => {
      const repo = repoJson(store, String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === null) throw new Error('repository not found');
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      const headSha = refCommit(repo, `refs/heads/${head}`);
      const baseSha = refCommit(repo, `refs/heads/${base}`);
      if (headSha === null || baseSha === null) throw new Error('head or base branch does not exist');
      const pull = createPullRecord(store, repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', head, base, headSha, baseSha);
      return pullView(repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
    handler: (store, args) => {
      const repo = repoJson(store, String(args.owner ?? ''), String(args.repo ?? ''));
      if (repo === null) throw new Error('repository not found');
      const number = Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (pull === undefined) throw new Error('pull request not found');
      const merged = doMergePull(repo, pull);
      if (!merged.ok) throw new Error('pull request cannot be merged');
      return { merged: true, number: pull.number, sha: merged.sha, state: pull.state };
    },
  },
];

function toolList(): Array<Record<string, unknown>> {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: {
      type: 'object',
      properties: t.properties,
      required: t.required,
      additionalProperties: false,
    },
  }));
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export interface McpOutcome {
  status: number;
  body: Buffer | null;
  contentType: string;
}

function jsonBody(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

/** Handle one POST /mcp request body. Returns the HTTP status and body (null body = 202 empty). */
export function handleMcp(store: Store, rawBody: Buffer): McpOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return {
      status: 400,
      body: jsonBody({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
      contentType: 'application/json',
    };
  }
  if (!isRecord(parsed)) {
    return {
      status: 400,
      body: jsonBody({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }),
      contentType: 'application/json',
    };
  }
  const req = parsed as JsonRpcRequest;
  const id = req.id ?? null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = isRecord(req.params) ? req.params : {};

  // A notification (no id) is acknowledged with 202 and an empty body.
  if (req.id === undefined) {
    return { status: 202, body: null, contentType: 'application/json' };
  }

  const result = (value: unknown): McpOutcome => ({
    status: 200,
    body: jsonBody({ jsonrpc: '2.0', id, result: value }),
    contentType: 'application/json',
  });
  const error = (code: number, message: string): McpOutcome => ({
    status: 200,
    body: jsonBody({ jsonrpc: '2.0', id, error: { code, message } }),
    contentType: 'application/json',
  });

  if (method === 'server/discover') {
    return result({
      supportedVersions: MCP_SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return result({
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    });
  }
  if (method === 'tools/list') {
    return result({ tools: toolList() });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const tool = TOOLS.find((t) => t.name === name);
    if (tool === undefined) {
      return error(-32602, `unknown tool ${name}`);
    }
    const missing = tool.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      return result({
        content: [{ type: 'text', text: `missing required argument(s): ${missing.join(', ')}` }],
        isError: true,
      });
    }
    try {
      const value = tool.handler(store, args);
      return result({
        content: [{ type: 'text', text: JSON.stringify(value) }],
        structuredContent: value,
      });
    } catch (err) {
      return result({
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      });
    }
  }
  if (method === 'ping') {
    return result({});
  }
  return error(-32601, `Method not found: ${method}`);
}
