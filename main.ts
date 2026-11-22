// mend: one patch tool for every AI edit format.
//
// Applies AI-written edits in four formats (unified diff, SEARCH/REPLACE
// blocks, V4A patches, JSON tool calls) to a tree of text files, all or
// nothing. Node 22, standard library only. SPEC.md is the whole contract.

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** A parse failure naming a 1-based patch line. */
class ParseErr extends Error {
  line: number;
  constructor(line: number) {
    super('parse ' + line);
    this.line = line;
  }
}

// ---------- small text helpers ----------

function isBlank(s: string): boolean {
  return s.trim() === '';
}

/** Remove trailing spaces and tabs. */
function trailWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

/** Leading spaces and tabs of a line. */
function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** A patch's lines: split at \n, one trailing \r removed from each, and
 *  without the empty piece after a final \n. */
function patchLines(text: string): string[] {
  const parts = text.split('\n');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.endsWith('\r')) parts[i] = p.slice(0, -1);
  }
  if (text.endsWith('\n')) parts.pop();
  return parts;
}

/** Split a JSON new_str the way SPEC.md section 9 says; an empty string
 *  has no lines. */
function splitNewStr(s: string): string[] {
  if (s === '') return [];
  const parts = s.split('\n');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.endsWith('\r')) parts[i] = p.slice(0, -1);
  }
  if (s.endsWith('\n')) parts.pop();
  return parts;
}

// ---------- files: lines, breaks, rendering ----------

/** A file as lines plus its line break and whether it ends with one. */
interface FileState {
  brk: string;
  lines: string[];
  ends: boolean;
}

function parseFile(text: string): FileState {
  let brk = '\n';
  const lf = text.indexOf('\n');
  if (lf > 0 && text.charCodeAt(lf - 1) === 13) brk = '\r\n';
  if (text === '') return { brk, lines: [], ends: false };
  const parts = text.split(brk);
  const ends = text.endsWith(brk);
  if (ends) parts.pop();
  return { brk, lines: parts, ends };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.brk) + (f.ends ? f.brk : '');
}

// ---------- three-tier line matching (SPEC.md section 5) ----------

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailWs(a) === trailWs(b);
  return trailWs(a.replace(/^[ \t]+/, '')) === trailWs(b.replace(/^[ \t]+/, ''));
}

/** All 0-based positions where O occurs in lines at a tier, from `from`. */
function findOccurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(o[j], lines[i + j], tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs
 *  at or after `from`, with its occurrences. Null when it occurs nowhere. */
function findTier(lines: string[], o: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = findOccurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first line at or after `from` equal to a single-line anchor at the
 *  first tier where one is. Null when there is none. */
function findTierSingle(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(anchor, lines[i], t)) return i;
    }
  }
  return null;
}

// ---------- body items (hunk / chunk / block lines) ----------

type BodyKind = 'ctx' | 'del' | 'add' | 'bs';

interface BodyItem {
  kind: BodyKind;
  /** The line's text after its one-character marker ('' for an empty line). */
  text: string;
  /** The patch line as written, for the trailing-blank rule. */
  raw: string;
}

/** Build the lines that replace a matched run. Context lines are written
 *  as the file's own matched lines; every other line of N is re-indented
 *  at tier 2 and written as it is at tiers 0 and 1. */
function buildReplacement(items: BodyItem[], fileLines: string[], at: number, tier: number): string[] {
  let oFirst: string | null = null;
  for (const it of items) {
    if (it.kind === 'ctx' || it.kind === 'del') { oFirst = it.text; break; }
  }
  const p = oFirst === null ? '' : leadWs(oFirst);
  const f = oFirst === null ? '' : leadWs(fileLines[at] ?? '');
  const out: string[] = [];
  let oIdx = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(fileLines[at + oIdx]);
      oIdx++;
    } else if (it.kind === 'del') {
      oIdx++;
    } else if (it.kind === 'add') {
      let t = it.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function lastCtxOrAddHasBs(items: BodyItem[]): boolean {
  let lastIdx = -1;
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind === 'ctx' || items[i].kind === 'add') lastIdx = i;
  }
  if (lastIdx < 0) return false;
  return lastIdx + 1 < items.length && items[lastIdx + 1].kind === 'bs';
}

/** Empty lines at the end of a body are not part of it: drop trailing body
 *  items whose patch line is blank, and any `\` line that referred to one
 *  of them (or to nothing). */
function stripTrailingBlank(items: BodyItem[]): void {
  let i = items.length - 1;
  while (i >= 0) {
    const it = items[i];
    if (it.kind === 'bs') {
      if (i === 0) { i--; continue; }
      const prev = items[i - 1];
      if (prev.raw.trim() === '' || prev.kind === 'bs') { i--; continue; }
      break;
    }
    if (it.raw.trim() === '') { i--; continue; }
    break;
  }
  items.length = i + 1;
}

// ---------- the tree ----------

type Tree = Map<string, string>;

function readTree(): Tree {
  const out: Tree = new Map();
  const walk = (rel: string): void => {
    const dir = rel === '' ? '.' : rel;
    for (const name of readdirSync(dir)) {
      const p = rel === '' ? name : rel + '/' + name;
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.set(p, readFileSync(p, 'utf8'));
    }
  };
  walk('');
  return out;
}

// ---------- safe paths ----------

function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

/** Remove one leading a/ or b/ prefix. */
function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

// ---------- edits ----------

interface EditFail {
  code: string;
  path: string;
}

interface ApplyResult {
  fail: EditFail | null;
  /** A successful move, for the R line. */
  move?: { old: string; nw: string } | null;
}

interface Edit {
  apply(tree: Tree, strict: boolean): ApplyResult;
}

function failResult(code: string, path: string): ApplyResult {
  return { fail: { code, path } };
}

function okResult(move?: { old: string; nw: string } | null): ApplyResult {
  return { fail: null, move: move ?? null };
}

// ---------- unified diffs (SPEC.md section 6) ----------

interface UniHunk {
  /** The -A of the hunk header. */
  a: number;
  items: BodyItem[];
}

interface UniSection {
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: UniHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseHunkHeader(l: string, lineNo: number): number {
  const m = HUNK_RE.exec(l);
  if (!m) throw new ParseErr(lineNo);
  return parseInt(m[1], 10);
}

/** Parse `diff --git a/<X> b/<Y>`; anything else of that shape is a parse error. */
function parseDiffGit(l: string, lineNo: number): { oldP: string; newP: string } {
  const rest = l.slice('diff --git '.length).trimEnd();
  const parts = rest.split(' ');
  if (parts.length !== 2 || !parts[0].startsWith('a/') || !parts[1].startsWith('b/')) {
    throw new ParseErr(lineNo);
  }
  return { oldP: parts[0].slice(2), newP: parts[1].slice(2) };
}

/** The path of a `--- ` or `+++ ` header line, or null for /dev/null. */
function parseHeaderPath(l: string): string | null {
  let p = l.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  return stripAB(p);
}

function isUnifiedBodyLine(l: string): boolean {
  return l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\');
}

function unifiedBodyItem(l: string): BodyItem {
  if (l === '') return { kind: 'ctx', text: '', raw: l };
  const c = l[0];
  if (c === ' ') return { kind: 'ctx', text: l.slice(1), raw: l };
  if (c === '-') return { kind: 'del', text: l.slice(1), raw: l };
  if (c === '+') return { kind: 'add', text: l.slice(1), raw: l };
  return { kind: 'bs', text: l.slice(1), raw: l };
}

function parseUnified(lines: string[]): Edit[] {
  const sections: UniSection[] = [];
  let sec: UniSection | null = null;
  let hunk: UniHunk | null = null;
  let inHeader = false;
  const n = lines.length;

  const closeHunk = (): void => {
    if (hunk) {
      stripTrailingBlank(hunk.items);
      hunk = null;
    }
  };
  const closeSection = (): void => {
    closeHunk();
    sec = null;
    inHeader = false;
  };
  const startSection = (diffOld: string | null, diffNew: string | null): UniSection => {
    const s: UniSection = {
      pairOld: null, pairNew: null, renameFrom: null, renameTo: null,
      diffOld, diffNew, newFileMode: false, deletedFileMode: false, hunks: [],
    };
    sections.push(s);
    sec = s;
    inHeader = true;
    hunk = null;
    return s;
  };

  for (let i = 0; i < n; i++) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      const m = parseDiffGit(l, i + 1);
      closeSection();
      startSection(m.oldP, m.newP);
      continue;
    }
    if (sec === null) {
      // Outside any section.
      if (l.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
        const oldP = parseHeaderPath(l);
        const newP = parseHeaderPath(lines[i + 1]);
        const s2 = startSection(null, null);
        s2.pairOld = oldP;
        s2.pairNew = newP;
        i++;
        continue;
      }
      if (l.startsWith('@@')) throw new ParseErr(i + 1);
      continue;
    }
    if (inHeader) {
      if (l.startsWith('--- ')) {
        if (i + 1 < n && lines[i + 1].startsWith('+++ ')) {
          sec.pairOld = parseHeaderPath(l);
          sec.pairNew = parseHeaderPath(lines[i + 1]);
          i++;
          continue;
        }
        throw new ParseErr(i + 2);
      }
      if (l.startsWith('@@')) {
        hunk = { a: parseHunkHeader(l, i + 1), items: [] };
        sec.hunks.push(hunk);
        inHeader = false;
        continue;
      }
      if (l.startsWith('rename from ')) {
        sec.renameFrom = l.slice('rename from '.length).trim();
        continue;
      }
      if (l.startsWith('rename to ')) {
        sec.renameTo = l.slice('rename to '.length).trim();
        continue;
      }
      if (l.startsWith('new file mode')) {
        sec.newFileMode = true;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        sec.deletedFileMode = true;
        continue;
      }
      continue;
    }
    // Body phase: inside or between hunks.
    if (l.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
      closeSection();
      const oldP = parseHeaderPath(l);
      const newP = parseHeaderPath(lines[i + 1]);
      const s2 = startSection(null, null);
      s2.pairOld = oldP;
      s2.pairNew = newP;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      closeHunk();
      hunk = { a: parseHunkHeader(l, i + 1), items: [] };
      sec.hunks.push(hunk);
      continue;
    }
    if (hunk !== null && isUnifiedBodyLine(l)) {
      hunk.items.push(unifiedBodyItem(l));
      continue;
    }
    closeHunk();
  }
  closeSection();
  if (sections.length === 0) throw new ParseErr(1);
  return sections.map((s) => makeUnifiedEdit(s));
}

/** Apply one hunk of a section to a file's lines. `d` is the sum over this
 *  section's hunks applied so far of (N's length minus O's length). */
function applyUnifiedHunk(f: FileState, hunk: UniHunk, d: number, strict: boolean): { ok: true; d: number } | { ok: false; code: string } {
  const o: string[] = [];
  for (const it of hunk.items) {
    if (it.kind === 'ctx' || it.kind === 'del') o.push(it.text);
  }
  const lines = f.lines;
  if (o.length > 0) {
    const found = findTier(lines, o, 0, strict);
    if (!found) return { ok: false, code: 'no-match' };
    const target = hunk.a - 1 + d;
    let best = found.occ[0];
    for (const pos of found.occ) {
      if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
    }
    const rep = buildReplacement(hunk.items, lines, best, found.tier);
    f.lines = [...lines.slice(0, best), ...rep, ...lines.slice(best + o.length)];
    if (best + o.length === lines.length) f.ends = !lastCtxOrAddHasBs(hunk.items);
    return { ok: true, d: d + (rep.length - o.length) };
  }
  const rep = buildReplacement(hunk.items, lines, 0, 0);
  const p = Math.min(hunk.a + d, lines.length);
  f.lines = [...lines.slice(0, p), ...rep, ...lines.slice(p)];
  if (p === lines.length) f.ends = !lastCtxOrAddHasBs(hunk.items);
  return { ok: true, d: d + rep.length };
}

function makeUnifiedEdit(s: UniSection): Edit {
  const oldP = s.pairOld ?? s.renameFrom ?? s.diffOld;
  const newP = s.pairNew ?? s.renameTo ?? s.diffNew;
  const isCreate = oldP === null || s.newFileMode;
  const isDelete = !isCreate && (newP === null || s.deletedFileMode);
  const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
  return {
    apply(tree: Tree, strict: boolean): ApplyResult {
      if (isCreate) {
        if (newP === null) return okResult();
        if (!isSafePath(newP)) return failResult('unsafe', newP);
        if (tree.has(newP)) return failResult('exists', newP);
        const plus: string[] = [];
        let lastPlusHasBs = false;
        for (const h of s.hunks) {
          for (let i = 0; i < h.items.length; i++) {
            const it = h.items[i];
            if (it.kind === 'add') {
              plus.push(it.text);
              lastPlusHasBs = i + 1 < h.items.length && h.items[i + 1].kind === 'bs';
            }
          }
        }
        const ends = plus.length === 0 ? false : !lastPlusHasBs;
        tree.set(newP, renderFile({ brk: '\n', lines: plus, ends }));
        return okResult();
      }
      if (isDelete) {
        if (oldP === null) return okResult();
        if (!isSafePath(oldP)) return failResult('unsafe', oldP);
        if (!tree.has(oldP)) return failResult('missing', oldP);
        tree.delete(oldP);
        return okResult();
      }
      if (isMove) {
        const op = oldP as string;
        const np = newP as string;
        if (!isSafePath(op)) return failResult('unsafe', op);
        if (!isSafePath(np)) return failResult('unsafe', np);
        if (!tree.has(op)) return failResult('missing', op);
        if (tree.has(np)) return failResult('exists', np);
        const f = parseFile(tree.get(op) as string);
        let d = 0;
        for (const h of s.hunks) {
          const r = applyUnifiedHunk(f, h, d, strict);
          if (!r.ok) return failResult(r.code, op);
          d = r.d;
        }
        tree.delete(op);
        tree.set(np, renderFile(f));
        return okResult({ old: op, nw: np });
      }
      const p = oldP as string;
      if (!isSafePath(p)) return failResult('unsafe', p);
      if (!tree.has(p)) return failResult('missing', p);
      const f = parseFile(tree.get(p) as string);
      let d = 0;
      for (const h of s.hunks) {
        const r = applyUnifiedHunk(f, h, d, strict);
        if (!r.ok) return failResult(r.code, p);
        d = r.d;
      }
      tree.set(p, renderFile(f));
      return okResult();
    },
  };
}

// ---------- SEARCH/REPLACE blocks (SPEC.md section 7) ----------

interface SearchBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): Edit[] {
  const blocks: SearchBlock[] = [];
  let prevReplaceIdx = -1;
  let prevPath: string | null = null;
  const n = lines.length;
  for (let i = 0; i < n; i++) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') continue;
    let path: string | null = null;
    for (let j = i - 1; j > prevReplaceIdx; j--) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseErr(i + 1);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < n; j++) {
      if (lines[j].trimEnd() === '=======') { eq = j; break; }
    }
    if (eq === -1) throw new ParseErr(i + 1);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (rep === -1) throw new ParseErr(i + 1);
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevReplaceIdx = rep;
    i = rep;
  }
  if (blocks.length === 0) throw new ParseErr(1);
  return blocks.map((b) => makeSearchReplaceEdit(b));
}

function makeSearchReplaceEdit(b: SearchBlock): Edit {
  return {
    apply(tree: Tree, strict: boolean): ApplyResult {
      if (!isSafePath(b.path)) return failResult('unsafe', b.path);
      if (b.oldLines.length === 0) {
        if (tree.has(b.path)) return failResult('exists', b.path);
        const text = b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n';
        tree.set(b.path, text);
        return okResult();
      }
      const cur = tree.get(b.path);
      if (cur === undefined) return failResult('missing', b.path);
      const f = parseFile(cur);
      const found = findTier(f.lines, b.oldLines, 0, strict);
      if (!found) return failResult('no-match', b.path);
      if (found.occ.length > 1) return failResult('ambiguous', b.path);
      const at = found.occ[0];
      const items: BodyItem[] = [
        ...b.oldLines.map((t) => ({ kind: 'del' as const, text: t, raw: t })),
        ...b.newLines.map((t) => ({ kind: 'add' as const, text: t, raw: t })),
      ];
      const rep = buildReplacement(items, f.lines, at, found.tier);
      f.lines = [...f.lines.slice(0, at), ...rep, ...f.lines.slice(at + b.oldLines.length)];
      tree.set(b.path, renderFile(f));
      return okResult();
    },
  };
}

// ---------- V4A patches (SPEC.md section 8) ----------

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: V4AChunk[];
  updateLine: number;
}

function isV4aSectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

function isV4aBodyLine(l: string): boolean {
  return l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+');
}

function v4aBodyItem(l: string): BodyItem {
  if (l === '') return { kind: 'ctx', text: '', raw: l };
  const c = l[0];
  if (c === ' ') return { kind: 'ctx', text: l.slice(1), raw: l };
  if (c === '-') return { kind: 'del', text: l.slice(1), raw: l };
  return { kind: 'add', text: l.slice(1), raw: l };
}

function parseV4a(lines: string[]): Edit[] {
  const n = lines.length;
  let first = -1;
  for (let i = 0; i < n; i++) {
    if (!isBlank(lines[i])) { first = i; break; }
  }
  if (first === -1) throw new ParseErr(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseErr(first + 1);
  let last = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (!isBlank(lines[i])) { last = i; break; }
  }
  if (lines[last].trim() !== '*** End Patch') throw new ParseErr(n + 1);
  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    if (isBlank(lines[i])) { i++; continue; }
    const l = lines[i];
    let m: RegExpExecArray | null;
    if ((m = /^\*\*\* Add File: (.*)$/.exec(l))) {
      const sec: V4ASection = { kind: 'add', path: m[1].trim(), moveTo: null, addLines: [], chunks: [], updateLine: 0 };
      i++;
      const collected: { text: string; plus: boolean }[] = [];
      while (i < last && !isV4aSectionStart(lines[i])) {
        const cl = lines[i];
        if (cl.startsWith('+')) collected.push({ text: cl.slice(1), plus: true });
        else if (isBlank(cl)) collected.push({ text: '', plus: false });
        else throw new ParseErr(i + 1);
        i++;
      }
      while (collected.length > 0 && !collected[collected.length - 1].plus) collected.pop();
      sec.addLines = collected.map((c) => c.text);
      sections.push(sec);
      continue;
    }
    if ((m = /^\*\*\* Delete File: (.*)$/.exec(l))) {
      sections.push({ kind: 'delete', path: m[1].trim(), moveTo: null, addLines: [], chunks: [], updateLine: 0 });
      i++;
      continue;
    }
    if ((m = /^\*\*\* Update File: (.*)$/.exec(l))) {
      const sec: V4ASection = { kind: 'update', path: m[1].trim(), moveTo: null, addLines: [], chunks: [], updateLine: i + 1 };
      i++;
      if (i < last && lines[i].startsWith('*** Move to: ')) {
        sec.moveTo = lines[i].slice('*** Move to: '.length).trim();
        i++;
      }
      let chunk: V4AChunk | null = null;
      const closeChunk = (): void => {
        if (chunk) {
          while (chunk.items.length > 0) {
            const li = chunk.items[chunk.items.length - 1];
            if (li.kind === 'ctx' && li.text.trim() === '') chunk.items.pop();
            else break;
          }
          chunk = null;
        }
      };
      while (i < last && !isV4aSectionStart(lines[i])) {
        const cl = lines[i];
        if (cl.startsWith('@@')) {
          closeChunk();
          chunk = { anchor: cl.slice(2).trim() || null, eof: false, items: [] };
          sec.chunks.push(chunk);
          i++;
          continue;
        }
        if (cl === '*** End of File') {
          if (!chunk) throw new ParseErr(i + 1);
          chunk.eof = true;
          closeChunk();
          i++;
          continue;
        }
        if (isV4aBodyLine(cl)) {
          if (!chunk) {
            if (sec.chunks.length > 0) throw new ParseErr(i + 1);
            chunk = { anchor: null, eof: false, items: [] };
            sec.chunks.push(chunk);
          }
          chunk.items.push(v4aBodyItem(cl));
          i++;
          continue;
        }
        throw new ParseErr(i + 1);
      }
      closeChunk();
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new ParseErr(sec.updateLine);
      sections.push(sec);
      continue;
    }
    throw new ParseErr(i + 1);
  }
  if (sections.length === 0) throw new ParseErr(1);
  return sections.map((s) => makeV4aEdit(s));
}

function makeV4aEdit(sec: V4ASection): Edit {
  return {
    apply(tree: Tree, strict: boolean): ApplyResult {
      if (!isSafePath(sec.path)) return failResult('unsafe', sec.path);
      if (sec.kind === 'add') {
        if (tree.has(sec.path)) return failResult('exists', sec.path);
        const text = sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n';
        tree.set(sec.path, text);
        return okResult();
      }
      if (sec.kind === 'delete') {
        if (!tree.has(sec.path)) return failResult('missing', sec.path);
        tree.delete(sec.path);
        return okResult();
      }
      if (sec.moveTo !== null && !isSafePath(sec.moveTo)) return failResult('unsafe', sec.moveTo);
      const cur = tree.get(sec.path);
      if (cur === undefined) return failResult('missing', sec.path);
      if (sec.moveTo !== null && tree.has(sec.moveTo)) return failResult('exists', sec.moveTo);
      const f = parseFile(cur);
      let cursor = 0;
      for (const ch of sec.chunks) {
        if (ch.anchor !== null) {
          const at = findTierSingle(f.lines, ch.anchor, cursor, strict);
          if (at === null) return failResult('no-match', sec.path);
          cursor = at + 1;
        }
        const o: string[] = [];
        for (const it of ch.items) {
          if (it.kind === 'ctx' || it.kind === 'del') o.push(it.text);
        }
        if (o.length === 0) {
          const rep = buildReplacement(ch.items, f.lines, cursor, 0);
          const p = ch.eof ? f.lines.length : cursor;
          f.lines = [...f.lines.slice(0, p), ...rep, ...f.lines.slice(p)];
          cursor = p + rep.length;
        } else {
          const found = findTier(f.lines, o, cursor, strict);
          if (!found) return failResult('no-match', sec.path);
          let occ = found.occ;
          if (ch.eof) occ = occ.filter((pos) => pos + o.length === f.lines.length);
          if (occ.length === 0) return failResult('no-match', sec.path);
          const at = occ[0];
          const rep = buildReplacement(ch.items, f.lines, at, found.tier);
          f.lines = [...f.lines.slice(0, at), ...rep, ...f.lines.slice(at + o.length)];
          cursor = at + rep.length;
        }
      }
      if (sec.moveTo !== null) {
        tree.delete(sec.path);
        tree.set(sec.moveTo, renderFile(f));
        return okResult({ old: sec.path, nw: sec.moveTo });
      }
      tree.set(sec.path, renderFile(f));
      return okResult();
    },
  };
}

// ---------- JSON edits (SPEC.md section 9) ----------

function jsonEdit(el: unknown, errLine: number): Edit {
  if (typeof el !== 'object' || el === null || Array.isArray(el)) throw new ParseErr(errLine);
  const o = el as Record<string, unknown>;
  if (typeof o.path !== 'string') throw new ParseErr(errLine);
  if (typeof o.command !== 'string') throw new ParseErr(errLine);
  const path = o.path as string;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') throw new ParseErr(errLine);
    const text = o.file_text as string;
    return {
      apply(tree: Tree): ApplyResult {
        if (!isSafePath(path)) return failResult('unsafe', path);
        if (tree.has(path)) return failResult('exists', path);
        tree.set(path, text);
        return okResult();
      },
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || (o.old_str as string) === '') throw new ParseErr(errLine);
    let newStr = '';
    if ('new_str' in o) {
      if (typeof o.new_str !== 'string') throw new ParseErr(errLine);
      newStr = o.new_str as string;
    }
    const oldStr = o.old_str as string;
    return {
      apply(tree: Tree): ApplyResult {
        if (!isSafePath(path)) return failResult('unsafe', path);
        const cur = tree.get(path);
        if (cur === undefined) return failResult('missing', path);
        const f = parseFile(cur);
        let text = cur;
        let oldS = oldStr;
        let newS = newStr;
        if (f.brk === '\r\n') {
          text = cur.replace(/\r\n/g, '\n');
          oldS = oldStr.replace(/\r\n/g, '\n');
          newS = newStr.replace(/\r\n/g, '\n');
        }
        let count = 0;
        let idx = -1;
        let pos = 0;
        while (true) {
          const k = text.indexOf(oldS, pos);
          if (k === -1) break;
          count++;
          if (count === 1) idx = k;
          if (count > 1) break;
          pos = k + 1;
        }
        if (count === 0) return failResult('no-match', path);
        if (count > 1) return failResult('ambiguous', path);
        let out = text.slice(0, idx) + newS + text.slice(idx + oldS.length);
        if (f.brk === '\r\n') out = out.replace(/\n/g, '\r\n');
        tree.set(path, out);
        return okResult();
      },
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) throw new ParseErr(errLine);
    if (typeof o.new_str !== 'string') throw new ParseErr(errLine);
    const lineNo = o.insert_line as number;
    const newStr = o.new_str as string;
    return {
      apply(tree: Tree): ApplyResult {
        if (!isSafePath(path)) return failResult('unsafe', path);
        const cur = tree.get(path);
        if (cur === undefined) return failResult('missing', path);
        const f = parseFile(cur);
        if (lineNo < 0 || lineNo > f.lines.length) return failResult('no-match', path);
        const ins = splitNewStr(newStr);
        f.lines = [...f.lines.slice(0, lineNo), ...ins, ...f.lines.slice(lineNo)];
        tree.set(path, renderFile(f));
        return okResult();
      },
    };
  }
  throw new ParseErr(errLine);
}

function parseJson(lines: string[], text: string): Edit[] {
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) { firstIdx = i; break; }
  }
  if (firstIdx === -1) throw new ParseErr(1);
  if (lines[firstIdx].trimStart()[0] === '[') {
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      arr = undefined;
    }
    if (Array.isArray(arr)) {
      const edits: Edit[] = [];
      for (const el of arr) edits.push(jsonEdit(el, firstIdx + 1));
      if (edits.length === 0) throw new ParseErr(1);
      return edits;
    }
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (isBlank(l)) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(l);
    } catch {
      throw new ParseErr(i + 1);
    }
    edits.push(jsonEdit(obj, i + 1));
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

// ---------- detecting the format (SPEC.md section 4) ----------

function detectFormat(lines: string[]): string | null {
  let first: string | null = null;
  for (const l of lines) {
    if (!isBlank(l)) { first = l; break; }
  }
  if (first !== null) {
    if (first.trim() === '*** Begin Patch') return 'v4a';
    const c = first.trimStart()[0];
    if (c === '[' || c === '{') return 'json';
  }
  for (const l of lines) {
    if (l.trimEnd() === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------- the driver (SPEC.md sections 1, 2, 10) ----------

function usageError(): { code: number; out: string[] } {
  return { code: 2, out: ['error: usage'] };
}

function run(argv: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const positional: string[] = [];
  let endOpts = false;
  for (const a of argv) {
    if (!endOpts && a === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (check) return usageError();
        check = true;
      } else if (a === '--strict') {
        if (strict) return usageError();
        strict = true;
      } else if (a.startsWith('--format=')) {
        const v = a.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') return usageError();
        if (format !== null) return usageError();
        format = v;
      } else {
        return usageError();
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return usageError();

  let patchText: string;
  if (positional.length === 0 || positional[0] === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(positional[0], 'utf8');
    } catch {
      return { code: 2, out: ['error: no-patch'] };
    }
  }
  const lines = patchLines(patchText);

  let fmt = format;
  if (fmt === null || fmt === 'auto') {
    const detected = detectFormat(lines);
    if (detected === null) return { code: 2, out: ['error: format'] };
    fmt = detected;
  }

  let edits: Edit[];
  try {
    if (fmt === 'unified') edits = parseUnified(lines);
    else if (fmt === 'search-replace') edits = parseSearchReplace(lines);
    else if (fmt === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(lines, patchText);
  } catch (e) {
    if (e instanceof ParseErr) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }

  const initial = readTree();
  let tree: Tree = new Map(initial);
  const failures: EditFail[] = [];
  const moves: { old: string; nw: string }[] = [];
  for (const edit of edits) {
    const trial: Tree = new Map(tree);
    const r = edit.apply(trial, strict);
    if (r.fail) {
      failures.push(r.fail);
    } else {
      tree = trial;
      if (r.move) moves.push(r.move);
    }
  }
  if (failures.length > 0) {
    const out = failures.map((f) => `error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    return { code: 1, out };
  }

  const rows: { key: string; text: string }[] = [];
  const moveNew = new Set<string>();
  const moveOld = new Set<string>();
  for (const mv of moves) {
    if (!initial.has(mv.old) || tree.has(mv.old)) continue;
    if (initial.has(mv.nw) || !tree.has(mv.nw)) continue;
    rows.push({ key: mv.nw, text: `R ${mv.old} -> ${mv.nw}` });
    moveNew.add(mv.nw);
    moveOld.add(mv.old);
  }
  for (const [p, text] of tree) {
    if (moveNew.has(p)) continue;
    if (!initial.has(p)) rows.push({ key: p, text: `A ${p}` });
    else if (initial.get(p) !== text) rows.push({ key: p, text: `M ${p}` });
  }
  for (const p of initial.keys()) {
    if (moveOld.has(p)) continue;
    if (!tree.has(p)) rows.push({ key: p, text: `D ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));

  if (!check) {
    for (const [p, text] of tree) {
      if (initial.get(p) !== text) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, text);
      }
    }
    for (const p of initial.keys()) {
      if (!tree.has(p)) rmSync(p, { force: true });
    }
  }

  const out = rows.map((r) => r.text);
  out.push(`ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`);
  return { code: 0, out };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
