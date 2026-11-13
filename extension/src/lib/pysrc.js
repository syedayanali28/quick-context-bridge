// Minimal Python-source utilities for reading QAL (Quick Automation Language).
// QAL is a Python DSL, so we only need a tokenizer good enough to find string literals, brackets, comments
// and top-level commas. This is NOT a full Python parser.

const QUOTE = new Set(['"', "'"]);

/** Is position i the start of a string literal (optionally with a prefix like f, r, b, rb, fr)? */
export function stringStartAt(src, i) {
  let j = i;
  while (j < src.length && j - i < 2 && /[rRbBfFuU]/.test(src[j])) j++;
  if (!QUOTE.has(src[j])) return -1;
  if (j > i) {
    // prefix letters must not be the tail of an identifier (e.g. `elif"`), so check the char before i
    const prev = i > 0 ? src[i - 1] : '';
    if (/[A-Za-z0-9_]/.test(prev)) return -1;
  }
  return j; // index of the opening quote
}

/**
 * Read a Python string literal starting at src[i] (prefix or quote).
 * @returns {{start:number, end:number, prefix:string, quote:string, body:string, value:string}}
 *   end = index just past the closing quote; body = raw text between quotes; value = escapes decoded
 *   (raw strings keep backslashes).
 */
export function readPyString(src, i) {
  const q = stringStartAt(src, i);
  if (q < 0) throw new Error(`No string literal at ${i}`);
  const prefix = src.slice(i, q);
  const ch = src[q];
  const triple = src.startsWith(ch.repeat(3), q);
  const quote = triple ? ch.repeat(3) : ch;
  let k = q + quote.length;
  while (k < src.length) {
    if (src[k] === '\\') { k += 2; continue; }
    if (src.startsWith(quote, k)) {
      const body = src.slice(q + quote.length, k);
      const raw = /r/i.test(prefix);
      return { start: i, end: k + quote.length, prefix, quote, body, value: raw ? body : decodeEscapes(body) };
    }
    if (!triple && src[k] === '\n') break;
    k++;
  }
  throw new Error(`Unterminated string literal at ${i}`);
}

const SIMPLE_ESC = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', f: '\f', v: '\v', 0: '\0' };

export function decodeEscapes(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\' || i === s.length - 1) { out += c; continue; }
    const n = s[i + 1];
    if (n === '\n') { i++; continue; } // line continuation
    if (n === 'x' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 2, i + 4))) {
      out += String.fromCharCode(parseInt(s.slice(i + 2, i + 4), 16)); i += 3; continue;
    }
    if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))) {
      out += String.fromCharCode(parseInt(s.slice(i + 2, i + 6), 16)); i += 5; continue;
    }
    if (n === 'U' && /^[0-9a-fA-F]{8}$/.test(s.slice(i + 2, i + 10))) {
      out += String.fromCodePoint(parseInt(s.slice(i + 2, i + 10), 16)); i += 9; continue;
    }
    if (Object.prototype.hasOwnProperty.call(SIMPLE_ESC, n)) { out += SIMPLE_ESC[n]; i++; continue; }
    out += c; // unknown escape: Python keeps the backslash
  }
  return out;
}

/**
 * Split source into logical lines (joining physical lines inside brackets or multi-line strings).
 * @returns {Array<{code:string, comment:string|null, line:number, endLine:number, indent:number}>}
 *   line/endLine are 0-based physical line numbers. Blank lines are skipped.
 */
export function logicalLines(src) {
  const out = [];
  let i = 0;
  let line = 0;
  let start = 0;
  let startLine = 0;
  let depth = 0;
  let comment = null;
  let codeEnd = -1;
  const flush = (endIdx) => {
    const text = src.slice(start, codeEnd >= 0 ? codeEnd : endIdx);
    if (text.trim() || comment) {
      const indent = text.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
      out.push({ code: text.replace(/\s+$/, ''), comment, line: startLine, endLine: line, indent });
    }
    comment = null;
    codeEnd = -1;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '#') {
      const nl = src.indexOf('\n', i);
      const stop = nl < 0 ? src.length : nl;
      if (depth === 0) { codeEnd = i; comment = src.slice(i + 1, stop).trim(); }
      i = stop;
      continue;
    }
    const q = stringStartAt(src, i);
    if (q >= 0) {
      const s = readPyString(src, i);
      line += (src.slice(i, s.end).match(/\n/g) || []).length;
      i = s.end;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (c === '\\' && src[i + 1] === '\n') { i += 2; line++; continue; }
    else if (c === '\n') {
      if (depth === 0) {
        flush(i);
        start = i + 1;
        startLine = line + 1;
      }
      line++;
    }
    i++;
  }
  flush(src.length);
  return out;
}

/** Split `text` at top-level occurrences of `sep` (outside strings and brackets). */
export function splitTopLevel(text, sep = ',') {
  const parts = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const q = stringStartAt(text, i);
    if (q >= 0) { i = readPyString(text, i).end - 1; continue; }
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === sep && depth === 0) { parts.push(text.slice(last, i)); last = i + 1; }
  }
  const tail = text.slice(last);
  if (tail.trim() || parts.length) parts.push(tail);
  return parts.map((p) => p.trim()).filter((p) => p.length);
}

/** Index of the bracket matching the opening bracket at `open`, or -1. */
export function matchBracket(text, open) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const want = [];
  for (let i = open; i < text.length; i++) {
    const q = stringStartAt(text, i);
    if (q >= 0) { i = readPyString(text, i).end - 1; continue; }
    const c = text[i];
    if (pairs[c]) want.push(pairs[c]);
    else if (c === ')' || c === ']' || c === '}') {
      if (want.pop() !== c) return -1;
      if (!want.length) return i;
    }
  }
  return -1;
}

/**
 * Parse `callee(args...)` at the start of `text`.
 * @returns {null | {callee:string, args:Array<{name:string|null, text:string}>, end:number}}
 */
export function parseCall(text) {
  const m = text.match(/^\s*([A-Za-z_][\w.]*)\s*\(/);
  if (!m) return null;
  const open = m[0].length - 1;
  const close = matchBracket(text, open);
  if (close < 0) return null;
  const inner = text.slice(open + 1, close);
  const args = splitTopLevel(inner).map((a) => {
    const kw = a.match(/^([A-Za-z_]\w*)\s*=(?!=)\s*/);
    return kw ? { name: kw[1], text: a.slice(kw[0].length) } : { name: null, text: a };
  });
  return { callee: m[1], args, end: close + 1 };
}

/**
 * Interpret a QAL argument value.
 *   _("<python expr>")  -> {type:'expr', expr}
 *   "literal"           -> {type:'str', value}
 *   anything else       -> {type:'raw', text}
 */
export function parseValue(text) {
  const t = text.trim();
  const m = t.match(/^_\s*\(/);
  if (m) {
    const close = matchBracket(t, m[0].length - 1);
    if (close === t.length - 1) {
      const inner = t.slice(m[0].length, close).trim();
      try {
        const s = readPyString(inner, 0);
        if (s.end === inner.length) return { type: 'expr', expr: s.value };
      } catch { /* fall through */ }
    }
  }
  try {
    const s = readPyString(t, 0);
    if (s.end === t.length) return { type: 'str', value: s.value };
  } catch { /* fall through */ }
  return { type: 'raw', text: t };
}

/** Return a human-readable rendering of a parsed value. */
export function valueText(v) {
  if (!v) return '';
  if (v.type === 'expr') return v.expr;
  if (v.type === 'str') return JSON.stringify(v.value);
  return v.text;
}

/**
 * If `expr` is itself a single Python string literal (e.g. an agent instruction written as f"""..."""),
 * return its text. For f-strings, `{{`/`}}` escapes are collapsed.
 */
export function stringLiteralText(expr) {
  const t = String(expr || '').trim();
  try {
    const s = readPyString(t, 0);
    if (s.end !== t.length) return null;
    return /f/i.test(s.prefix) ? s.value.replace(/\{\{/g, '{').replace(/\}\}/g, '}') : s.value;
  } catch {
    return null;
  }
}

/** Remove the common leading indentation of all non-blank lines. */
export function dedent(text) {
  const lines = text.split('\n');
  let min = Infinity;
  for (const l of lines) {
    if (!l.trim()) continue;
    min = Math.min(min, l.match(/^ */)[0].length);
  }
  if (!isFinite(min) || min === 0) return text;
  return lines.map((l) => l.slice(Math.min(min, l.match(/^ */)[0].length))).join('\n');
}
