# github-core-clone

A GitHub-compatible git forge in a single Node process, built for
[the contest](https://make.fun/bounty/github-core-clone-01). One process serves all four
surfaces agents already speak — git smart HTTP v2, the REST v3 API, GraphQL v4, and MCP —
backed by its own on-disk store. Pure Node standard library: no dependencies, no database,
no `git` binary at run time.

## Run it

```sh
node main.ts
```

Node 22.18 or later strips the TypeScript types on its own. There is nothing to install and
nothing to configure: the program binds an ephemeral port, registers it with the harness env
(see Lifecycle), and serves until the env says the trial is done.

## What it serves

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-OAuth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: initialize, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack`, including shallow fetch and deepen |
| anything else | 404 `{"message":"Not Found"}` |

Every API call carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (`/healthz` excepted); a
missing or wrong token is refused. Every REST reply is `application/json` with a non-empty
`X-GitHub-Request-Id`, and error bodies carry a string `message`.

The git layer speaks the pack protocol itself: it reads and writes packfiles, resolves deltas,
walks history, and verifies objects, so `clone`, `fetch`, and `push` work against a real `git`
client with no `git` binary on the box. Repositories, issues, and pull requests live in the
store under `/tmp` (the only writable path in a trial); the entry's own tree is mounted
read-only.

## Layout

- `main.ts`: the entry lifecycle — bind, register, wait for done, exit (see below).
- `app.ts`: the HTTP server and routing.
- `gitserver.ts`: git smart HTTP and the pack protocol.
- `gitutil.ts`: packfile read/write, delta resolution, object walking.
- `store.ts`: the on-disk store for repositories, issues, and pull requests.
- `rest.ts`: the REST v3 resources.
- `graphql.ts`: the GraphQL v4 schema and resolvers.
- `mcp.ts`: the MCP tools over streamable HTTP.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): metadata and licence.

## Lifecycle (main.ts)

The harness env is a server started beside this one; its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as
   JSON. The env records the address the request came from plus that port as the base URL and
   dials it from then on. The first register wins; a later one is answered `409`.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers `{"done":false}` while the suite
   runs and `{"done":true}` once its export is written. Poll it with a short exponential
   backoff; never exit before it says `true`.
4. **Exit 0** when it does. The server is closed first — keep-alive sockets are dropped, then
   the close is awaited — and the harness stops the env afterwards.

A failed register or poll is retried with a short exponential backoff. If `MAKEFUN_ENV_URL` is
unset there is nothing to talk to, so the program exits 1 at once.

## Score

Graded locally against the kit's sealed suite (`grade-local`): 120/120 conformance checks,
feature 600, agent 200, perf 178 — **978/1000**, above the reference forge's ~900.

## Rules and limits

The rules, the scoring weights, the deadline, and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01**. In short: Node 22 only, no dependencies at
run time, no internet and no `git` binary in the trial; the repository is mounted read-only at
`/bot` and only `/tmp` is writable. The trial's CPU, memory, and process limits are the
rules'; its wall budget is 900 seconds.
