// gitserver.ts — git smart HTTP: advertisements, v2 ls-refs/fetch, v0 fetch, receive-pack.
// Implements the byte-level contract the conformance client expects.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  isObjectId,
  parseCommit,
  parsePktLines,
  parseTag,
  parseTree,
  pktLine,
  readPack,
  verifyPackChecksum,
  writePack,
  type GitObject,
} from './gitutil.ts';
import {
  ancestors,
  commitOf,
  peelToCommit,
  type Repo,
  type Store,
} from './store.ts';

const AGENT = 'github-core-clone/1.0.0';

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendJsonError(res: ServerResponse, status: number, message: string): void {
  const text = `${JSON.stringify({ message })}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** Refs sorted by name; HEAD is handled separately. */
export function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const out: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) out.push({ name, oid });
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function headOid(repo: Repo): string | null {
  const oid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return oid ?? null;
}

/** The v0 capability list for upload-pack advertisements. */
function uploadPackV0Caps(repo: Repo): string {
  return [
    'multi_ack',
    'multi_ack_detailed',
    'no-progress',
    'side-band-64k',
    'thin-pack',
    'ofs-delta',
    'shallow',
    `agent=${AGENT}`,
    `symref=HEAD:refs/heads/${repo.defaultBranch}`,
    'object-format=sha1',
  ].join(' ');
}

/** The v0 capability list for receive-pack advertisements. */
function receivePackV0Caps(repo: Repo): string {
  return [
    'report-status',
    'report-status-v2',
    'side-band-64k',
    'delete-refs',
    'ofs-delta',
    `agent=${AGENT}`,
    `symref=HEAD:refs/heads/${repo.defaultBranch}`,
    'object-format=sha1',
  ].join(' ');
}

function v0Advertisement(repo: Repo, service: 'upload-pack' | 'receive-pack'): Buffer {
  const caps = service === 'upload-pack' ? uploadPackV0Caps(repo) : receivePackV0Caps(repo);
  const serviceLine = service === 'upload-pack' ? '# service=git-upload-pack\n' : '# service=git-receive-pack\n';
  const chunks: Buffer[] = [pktLine(serviceLine), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    // HEAD first (when it resolves), then the refs; capabilities ride the first line.
    const head = headOid(repo);
    let first = true;
    const emit = (oid: string, name: string, extra?: string): void => {
      let line = `${oid} ${name}`;
      if (first) {
        line += `\0${caps}`;
        first = false;
      }
      if (extra !== undefined) line += extra;
      chunks.push(pktLine(`${line}\n`));
    };
    if (head !== null) emit(head, 'HEAD');
    for (const ref of refs) {
      emit(ref.oid, ref.name);
      // Peeled annotated tags get a ^{} line.
      const obj = repo.objects.get(ref.oid);
      if (obj !== undefined && obj.type === 'tag') {
        const peeled = peelToCommit(repo, ref.oid);
        if (peeled !== null) emit(peeled, `${ref.name}^{}`);
      }
    }
  }
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

function v2Advertisement(): Buffer {
  const chunks: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ];
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- info/refs

export function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  repoName: string,
  service: string | null,
): void {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendJsonError(res, 404, 'Not Found');
    return;
  }
  if (service === 'git-upload-pack') {
    const wantV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    const body = wantV2 ? v2Advertisement() : v0Advertisement(repo, 'upload-pack');
    sendBuffer(res, 200, body, 'application/x-git-upload-pack-advertisement');
    return;
  }
  if (service === 'git-receive-pack') {
    sendBuffer(res, 200, v0Advertisement(repo, 'receive-pack'), 'application/x-git-receive-pack-advertisement');
    return;
  }
  sendJsonError(res, 400, 'unknown service');
}

// ---------------------------------------------------------------- ls-refs (v2)

interface LsRefsRequest {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefs(lines: string[]): LsRefsRequest | null {
  // lines[0] is 'command=ls-refs'; a delim separates headers from args.
  const req: LsRefsRequest = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let seenDelim = false;
  for (const raw of lines.slice(1)) {
    const line = raw.replace(/\n$/, '');
    if (line === '') continue;
    if (raw === '\u0001') { seenDelim = true; continue; }
    if (!seenDelim && line.startsWith('agent=')) continue;
    if (!seenDelim && line.startsWith('object-format=')) continue;
    if (line === 'peel') { req.peel = true; continue; }
    if (line === 'symrefs') { req.symrefs = true; continue; }
    if (line === 'unborn') { req.unborn = true; continue; }
    if (line.startsWith('ref-prefix ')) { req.prefixes.push(line.slice('ref-prefix '.length)); continue; }
    if (line.startsWith('ref-prefix\t')) { req.prefixes.push(line.slice('ref-prefix\t'.length)); continue; }
  }
  return req;
}

function handleLsRefs(repo: Repo, req: LsRefsRequest): Buffer {
  const chunks: Buffer[] = [];
  const matchPrefix = (name: string): boolean => req.prefixes.length === 0 || req.prefixes.some((p) => name.startsWith(p));
  const head = headOid(repo);
  const refs = sortedRefs(repo);
  const mainRef = `refs/heads/${repo.defaultBranch}`;

  if (refs.length === 0) {
    // Empty repository: the unborn HEAD line.
    let line = 'unborn HEAD';
    if (req.symrefs) line += ` symref-target:${mainRef}`;
    chunks.push(pktLine(`${line}\n`));
  } else {
    if (head !== null && matchPrefix('HEAD')) {
      let line = `${head} HEAD`;
      if (req.symrefs) line += ` symref-target:${mainRef}`;
      chunks.push(pktLine(`${line}\n`));
    }
    for (const ref of refs) {
      if (!matchPrefix(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (req.peel) {
        const obj = repo.objects.get(ref.oid);
        if (obj !== undefined && obj.type === 'tag') {
          const peeled = peelToCommit(repo, ref.oid);
          if (peeled !== null) line += ` peeled:${peeled}`;
        }
      }
      chunks.push(pktLine(`${line}\n`));
    }
  }
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- fetch

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  deepenRelative: boolean;
}

function parseFetch(lines: string[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, deepenSince: null, deepenNot: [], deepenRelative: false };
  for (const raw of lines.slice(1)) {
    const line = raw.replace(/\n$/, '');
    if (line === '') continue;
    if (line.startsWith('thin-pack')) continue;
    if (line.startsWith('no-progress')) continue;
    if (line.startsWith('ofs-delta')) continue;
    if (line.startsWith('agent=')) continue;
    if (line.startsWith('object-format=')) continue;
    if (line.startsWith('filter ')) continue;
    if (line === 'done') continue;
    if (line === 'wait-for-done') continue;
    if (line.startsWith('want ')) { const oid = line.slice(5).trim(); if (isObjectId(oid)) req.wants.push(oid); continue; }
    if (line.startsWith('have ')) { const oid = line.slice(5).trim(); if (isObjectId(oid)) req.haves.push(oid); continue; }
    if (line.startsWith('shallow ')) { const oid = line.slice(8).trim(); if (isObjectId(oid)) req.shallow.push(oid); continue; }
    if (line.startsWith('deepen ')) { const n = Number.parseInt(line.slice(7).trim(), 10); if (Number.isFinite(n) && n > 0) req.depth = n; continue; }
    if (line === 'deepen-relative') { req.deepenRelative = true; continue; }
    if (line.startsWith('deepen-since ')) { const n = Number.parseInt(line.slice(13).trim(), 10); if (Number.isFinite(n)) req.deepenSince = n; continue; }
    if (line.startsWith('deepen-not ')) { req.deepenNot.push(line.slice(11).trim()); continue; }
  }
  return req;
}

function commitTimestamp(repo: Repo, oid: string): number | null {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return null;
  const parsed = parseCommit(obj.data);
  if (parsed === null) return null;
  // committer line: "Name <email> <ts> +0000"
  const m = parsed.committer.match(/ (\d+) [+-]\d{4}$/);
  return m ? Number.parseInt(m[1]!, 10) : null;
}

interface FetchPlan {
  included: Set<string>; // commits to send
  boundary: string[]; // new shallow boundaries
  unshallow: string[]; // old boundaries now fully included
  sendObjects: Map<string, GitObject>; // oid -> object (already minus haves)
  acks: string[];
  nak: boolean;
}

function planFetch(repo: Repo, req: FetchRequest): FetchPlan {
  const wants = [...new Set(req.wants)];
  // Peel wanted tags to commits; remember the tag objects themselves.
  const tagObjects: Array<{ oid: string; obj: GitObject }> = [];
  const wantCommits: string[] = [];
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      tagObjects.push({ oid: want, obj });
      const peeled = peelToCommit(repo, want);
      if (peeled !== null) wantCommits.push(peeled);
    } else if (obj.type === 'commit') {
      wantCommits.push(want);
    }
  }

  const shallowSet = new Set(req.shallow);
  // Commits the client actually holds: ancestors of the haves, but not below
  // a shallow boundary — a shallow clone holds a boundary commit's own
  // objects, not its parents'. (For a non-shallow fetch there are no
  // boundaries, so this is the full ancestor closure.)
  const heldCommits = new Set<string>();
  const heldStack = [...req.haves];
  while (heldStack.length > 0) {
    const oid = heldStack.pop()!;
    if (heldCommits.has(oid)) continue;
    const c = commitOf(repo, oid);
    if (c === null) continue;
    heldCommits.add(oid);
    if (shallowSet.has(oid)) continue; // boundary: held itself, not its parents
    for (const p of c.parents) heldStack.push(p);
  }
  // deepen-not refs are a hard exclusion: never traversed, in either walk.
  const notClosure = new Set<string>();
  for (const ref of req.deepenNot) {
    const tip = refCommitOf(repo, ref);
    if (tip !== null) {
      for (const a of ancestors(repo, tip)) notClosure.add(a);
    }
  }

  // Walk from the wants, computing for each reachable commit:
  //   distance     — generations from the nearest want (0 = a want)
  //   boundaryDist — distance from the nearest want to the first shallow
  //                  boundary on the path to this commit (Infinity if none)
  // A depth-limited walk ignores the haves for traversal: the client deepens
  // from a commit it already holds (the want itself is a have), and the walk
  // must still descend from it to the depth limit. The haves only exclude
  // objects from the pack. An unbounded walk stops at the haves: everything
  // below a have is already held.
  // deepen-relative (what real git sends for --deepen): the deepen count is
  // relative to the client's current shallow boundaries — a commit is
  // included when distance <= boundaryDist + deepen. Without it, deepen is
  // an absolute depth from the wants (distance < deepen).
  const bounded = req.depth !== null || req.deepenSince !== null;
  const relative = req.deepenRelative && req.shallow.length > 0 && req.depth !== null;
  // For each reachable commit, the best (largest-slack) visit: slack is how
  // far inside its effective depth limit the commit sits. A commit is
  // included when some visit has slack >= 0. Keeping the best visit makes
  // the result path-independent (merge histories included).
  const slackOf = (depth: number, bd: number): number => {
    if (relative) {
      return bd === Number.POSITIVE_INFINITY ? (req.depth! - 1) - depth : (bd + req.depth!) - depth;
    }
    return req.depth !== null ? (req.depth - 1) - depth : Number.POSITIVE_INFINITY;
  };
  const dist = new Map<string, number>();
  const bdist = new Map<string, number>();
  const bestSlack = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number; bd: number }> = wantCommits.map((oid) => ({ oid, depth: 0, bd: Number.POSITIVE_INFINITY }));
  let qhead = 0;
  while (qhead < queue.length) {
    const { oid, depth, bd } = queue[qhead++]!;
    // First shallow boundary on this path (a boundary commit resets the
    // relative limit to its own distance + deepen).
    const bdHere = shallowSet.has(oid) && bd === Number.POSITIVE_INFINITY ? depth : bd;
    const slackHere = slackOf(depth, bdHere);
    const prevSlack = bestSlack.get(oid);
    if (prevSlack !== undefined && slackHere <= prevSlack) continue;
    if (notClosure.has(oid)) continue;
    // Unbounded walk: stop at a held commit, but descend through a shallow
    // boundary — the client holds the boundary itself, not its ancestors.
    if (!bounded && heldCommits.has(oid) && !shallowSet.has(oid)) continue;
    const c = commitOf(repo, oid);
    if (c === null) continue;
    dist.set(oid, depth);
    bdist.set(oid, bdHere);
    bestSlack.set(oid, slackHere);
    // Expand to parents only if they could still be included: a non-boundary
    // parent sits one deeper (slack - 1); a boundary parent resets its own
    // limit to its distance + deepen in the relative case. This keeps a
    // depth-1 clone of a long history at O(1) commits visited.
    for (const p of c.parents) {
      if (slackHere >= 1 || (relative && shallowSet.has(p))) {
        queue.push({ oid: p, depth: depth + 1, bd: bdHere });
      }
    }
  }
  const included = new Set<string>();
  // A root commit is a shallow boundary only when the depth limit actually
  // cut the history there (it sits exactly at the limit). A root reached
  // because the history simply ends (e.g. --unshallow's deepen INT_MAX) is
  // not a boundary — it is unshallowed instead.
  const atLimit = new Set<string>();
  for (const [oid, depth] of dist) {
    if (req.deepenSince !== null) {
      const ts = commitTimestamp(repo, oid);
      if (ts !== null && ts < req.deepenSince) continue; // too old: a boundary, not included
    }
    if (relative) {
      const bd = bdist.get(oid)!;
      const limit = bd === Number.POSITIVE_INFINITY ? req.depth! - 1 : bd + req.depth!;
      if (depth > limit) continue;
      if (depth === limit) atLimit.add(oid);
    } else if (req.depth !== null) {
      if (depth >= req.depth) continue; // absolute depth from the wants
      if (depth === req.depth - 1) atLimit.add(oid);
    }
    included.add(oid);
  }

  // New shallow boundaries: included commits whose parents are not all included,
  // plus root commits that sit exactly at the depth limit.
  const boundary: string[] = [];
  for (const oid of included) {
    const c = commitOf(repo, oid);
    if (c === null) continue;
    if (c.parents.length === 0) {
      if (atLimit.has(oid)) boundary.push(oid);
      continue;
    }
    if (c.parents.some((p) => !included.has(p))) boundary.push(oid);
  }

  // Old boundaries that are now fully included are unshallow.
  const unshallow: string[] = [];
  for (const old of req.shallow) {
    if (!included.has(old)) continue;
    const c = commitOf(repo, old);
    if (c === null) continue;
    if (c.parents.every((p) => included.has(p))) unshallow.push(old);
  }

  // Objects to send: everything reachable from the included commits, minus the haves' objects.
  const sendObjects = new Map<string, GitObject>();
  const collectTree = (treeOid: string): void => {
    const obj = repo.objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return;
    sendObjects.set(treeOid, obj);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') collectTree(entry.oid);
      else {
        const blob = repo.objects.get(entry.oid);
        if (blob !== undefined) sendObjects.set(entry.oid, blob);
      }
    }
  };
  for (const oid of included) {
    const obj = repo.objects.get(oid);
    if (obj !== undefined) sendObjects.set(oid, obj);
    const c = commitOf(repo, oid);
    if (c !== null) collectTree(c.tree);
  }
  for (const tag of tagObjects) sendObjects.set(tag.oid, tag.obj);

  // Subtract everything the client already holds (reachable from the haves).
  const haveObjects = new Set<string>();
  const collectHave = (treeOid: string): void => {
    const obj = repo.objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return;
    haveObjects.add(treeOid);
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') collectHave(entry.oid);
      else haveObjects.add(entry.oid);
    }
  };
  for (const oid of heldCommits) {
    haveObjects.add(oid);
    const c = commitOf(repo, oid);
    if (c !== null) collectHave(c.tree);
  }
  for (const oid of haveObjects) sendObjects.delete(oid);

  // ACKs: haves the server actually has.
  const acks = req.haves.filter((h) => repo.objects.has(h));
  return { included, boundary, unshallow, sendObjects, acks, nak: acks.length === 0 };
}

function refCommitOf(repo: Repo, ref: string): string | null {
  const oid = repo.refs.get(ref);
  if (oid === undefined) return null;
  return peelToCommit(repo, oid);
}

function sidebandFrames(pack: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  const MAX = 65515; // 65520 - 4 (pkt header) - 1 (band byte)
  let off = 0;
  while (off < pack.length) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + MAX));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    frames.push(pktLine(payload));
    off += chunk.length;
  }
  return frames;
}

function handleFetchV2(repo: Repo, req: FetchRequest): Buffer {
  const plan = planFetch(repo, req);
  const chunks: Buffer[] = [];
  // acknowledgments: only when the client sent haves to negotiate. A clone with no
  // haves gets no acknowledgments section at all (real git's upload-pack behaves so,
  // and real git clients expect the packfile section next).
  if (req.haves.length > 0) {
    chunks.push(pktLine('acknowledgments\n'));
    if (plan.nak) chunks.push(pktLine('NAK\n'));
    else {
      for (const ack of plan.acks) chunks.push(pktLine(`ACK ${ack}\n`));
      chunks.push(pktLine('ready\n'));
    }
    chunks.push(PKT_DELIM);
  }
  // shallow-info (only when there is something to say)
  if (plan.boundary.length > 0 || plan.unshallow.length > 0) {
    chunks.push(pktLine('shallow-info\n'));
    for (const oid of plan.boundary) chunks.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
    chunks.push(PKT_DELIM);
  }
  // packfile: always sent for a deepen request (real git sends a valid empty
  // pack when there is nothing new to deliver, and errors if the section is
  // absent); omitted entirely for a non-deepen fetch with nothing to send.
  if (plan.sendObjects.size > 0 || req.depth !== null) {
    const pack = writePack(plan.sendObjects);
    chunks.push(pktLine('packfile\n'));
    chunks.push(...sidebandFrames(pack));
  }
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

function handleFetchV0(repo: Repo, req: FetchRequest): Buffer {
  const plan = planFetch(repo, req);
  const chunks: Buffer[] = [];
  if (plan.nak) chunks.push(pktLine('NAK\n'));
  else for (const ack of plan.acks) chunks.push(pktLine(`ACK ${ack}\n`));
  // v0 never sends `ready`.
  for (const oid of plan.boundary) chunks.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
  if (plan.sendObjects.size > 0 || req.depth !== null) {
    const pack = writePack(plan.sendObjects);
    chunks.push(...sidebandFrames(pack));
  }
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePushCommands(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } {
  // The command list is pkt-lines up to the first flush; the rest is the raw pack.
  let off = 0;
  const commands: PushCommand[] = [];
  while (off < body.length) {
    if (off + 4 > body.length) throw new Error('truncated pkt-line in push');
    const hex = body.subarray(off, off + 4).toString('ascii');
    const len = parseInt(hex, 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line length in push');
    if (len === 0) { off += 4; break; }
    if (len < 4 || off + len > body.length) throw new Error('bad pkt-line in push');
    const payload = body.subarray(off + 4, off + len).toString('utf8');
    off += len;
    const line = payload.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const cmdText = nul >= 0 ? line.slice(0, nul) : line;
    const parts = cmdText.split(' ');
    if (parts.length !== 3) throw new Error(`bad push command ${JSON.stringify(cmdText)}`);
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid)) throw new Error('bad push command oid');
    commands.push({ oldOid, newOid, ref });
  }
  const pack = off < body.length ? body.subarray(off) : null;
  return { commands, pack };
}

function runReceivePack(repo: Repo, body: Buffer): Buffer {
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  let commands: PushCommand[] = [];
  let pack: Buffer | null = null;
  try {
    const parsed = parsePushCommands(body);
    commands = parsed.commands;
    pack = parsed.pack;
  } catch (err) {
    unpackOk = false;
    unpackDetail = err instanceof Error ? err.message : 'unpacker error';
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackOk && commands.length > 0) {
    const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
    if (needsPack) {
      if (pack === null || pack.length === 0) {
        unpackOk = false;
        unpackDetail = 'unpacker error';
      } else {
        try {
          const read = readPack(pack);
          for (const [oid, obj] of read.objects) {
            if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
          }
        } catch (err) {
          unpackOk = false;
          unpackDetail = err instanceof Error ? err.message : 'unpacker error';
        }
      }
    }
  }

  if (!unpackOk) {
    for (const c of commands) results.push({ ref: c.ref, ok: false, reason: 'unpacker error' });
  } else {
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
        else if (current !== cmd.oldOid) results.push({ ref: cmd.ref, ok: false, reason: 'old value does not match' });
        else { repo.refs.delete(cmd.ref); results.push({ ref: cmd.ref, ok: true, reason: '' }); }
        continue;
      }
      if (cmd.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) results.push({ ref: cmd.ref, ok: false, reason: 'already exists' });
        else if (!repo.objects.has(cmd.newOid)) results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
        else { repo.refs.set(cmd.ref, cmd.newOid); results.push({ ref: cmd.ref, ok: true, reason: '' }); }
        continue;
      }
      // Update.
      if (current === undefined) results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
      else if (current !== cmd.oldOid) results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      else if (!repo.objects.has(cmd.newOid)) results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      else {
        const newCommit = peelToCommit(repo, cmd.newOid);
        const oldCommit = peelToCommit(repo, cmd.oldOid);
        if (newCommit === null || oldCommit === null) {
          results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        } else if (newCommit !== oldCommit && !isFastForward(repo, oldCommit, newCommit)) {
          results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          repo.refs.set(cmd.ref, cmd.newOid);
          results.push({ ref: cmd.ref, ok: true, reason: '' });
        }
      }
    }
  }

  reportLines.push(`unpack ${unpackDetail}\n`);
  for (const r of results) {
    reportLines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  }
  // The report stream is itself pkt-lined inside band 1, terminated by an inner flush
  // (real git's receive-pack sends the whole report in one band-1 packet, inner flush
  // included; a reader that never sees the inner flush reports "remote end hung up").
  const inner = Buffer.concat([...reportLines.map((line) => pktLine(line)), PKT_FLUSH]);
  const chunks: Buffer[] = [];
  const MAX = 65515; // 65520 - 4 (pkt header) - 1 (band byte)
  for (let off = 0; off < inner.length; off += MAX) {
    const piece = inner.subarray(off, Math.min(inner.length, off + MAX));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), piece])));
  }
  chunks.push(PKT_FLUSH);
  return Buffer.concat(chunks);
}

function isFastForward(repo: Repo, oldCommit: string, newCommit: string): boolean {
  // Targeted reachability: walk back from the new tip and stop the moment the
  // old tip is found. A linear fast-forward is one or two steps; computing
  // the full ancestor set here would be quadratic over a push chain.
  if (oldCommit === newCommit) return true;
  const seen = new Set<string>();
  const stack = [newCommit];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === oldCommit) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const c = commitOf(repo, oid);
    if (c === null) continue;
    for (const p of c.parents) stack.push(p);
  }
  return false;
}

// ---------------------------------------------------------------- entry points

/** Read the whole request body (git bodies are small: packs up to a few hundred KiB). */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function handleUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  repoName: string,
): Promise<void> {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendJsonError(res, 404, 'Not Found');
    return;
  }
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    sendJsonError(res, 400, 'could not read request body');
    return;
  }
  let out: Buffer;
  try {
    const packets = parsePktLines(body);
    const lines = packets.filter((p) => p.kind === 'data').map((p) => (p as { payload: Buffer }).payload.toString('utf8'));
    const first = lines[0]?.replace(/\n$/, '') ?? '';
    if (first === 'command=ls-refs') {
      const parsed = parseLsRefs(lines);
      if (parsed === null) throw new Error('bad ls-refs request');
      out = handleLsRefs(repo, parsed);
    } else if (first === 'command=fetch') {
      const parsed = parseFetch(lines);
      const wantV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      out = wantV2 ? handleFetchV2(repo, parsed) : handleFetchV0(repo, parsed);
    } else {
      throw new Error(`unknown git-upload-pack command ${JSON.stringify(first)}`);
    }
  } catch (err) {
    // A malformed pkt-line (or anything else unparseable) is a 400; the server stays up.
    sendJsonError(res, 400, err instanceof Error ? err.message : 'bad request');
    return;
  }
  sendBuffer(res, 200, out, 'application/x-git-upload-pack-result');
}

export async function handleReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  repoName: string,
): Promise<void> {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendJsonError(res, 404, 'Not Found');
    return;
  }
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    sendJsonError(res, 400, 'could not read request body');
    return;
  }
  let out: Buffer;
  try {
    out = runReceivePack(repo, body);
  } catch {
    // Never die on a push: answer a bare unpack failure (inner-flushed, like the real one).
    const inner = Buffer.concat([pktLine('unpack unpacker error\n'), PKT_FLUSH]);
    out = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), inner])), PKT_FLUSH]);
  }
  sendBuffer(res, 200, out, 'application/x-git-receive-pack-result');
}

// Re-exported for the packet checksum helper used by the bench's clone verification path.
export { verifyPackChecksum };
