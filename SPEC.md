# github-core-clone-01 — Friday build spec

Source of truth: `../github-core-clone-01-kit/` (sdk/conformance = the sealed suite, byte-identical).
Work dir: this folder (`github-core-clone-01/`), copied from starter. Grade loop:
`node ../github-core-clone-01-kit/cli/makefun.mjs grade-local --kit ../github-core-clone-01-kit --bot . --driver process --worktree`
(No Docker on this machine; process driver only. Verified 2026-11-18: starter scores 15/1000, replay + L1 regrade byte-for-byte.)

## Contest facts

- Deadline: **Sat 2026-11-21 14:30 CST** (2026-11-21T06:30:00Z, API-verified).
- Prize $500, 20 places: 1st $100, 2nd $70, 3rd $50, 4th–10th $20, 11th–20th $14.
- **Prize requires beating the house baseline** (reference forge). Baseline passed 120/120 in calibration
  and earns ~100/200 perf at the current T_refs, i.e. ≈ 900 total. To win money: near-perfect
  conformance AND faster than the reference on the timed workloads.
- Score = feature + agent + perf, 0–1000. Tie-break: lower perf_p50_us, then earlier receipt.
  - feature = round(600 * passed / 120)
  - agent = round(200 * passedMcp / 15) — the MCP group's 15 checks, counted again
  - perf = sum over 4 workloads of round(clamp(25 - 12.5 * log2(t_ms / T_ref_ms), 0, 50)), 0–200.
    t = median of 3 rounds. At t = T_ref a workload scores 25.

## Entry contract (trial runtime)

- `node /bot/main.ts` on Node 22.18+ (server harness 26.13.1; local 24.22.1). Type stripping, no build step.
- **No dependencies, no internet, no `git` binary in the trial.** Pure stdlib (`node:http` + own code).
- Repo mounted read-only at `/bot`; writable only under `/tmp`. Wall budget 900 s.
- Limits: entry 2 CPU / 1024 MiB / 256 pids.
- Lifecycle (keep `main.ts` as-is): `listen(0)` ephemeral port → `POST $MAKEFUN_ENV_URL/register {"port": N}`
  → poll `GET $MAKEFUN_ENV_URL/done` until `{"done": true}` → exit 0. Never bind 8080.
- Auth: every API call carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (same token in env).
  `/healthz` takes none. Missing/wrong token refused (401) — part of protocol checks.
- Routes:
  - `GET /healthz` → 200 `{"ok":true}` (boot probe, called twice)
  - `GET /api/v3/` → 200 JSON, header `X-OAuth-Scopes: repo, read:org`
  - `/api/v3/...` → REST v3 (repos, branches, commits, contents, issues, comments, labels, pulls, files, merges)
  - `POST /api/graphql` → GraphQL v4 (documents `gh` and `github-mcp-server` send)
  - `POST /mcp` → MCP over streamable HTTP (initialize, tools/list, tools/call)
  - `/<owner>/<repo>.git/...` → git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack`
  - anything else → 404 `{"message":"Not Found"}`
- Every REST reply: `application/json`, non-empty `X-GitHub-Request-Id`; errors carry string `message`.

## The 120 checks (all must pass for 800 pts)

### git (30) — `sdk/conformance/checks-git.ts`
advertise-v2 | protocol v2 capability advertisement is served and well formed
advertise-receive-pack | receive-pack serves a v0 ref advertisement with push capabilities
advertise-headers | info/refs answers the smart-HTTP content type and preamble
unknown-repo-404 | a missing repository advertises 404 and the server stays up
ls-refs | v2 ls-refs reports refs, HEAD symref and peeled tags
ls-refs-prefix | v2 ls-refs honours ref-prefix filtering
clone-empty | a repository with no refs clones as an empty repository
push-first-commit | a first commit pushes to an unborn branch and becomes the tip
clone-object-hashes | a full clone verifies object-for-object
clone-blob-bytes | every cloned blob equals the pushed bytes
clone-tree-entries | cloned trees round-trip paths, modes and nested directories
clone-commit-bytes | commit objects round-trip byte-exactly with their metadata
clone-annotated-tag | an annotated tag object round-trips and peels to its commit
fetch-incremental | an incremental fetch sends only the new objects and advances the tip
fetch-nothing-new | a fetch with the tip already held transfers no objects
fetch-shallow-depth1 | a depth-1 shallow clone lands the tip only
fetch-shallow-deepen | deepen 2 extends a shallow clone by exactly one generation
fetch-shallow-new-tip | a shallow fetch of a new tip does not pull the old history
push-update-ref | a fast-forward update moves a branch and clones see it
push-create-branch | creating a branch from an existing commit is reported and advertised
push-delete-branch | deleting a branch is reported and removes the ref
push-non-fast-forward | a non-fast-forward update is refused per-ref and changes nothing
push-mixed-report | one command list reports ok and ng per ref, and applies only the ok one
push-delete-tag | deleting a tag ref is reported and removes the ref
push-100-files | a 100-file single-commit push round-trips byte-exactly
pack-integrity | a fetched pack is structurally valid and checksummed
pack-deltas | delta-compressed objects resolve correctly (when the server sends them)
sideband-framing | the fetch packfile section is valid sideband framing
push-sideband-report | the push report arrives in valid sideband frames
repo-survives-errors | the server stays healthy through 404s, refusals and a malformed request

### repos (15) — `checks-rest.ts`
repos.pagination | GET /user/repos pages 30 seeded repos at per_page=10 through Link rel="next"
repos.root | GET /api/v3/ answers 200 JSON with X-OAuth-Scopes
repos.meta | GET /api/v3/meta reports installed_version
repos.create | POST /user/repos creates and GET round-trips name, private and default_branch
repos.not-found | GET a missing repository is a JSON 404
repos.patch | PATCH /repos/{o}/{r} updates the description
repos.delete | DELETE /repos/{o}/{r} deletes it and a later GET is 404
repos.branches | GET /branches lists a branch created through POST /git/refs
repos.commits | GET /commits reflects a commit made on a branch and not the default branch
repos.unauthorized | a request without a token is 401
repos.foreign-token | the same repository name under another owner is a 404 for this token
repos.contents-create | PUT /contents creates a file with a commit; GET returns base64 content and sha
repos.contents-directory | GET /contents on a directory lists its entries
repos.contents-stale-sha | PUT /contents with a stale sha is 409
repos.contents-delete | DELETE /contents removes the file with a commit and GET is 404

### issues (15)
issues.create | POST /issues creates a 201 open issue with a number
issues.create-title-body | POST /issues echoes the title and body
issues.create-labels | POST /issues attaches an existing label
issues.numbers-increment | issue numbers increment by one
issues.list-open | GET /issues?state=open lists the open issue
issues.list-open-excludes-closed | GET /issues?state=open omits a closed issue
issues.list-sort-asc | GET /issues?sort=created&direction=asc orders by creation
issues.list-sort-desc | GET /issues?sort=created&direction=desc reverses it
issues.list-shape | GET /issues returns the GitHub issue shape
issues.get-one | GET /issues/{n} returns the issue
issues.patch-close | PATCH /issues/{n} closes it
issues.patch-close-persists | the close survives a later GET
issues.comment-create | POST /issues/{n}/comments creates a comment
issues.comments-list | GET /issues/{n}/comments lists the comment
issues.bad-label | POST /issues with an unknown label is 422

### pulls (20)
pulls.create | POST /pulls creates an open pull request from a head branch
pulls.create-body | POST /pulls echoes the title and body
pulls.create-head-sha | the pull head.sha is the head branch tip
pulls.create-base-sha | the pull base.sha is the base branch tip
pulls.get-one | GET /pulls/{n} returns the pull request
pulls.files-list | GET /pulls/{n}/files lists the changed path
pulls.files-shape | pull files carry filename, status and the change counts
pulls.files-multiple | GET /pulls/{n}/files lists every changed path
pulls.merge-status | PUT /pulls/{n}/merge with merge_method=squash is 200
pulls.merge-body | the merge reply is {merged:true, sha, message}
pulls.merge-closes | the merged pull is closed, merged and carries merged_at
pulls.merge-commit-on-default | the merge commit appears on the default branch
pulls.merge-content-on-default | the squash content is on the default branch
pulls.merge-commit-sha | the pull reports merge_commit_sha equal to the merge sha
pulls.merge-unknown | merging an unknown pull request is 404
pulls.merge-conflict | merging a conflicted pull request is 405
pulls.list-state-all | GET /pulls?state=all lists open and merged pull requests
pulls.list-default-open | GET /pulls defaults to open pull requests
pulls.list-shape | GET /pulls returns the GitHub pull-request shape
pulls.get-unknown | GET an unknown pull request is 404

### graphql (20) — `checks-graphql.ts`
viewer-login | query { viewer { login } } answers the token owner
repository-fields | repository(owner:, name:) answers id, databaseId, name, owner, defaultBranchRef, viewerPermission and hasIssuesEnabled
introspection-issue | __type(name: "Issue") lists the fields gh feature-detects
introspection-types | __type lists PullRequest, Repository and SearchType
issues-open-order | issues(first: 10, states: [OPEN], orderBy: CREATED_AT DESC) filters and orders
issue-by-number | issue(number:) reads one issue
create-issue | createIssue creates an issue the REST view sees
close-issue | closeIssue closes an issue the REST view shows closed
pull-requests-list | pullRequests(first: 5) lists number, headRefName, baseRefName, mergeable and state
pull-request-files | pullRequest(number:).files lists the changed paths
create-pull-request | createPullRequest creates a pull request
merge-pull-request | mergePullRequest SQUASH merges and the REST view shows merged: true
add-comment | addComment writes an issue comment the REST view lists
invalid-field | an invalid field is a 200 with an errors array
unauthenticated | an unauthenticated query is a 401
node-repository | node(id:) round-trips a repository
unknown-repository | an unknown repository reads data.repository = null with no errors
batched-operations | two operation documents in one body answer in order
global-id-stability | global ids are opaque and equal on repeated reads
issues-pagination | issues(first, after) pages by cursor to the end

### mcp (15) — `checks-mcp.ts`
mcp.initialize | (session init handshake)
mcp.server-discover | (server info/capabilities)
mcp.tools-list | tools/list returns the tool set
mcp.tools-list-idempotent | repeated tools/list is stable
mcp.tool-schemas | tool input schemas are valid
mcp.create-issue | tools/call create_issue creates an issue
mcp.list-issues | tools/call list_issues lists issues
mcp.create-pull-request | tools/call create_pull_request creates a PR
mcp.merge-pull-request | tools/call merge_pull_request merges
mcp.rest-parity | MCP effects are visible in the REST view
mcp.auth-required | calls without auth are refused
mcp.missing-arguments | missing required args error cleanly
mcp.parse-error | malformed JSON-RPC errors cleanly
mcp.unknown-tool | unknown tool name errors cleanly
mcp.concurrent-calls | concurrent tools/call all succeed

### protocol (5)
protocol.content-type-json | every REST reply is application/json, never HTML
protocol.unknown-route-json-404 | an unknown /api/v3 route is a JSON 404
protocol.malformed-body-400 | a malformed JSON body is a 400
protocol.request-id | every reply carries a non-empty X-GitHub-Request-Id
protocol.error-message | 401, 404 and 422 bodies carry a string message

## Perf workloads + T_ref (production medians, 2026-11-14)

| workload | T_ref p50 | what it times |
| --- | --- | --- |
| push | 1640.82 ms | 200 pushes (suite: 200 pushes, 5 warm-up, 3 timed rounds) |
| clone | 266.941 ms | 50 concurrent clones |
| read | 2759.715 ms | REST/GraphQL read mix |
| write | 348.965 ms | issue/PR write mix |

Faster than T_ref scores >25 per workload. Perf is the only way past the ~900 baseline: keep the
hot path in-memory (objects + refs in memory, no per-request disk sync), stream packfiles, avoid
per-request JSON re-parsing where cheap. Deltas are optional (pack-deltas only applies "when the
server sends them") — plain full-object packs are conformant; add deltas only if time remains.

## Seeded scenario

Practice trials: `../github-core-clone-01-kit/practice/trial-{0,1,2}/` (input/prompt.txt + reference/scenario.json).
The scored trial draws a fresh drand instance; scenario shape is the same. Read
`sdk/conformance/wire.ts` (env contract) and the `*-client.ts` files — they ARE the exact wire spec
the server must answer (pkt-line framing, sideband, v2 commands, REST/GraphQL/MCP shapes).

## Friday build order

1. In-memory store: repos, refs, objects (loose, SHA-1), issues, PRs, comments, labels, users/tokens.
   Seeded data comes from the env via the suite's setup calls (repos created through REST/git by the
   suite itself; the 30 seeded repos for pagination are created by the suite — the server just stores).
2. Git pack protocol (hardest, ~half the score): pkt-line, v2 advertise/ls-refs/fetch, v0
   receive-pack advertise, packfile generation (sideband-64k), packfile parsing (OBJ_COMMIT/TREE/
   BLOB/TAG + OFS/REF deltas), ref updates with fast-forward checks, shallow (depth/deepen),
   annotated-tag peel. Mirror `git-client.ts` (2144 lines) — it defines the exact bytes expected.
3. REST v3: repos/branches/commits/contents/issues/comments/pulls/files/merge + pagination (Link
   headers), error shapes, auth.
4. GraphQL: minimal parser for the exact documents the suite sends (see checks-graphql bodies +
   `graphql-client.ts`); viewer, repository, issues, issue, createIssue, closeIssue, pullRequests,
   pullRequest, createPullRequest, mergePullRequest, addComment, node, __type introspection, batched
   operations, cursor pagination, global ids.
5. MCP: streamable HTTP, JSON-RPC initialize / tools/list / tools/call, tools mirroring the REST
   surface; effects visible via REST.
6. Perf pass: profile the 4 workloads locally (bench.ts), cut hot-path costs.
7. grade-local loop until 120/120 locally; check the export's `working: 1`.

## Submission (Sat before 14:30)

Requires the user's own GitHub account: create a public repo, push the entry (main.ts at root,
OSI licence), submit repo_url + commit_sha (40-char) + transcript bundle (.tar.gz from the kit CLI).
No GitHub account confirmed yet — blocked on the user.
