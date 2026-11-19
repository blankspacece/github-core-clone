// app.ts — the HTTP server: routing, auth, request ids, JSON bodies.
// The entry (main.ts) imports createApp() and nothing else.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, readBody } from './gitserver.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import * as rest from './rest.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The shop token the env gives the entry; when unset, any non-empty bearer token is accepted. */
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestCounter = 0;
function requestId(): string {
  requestCounter += 1;
  return `gh-${process.pid.toString(36)}-${Date.now().toString(36)}-${requestCounter.toString(36)}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = { 'content-type': JSON_TYPE, 'x-github-request-id': requestId(), ...extraHeaders };
  if (status !== 204) headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  res.end(text);
}

function pathOf(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { pathname: url.pathname, query: url.searchParams };
  } catch {
    return { pathname: '/', query: new URLSearchParams() };
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  if (SHOP_TOKEN !== '') return token === SHOP_TOKEN;
  return true;
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body; returns {body, error} — error is true when the body was present but invalid. */
function parseJsonBody(raw: Buffer): { body: unknown; error: boolean } {
  if (raw.length === 0) return { body: null, error: false };
  try {
    return { body: JSON.parse(raw.toString('utf8')) as unknown, error: false };
  } catch {
    return { body: null, error: true };
  }
}

export function createApp(): Server {
  const store = new Store();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const { pathname, query } = pathOf(req);
      const method = req.method ?? 'GET';

      // The env's boot check: 200 {"ok":true}, no auth.
      if (method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Git smart HTTP: /<owner>/<repo>.git/info/refs and .../git-upload-pack | git-receive-pack.
      const gitMatch = pathname.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/);
      if (gitMatch !== null) {
        if (!isAuthorized(req)) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }
        const owner = decodeSegment(gitMatch[1]!);
        const repoName = decodeSegment(gitMatch[2]!);
        const service = gitMatch[3]!;
        if (method === 'GET' && service === 'info/refs') {
          handleInfoRefs(req, res, store, owner, repoName, query.get('service'));
          return;
        }
        if (method === 'POST' && service === 'git-upload-pack') {
          await handleUploadPack(req, res, store, owner, repoName);
          return;
        }
        if (method === 'POST' && service === 'git-receive-pack') {
          await handleReceivePack(req, res, store, owner, repoName);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      // GraphQL v4.
      if (pathname === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (!isAuthorized(req)) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }
        const raw = await readRawBody(req);
        const { body, error } = parseJsonBody(raw);
        if (error) {
          sendJson(res, 400, { errors: [{ message: 'Invalid JSON body' }] });
          return;
        }
        if (Array.isArray(body)) {
          // Batched operations, answered in order.
          const out = body.map((entry) => {
            if (entry === null || typeof entry !== 'object' || typeof (entry as Record<string, unknown>).query !== 'string') {
              return { data: null, errors: [{ message: 'Invalid GraphQL operation' }] };
            }
            const e = entry as Record<string, unknown>;
            const variables = (e.variables ?? {}) as Record<string, unknown>;
            return executeGraphQL(store, e.query as string, variables);
          });
          sendJson(res, 200, out);
          return;
        }
        if (body === null || typeof body !== 'object' || typeof (body as Record<string, unknown>).query !== 'string') {
          sendJson(res, 400, { errors: [{ message: 'query is required' }] });
          return;
        }
        const variables = ((body as Record<string, unknown>).variables ?? {}) as Record<string, unknown>;
        sendJson(res, 200, executeGraphQL(store, (body as Record<string, unknown>).query as string, variables));
        return;
      }

      // MCP.
      if (pathname === '/mcp') {
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }
        if (!isAuthorized(req)) {
          res.writeHead(401, { 'content-type': JSON_TYPE, 'x-github-request-id': requestId(), 'content-length': String(Buffer.byteLength('{"message":"Bad credentials"}\n')) });
          res.end('{"message":"Bad credentials"}\n');
          return;
        }
        const raw = await readRawBody(req);
        const outcome = handleMcp(store, raw);
        if (outcome.body === null) {
          res.writeHead(outcome.status, { 'x-github-request-id': requestId() });
          res.end();
          return;
        }
        res.writeHead(outcome.status, {
          'content-type': outcome.contentType,
          'x-github-request-id': requestId(),
          'content-length': outcome.body.length,
        });
        res.end(outcome.body);
        return;
      }

      // REST v3.
      if (pathname === '/api/v3' || pathname === '/api/v3/') {
        if (method === 'GET') {
          const ctx: rest.RestContext = { store, baseUrl: `http://${req.headers.host ?? 'localhost'}`, body: null, bodyError: false, query };
          rest.handleApiRoot(ctx, res);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (pathname.startsWith('/api/v3/')) {
        const segments = pathname.slice('/api/v3/'.length).split('/').map(decodeSegment);
        if (segments.length === 1 && segments[0] === 'meta' && method === 'GET') {
          const ctx: rest.RestContext = { store, baseUrl: `http://${req.headers.host ?? 'localhost'}`, body: null, bodyError: false, query };
          rest.handleMeta(ctx, res);
          return;
        }
        if (!isAuthorized(req)) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }
        const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readRawBody(req);
        const { body, error } = parseJsonBody(raw);
        const ctx: rest.RestContext = {
          store,
          baseUrl: `http://${req.headers.host ?? 'localhost'}`,
          body,
          bodyError: error,
          query,
        };
        routeRest(ctx, req, res, segments, method);
        return;
      }

      // Everything else: GitHub's JSON 404.
      sendJson(res, 404, { message: 'Not Found' });
    })().catch(() => {
      // Never let a request kill the server: answer 500 JSON and stay up.
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      } catch {
        // The socket is already gone; nothing to do.
      }
    });
  });
}

function routeRest(ctx: rest.RestContext, req: IncomingMessage, res: ServerResponse, segments: string[], method: string): void {
  const [first, second, third, ...restSegs] = segments;

  // /api/v3/user and /api/v3/user/repos
  if (first === 'user') {
    if (second === undefined && method === 'GET') {
      rest.handleUser(ctx, res);
      return;
    }
    if (second === 'repos') {
      if (method === 'POST') { rest.handleCreateRepo(ctx, res); return; }
      if (method === 'GET') { rest.handleListUserRepos(ctx, req, res); return; }
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // /api/v3/repos/{owner}/{repo}[/...]
  if (first === 'repos' && second !== undefined && third !== undefined) {
    const owner = second;
    const name = third;
    const tail = restSegs;
    if (tail.length === 0) {
      if (method === 'GET') { rest.handleGetRepo(ctx, res, owner, name); return; }
      if (method === 'PATCH') { rest.handlePatchRepo(ctx, res, owner, name); return; }
      if (method === 'DELETE') { rest.handleDeleteRepo(ctx, res, owner, name); return; }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const [section, ...sub] = tail;
    if (section === 'branches') {
      if (sub.length === 0 && method === 'GET') { rest.handleListBranches(ctx, res, owner, name); return; }
      if (sub.length === 1 && method === 'GET') { rest.handleGetBranch(ctx, res, owner, name, sub[0]!); return; }
    }
    if (section === 'commits' && sub.length === 0 && method === 'GET') {
      rest.handleListCommits(ctx, req, res, owner, name);
      return;
    }
    if (section === 'git' && sub[0] === 'refs') {
      if (sub.length === 1) {
        if (method === 'POST') { rest.handleCreateRef(ctx, res, owner, name); return; }
        if (method === 'GET') { rest.handleListRefs(ctx, res, owner, name); return; }
      }
      if (sub.length > 1 && method === 'GET') {
        rest.handleGetRef(ctx, res, owner, name, sub.slice(1).join('/'));
        return;
      }
    }
    if (section === 'contents') {
      const path = sub.join('/');
      if (method === 'GET') { rest.handleGetContents(ctx, res, owner, name, path); return; }
      if (method === 'PUT') { rest.handlePutContents(ctx, res, owner, name, path); return; }
      if (method === 'DELETE') { rest.handleDeleteContents(ctx, res, owner, name, path); return; }
    }
    if (section === 'labels') {
      if (sub.length === 0 && method === 'POST') { rest.handleCreateLabel(ctx, res, owner, name); return; }
      if (sub.length === 0 && method === 'GET') { rest.handleListLabels(ctx, res, owner, name); return; }
    }
    if (section === 'issues') {
      if (sub.length === 0) {
        if (method === 'POST') { rest.handleCreateIssue(ctx, res, owner, name); return; }
        if (method === 'GET') { rest.handleListIssues(ctx, req, res, owner, name); return; }
      }
      const num = Number(sub[0]);
      if (Number.isInteger(num) && num > 0) {
        if (sub.length === 1) {
          if (method === 'GET') { rest.handleGetIssue(ctx, res, owner, name, num); return; }
          if (method === 'PATCH') { rest.handlePatchIssue(ctx, res, owner, name, num); return; }
        }
        if (sub.length === 2 && sub[1] === 'comments') {
          if (method === 'POST') { rest.handleCreateComment(ctx, res, owner, name, num); return; }
          if (method === 'GET') { rest.handleListComments(ctx, res, owner, name, num); return; }
        }
      }
    }
    if (section === 'pulls') {
      if (sub.length === 0) {
        if (method === 'POST') { rest.handleCreatePull(ctx, res, owner, name); return; }
        if (method === 'GET') { rest.handleListPulls(ctx, req, res, owner, name); return; }
      }
      const num = Number(sub[0]);
      if (Number.isInteger(num) && num > 0) {
        if (sub.length === 1 && method === 'GET') { rest.handleGetPull(ctx, res, owner, name, num); return; }
        if (sub.length === 2 && sub[1] === 'files' && method === 'GET') { rest.handleListPullFiles(ctx, res, owner, name, num); return; }
        if (sub.length === 2 && sub[1] === 'merge' && method === 'PUT') { rest.handleMergePull(ctx, res, owner, name, num); return; }
      }
    }
  }

  sendJson(res, 404, { message: 'Not Found' });
}
