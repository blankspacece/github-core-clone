// gitutil.ts — git object model, packfile read/write, pkt-line framing.
// Pure Node stdlib. No git binary anywhere.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** SHA-1 of `<type> <size>\0<data>`. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function storeObject(objects: Map<string, GitObject>, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------- commits

export interface CommitParts {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function buildCommit(parts: {
  tree: string;
  parents?: string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  let out = `tree ${parts.tree}\n`;
  for (const p of parts.parents ?? []) out += `parent ${p}\n`;
  out += `author ${parts.author}\ncommitter ${parts.committer}\n\n${parts.message}`;
  return Buffer.from(out, 'utf8');
}

/** Parse a commit object. Returns null when malformed. */
export function parseCommit(data: Buffer): CommitParts | null {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  if (headEnd < 0) return null;
  const head = text.slice(0, headEnd);
  const message = text.slice(headEnd + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  if (!isObjectId(tree)) return null;
  return { tree, parents, author, committer, message };
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree object into its entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(off, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------- tags

export function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } | null {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  if (headEnd < 0) return null;
  const head = text.slice(0, headEnd);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  if (!isObjectId(object)) return null;
  return { object, type, tag, tagger, message: text.slice(headEnd + 2) };
}

// ---------------------------------------------------------------- pkt-line

/** Encode one pkt-line. `line` must already end with '\n' when it is data. */
export function pktLine(line: string | Buffer): Buffer {
  const payload = typeof line === 'string' ? Buffer.from(line, 'utf8') : line;
  const len = payload.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_END = Buffer.from('0002', 'ascii');

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Parse a whole buffer of pkt-lines. Throws on malformed framing. */
export function parsePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line header');
    const hex = buf.subarray(off, off + 4).toString('ascii');
    const len = parseInt(hex, 16);
    if (Number.isNaN(len) || len < 0) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    if (len === 0) { out.push({ kind: 'flush' }); off += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim' }); off += 4; continue; }
    if (len === 2) { out.push({ kind: 'end' }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) throw new Error('bad pkt-line length');
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

/** The data payloads of pkt-lines, as strings (flush/delim/end dropped). */
export function pktDataLines(buf: Buffer): string[] {
  const lines: string[] = [];
  for (const p of parsePktLines(buf)) {
    if (p.kind === 'data') lines.push(p.payload.toString('utf8'));
  }
  return lines;
}

// ---------------------------------------------------------------- packfile

const PACK_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_IDS: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Build a version-2 packfile from plain objects (no deltas). */
// Cache of deflated object payloads, keyed by oid. Objects are immutable
// (content-addressed), so a deflated payload never goes stale. This makes
// repeated packs of the same objects — e.g. 50 concurrent clones of one tip —
// nearly free after the first pack.
const deflateCache = new Map<string, Buffer>();
const DEFLATE_CACHE_MAX = 8192;

export function writePack(entries: Iterable<readonly [string, GitObject]>): Buffer {
  const objs: Array<readonly [string, GitObject]> = [];
  for (const e of entries) objs.push(e);
  const chunks: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objs.length, 8);
  chunks.push(head);
  for (const [oid, obj] of objs) {
    const typeId = PACK_TYPE_IDS[obj.type];
    const data = obj.data;
    // varint header: type in bits 4..6, size low 4 bits, continuation bit 7
    const headerBytes: number[] = [];
    let size = data.length;
    let first = (typeId << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) first |= 0x80;
    headerBytes.push(first);
    while (size > 0) {
      let b = size & 0x7f;
      size >>= 7;
      if (size > 0) b |= 0x80;
      headerBytes.push(b);
    }
    chunks.push(Buffer.from(headerBytes));
    let deflated = deflateCache.get(oid);
    if (deflated === undefined) {
      deflated = deflateSync(data);
      if (deflateCache.size >= DEFLATE_CACHE_MAX) deflateCache.clear();
      deflateCache.set(oid, deflated);
    }
    chunks.push(deflated);
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * Inflate the zlib stream starting at `offset` whose uncompressed size is `expectedSize`.
 * inflateSync ignores trailing bytes and throws on truncation, so the stream end is the
 * smallest length that inflates successfully (binary search; hi always succeeds).
 */
function inflateAt(buf: Buffer, offset: number, expectedSize: number): { data: Buffer; consumed: number } {
  const remaining = buf.length - offset;
  let lo = 0;
  let hi = remaining;
  // Verify hi works (corrupt stream throws even at full length).
  const full = inflateSync(buf.subarray(offset));
  if (full.length !== expectedSize) throw new Error(`pack object inflated to ${full.length} bytes, expected ${expectedSize}`);
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    try {
      const out = inflateSync(buf.subarray(offset, offset + mid));
      if (out.length === expectedSize) hi = mid;
      else lo = mid;
    } catch {
      lo = mid;
    }
  }
  return { data: inflateSync(buf.subarray(offset, offset + hi)), consumed: hi };
}

/** Apply a git delta to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (off >= delta.length) throw new Error('truncated delta varint');
      const b = delta[off++]!;
      value |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return value;
  };
  const srcSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const dstSize = readVarint();
  const out: Buffer[] = [];
  let outLen = 0;
  while (off < delta.length) {
    const op = delta[off++]!;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { if (off >= delta.length) throw new Error('truncated delta copy'); cpOff |= delta[off++]! << (8 * i); }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { if (off >= delta.length) throw new Error('truncated delta copy'); cpSize |= delta[off++]! << (8 * i); }
      if (cpSize === 0) cpSize = 0x10000;
      if (cpOff + cpSize > base.length) throw new Error('delta copy out of range');
      out.push(base.subarray(cpOff, cpOff + cpSize));
      outLen += cpSize;
    } else if (op > 0) {
      if (off + op > delta.length) throw new Error('truncated delta insert');
      out.push(delta.subarray(off, off + op));
      outLen += op;
      off += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (outLen !== dstSize) throw new Error('delta target size mismatch');
  return Buffer.concat(out);
}

export interface ReadPackResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Parse a version 2/3 packfile. Resolves OFS_DELTA and REF_DELTA objects (the suite only
 * sends plain objects, but a delta must not break the parse). Throws on malformed input.
 */
export function readPack(pack: Buffer): ReadPackResult {
  if (pack.length < 32) throw new Error('pack too small');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  // Verify the SHA-1 trailer.
  const body = pack.subarray(0, pack.length - 20);
  const expected = createHash('sha1').update(body).digest('hex');
  const actual = pack.subarray(pack.length - 20).toString('hex');
  if (expected !== actual) throw new Error('pack trailer checksum mismatch');

  const objects = new Map<string, GitObject>();
  // Objects are indexed by their offset in the pack so OFS_DELTA can resolve them.
  const byOffset = new Map<number, GitObject>();
  const deltas: Array<{ offset: number; baseOffset?: number; baseOid?: string; delta: Buffer }> = [];
  let off = 12;
  let deltaCount = 0;
  for (let i = 0; i < count; i += 1) {
    const startOff = off;
    if (off >= body.length) throw new Error('pack truncated in object header');
    let b = body[off++]!;
    const typeId = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      if (off >= body.length) throw new Error('pack truncated in object header');
      b = body[off++]!;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    if (typeId === 6) {
      // OFS_DELTA: negative offset varint.
      if (off >= body.length) throw new Error('pack truncated in ofs-delta header');
      b = body[off++]!;
      let ofs = b & 0x7f;
      while (b & 0x80) {
        if (off >= body.length) throw new Error('pack truncated in ofs-delta header');
        b = body[off++]!;
        ofs = ((ofs + 1) << 7) | (b & 0x7f);
      }
      const { data, consumed } = inflateAt(body, off, size);
      off += consumed;
      deltas.push({ offset: startOff, baseOffset: startOff - ofs, delta: data });
      deltaCount += 1;
    } else if (typeId === 7) {
      // REF_DELTA: 20-byte base oid.
      if (off + 20 > body.length) throw new Error('pack truncated in ref-delta header');
      const baseOid = body.subarray(off, off + 20).toString('hex');
      off += 20;
      const { data, consumed } = inflateAt(body, off, size);
      off += consumed;
      deltas.push({ offset: startOff, baseOid, delta: data });
      deltaCount += 1;
    } else {
      const type = PACK_TYPES[typeId];
      if (type === undefined) throw new Error(`unknown pack object type ${typeId}`);
      const { data, consumed } = inflateAt(body, off, size);
      off += consumed;
      const obj: GitObject = { type, data };
      const oid = hashObject(type, data);
      objects.set(oid, obj);
      byOffset.set(startOff, obj);
    }
  }
  // Resolve deltas (possibly chained: repeat until all resolved).
  let pending = deltas;
  for (let round = 0; round < 100 && pending.length > 0; round += 1) {
    const next: typeof pending = [];
    for (const d of pending) {
      let base: GitObject | undefined;
      if (d.baseOffset !== undefined) base = byOffset.get(d.baseOffset);
      else if (d.baseOid !== undefined) base = objects.get(d.baseOid);
      if (base === undefined) { next.push(d); continue; }
      const data = applyDelta(base.data, d.delta);
      const obj: GitObject = { type: base.type, data };
      const oid = hashObject(base.type, data);
      objects.set(oid, obj);
      byOffset.set(d.offset, obj);
    }
    if (next.length === pending.length) throw new Error('unresolvable pack delta');
    pending = next;
  }
  if (pending.length > 0) throw new Error('unresolvable pack delta');
  return { objects, deltaCount };
}

/** Verify a packfile's SHA-1 trailer without parsing its objects. */
export function verifyPackChecksum(pack: Buffer): { ok: boolean; expected: string; actual: string } {
  if (pack.length < 20) return { ok: false, expected: '', actual: '' };
  const body = pack.subarray(0, pack.length - 20);
  const expected = createHash('sha1').update(body).digest('hex');
  const actual = pack.subarray(pack.length - 20).toString('hex');
  return { ok: expected === actual, expected, actual };
}
