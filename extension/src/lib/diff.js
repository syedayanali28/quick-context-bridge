// Line diff (Myers O(ND)) with unified-style hunks. Common prefix/suffix are trimmed first, so typical
// agent edits to an 8k-line QAL file diff in a few milliseconds.

/**
 * @param {string[]} a
 * @param {string[]} b
 * @returns {Array<{op:'eq'|'del'|'add', a?:number, b?:number, text:string}>} a/b are 0-based line indexes
 */
export function diffLines(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const mid = myers(A, B);

  const out = [];
  for (let i = 0; i < pre; i++) out.push({ op: 'eq', a: i, b: i, text: a[i] });
  for (const e of mid) {
    if (e.op === 'eq') out.push({ op: 'eq', a: e.a + pre, b: e.b + pre, text: e.text });
    else if (e.op === 'del') out.push({ op: 'del', a: e.a + pre, text: e.text });
    else out.push({ op: 'add', b: e.b + pre, text: e.text });
  }
  for (let i = 0; i < suf; i++) {
    const ai = a.length - suf + i;
    const bi = b.length - suf + i;
    out.push({ op: 'eq', a: ai, b: bi, text: a[ai] });
  }
  return out;
}

function myers(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map((text, j) => ({ op: 'add', b: j, text }));
  if (!m) return a.map((text, i) => ({ op: 'del', a: i, text }));
  // Bound memory: beyond MAX_D edits we fall back to "replace the whole changed region".
  const MAX_D = 1500;
  const max = Math.min(n + m, MAX_D);
  const off = max;
  const v = new Int32Array(2 * max + 2);
  const trace = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = true; break; }
    }
  }
  if (!found) {
    return [...a.map((text, i) => ({ op: 'del', a: i, text })), ...b.map((text, j) => ({ op: 'add', b: j, text }))];
  }
  // Backtrack
  const edits = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && vd[off + k - 1] < vd[off + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vd[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; edits.push({ op: 'eq', a: x, b: y, text: a[x] }); }
    if (d > 0) {
      if (x === prevX) { y--; edits.push({ op: 'add', b: y, text: b[y] }); }
      else { x--; edits.push({ op: 'del', a: x, text: a[x] }); }
    }
  }
  return edits.reverse();
}

/**
 * Group a diff into hunks with `context` unchanged lines around each change.
 * @returns {Array<{aStart:number, aLen:number, bStart:number, bLen:number, lines:Array}>} starts are 1-based
 */
export function hunks(diff, context = 3) {
  const changes = [];
  diff.forEach((d, i) => { if (d.op !== 'eq') changes.push(i); });
  if (!changes.length) return [];
  const ranges = [];
  let start = Math.max(0, changes[0] - context);
  let end = Math.min(diff.length - 1, changes[0] + context);
  for (const c of changes.slice(1)) {
    if (c - context <= end + 1) end = Math.min(diff.length - 1, c + context);
    else { ranges.push([start, end]); start = Math.max(0, c - context); end = Math.min(diff.length - 1, c + context); }
  }
  ranges.push([start, end]);
  return ranges.map(([s, e]) => {
    const lines = diff.slice(s, e + 1);
    const firstA = lines.find((l) => l.a !== undefined);
    const firstB = lines.find((l) => l.b !== undefined);
    return {
      aStart: firstA ? firstA.a + 1 : 0,
      aLen: lines.filter((l) => l.op !== 'add').length,
      bStart: firstB ? firstB.b + 1 : 0,
      bLen: lines.filter((l) => l.op !== 'del').length,
      lines,
    };
  });
}

/** Render hunks as a unified diff string. Long lines are clipped to `clip` characters. */
export function unified(hs, { from = 'live/automation.qal.py', to = 'new/automation.qal.py', clip = 400 } = {}) {
  const out = [`--- ${from}`, `+++ ${to}`];
  const c = (t) => (t.length > clip ? `${t.slice(0, clip)} …[+${t.length - clip} chars]` : t);
  for (const h of hs) {
    out.push(`@@ -${h.aStart},${h.aLen} +${h.bStart},${h.bLen} @@`);
    for (const l of h.lines) out.push(`${l.op === 'eq' ? ' ' : l.op === 'del' ? '-' : '+'}${c(l.text)}`);
  }
  return `${out.join('\n')}\n`;
}

export function diffStats(diff) {
  let added = 0;
  let removed = 0;
  for (const d of diff) { if (d.op === 'add') added++; else if (d.op === 'del') removed++; }
  return { added, removed };
}
