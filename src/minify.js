/**
 * minify.js — `--minify`: the Phase 2 size pass. Same pages, fewer bytes.
 *
 * SPEC §4 Phase 2 names "File-size optimization (resource dedupe, object
 * streams, image handling)" and `tympan bytes` is its measuring instrument.
 * Measurement says what this pass must do: Chromium's output is opaque where
 * it is big — images and font programs are already /FlateDecode'd by Skia —
 * and naive where it is *small*: the xref table is stored flat, and every
 * dictionary (page nodes, resource trees, the outline tree) occupies its own
 * plain-text object. This pass rewrites the FILE, never the document:
 *
 *   1. Streams that declare no /Filter are deflated (level 9, deterministic;
 *      /Length1 — the UNCOMPRESSED length of a Type1 font program — is
 *      preserved untouched, because it describes the program, not a stream).
 *   2. Every non-stream object is packed into compressed object streams
 *      (/Type /ObjStm), in batches bounded by count and by bytes.
 *   3. The whole xref becomes one compressed /Type /XRef stream (PDF 1.5).
 *   4. Everything else is copied VERBATIM, byte for byte, keeping its
 *      original object number — content streams, pages, fonts, outlines are
 *      never re-serialized, so the rendered document is the same document.
 *
 * The rules that make this safe and boring:
 *   - Deterministic: same bytes in, same bytes out (zlib at a fixed level;
 *     iteration order is object number everywhere).
 *   - Numbering is preserved end to end — no reference is ever renumbered.
 *     New numbers appear only after the highest existing one.
 *   - Encrypted and incremental files are refused, loudly: success that lies
 *     is worse than a clean refusal.
 *   - Integrity is asserted before writing: every `/N 0 R` reference in any
 *     dictionary or object body must resolve to an object this pass found.
 *     A scan that missed objects must refuse, not produce a broken file.
 *
 * Readers: pdf-lib (verification's page count) and pdfjs (text extraction)
 * both parse object streams and xref streams — proven against this repo's
 * exact versions before this module shipped.
 */

import zlib from 'node:zlib';

/** Objects per ObjStm batch, bounded against lookup cost. */
export const OBJSTM_MAX_OBJECTS = 32;
/** Byte cap (object bodies) per ObjStm batch, so a batch stays small. */
export const OBJSTM_MAX_BYTES = 4096;
/** Deflate level: 9 — deterministic at a fixed level, best ratio. */
export const MINIFY_LEVEL = 9;

const END_OF_OBJECT = 'endobj';
const END_OF_STREAM = 'endstream';

/**
 * Parse a PDF's objects from raw bytes — the positional,
 * resume-past-binary discipline of src/bytes.js, with generations kept.
 * @param {Buffer} src
 * @returns {{headerLine: string, marker: string|null, streams: Map, dicts: Map, numSet: Set<number>, maxNum: number, trailer: string}}
 */
function parseObjects(src) {
  const s = src.toString('latin1');
  const nl = s.indexOf('\n');
  const headerLine = s.slice(0, nl); // "%PDF-1.4"
  if (!/^%PDF-\d+\.\d+$/.test(headerLine)) {
    throw new Error('not a PDF: missing %PDF- header line');
  }
  let pos = nl + 1;
  let marker = null;
  if (s[pos] === '%') {
    const markerEnd = s.indexOf('\n', pos);
    marker = s.slice(pos, markerEnd); // the binary-comment marker line
    pos = markerEnd + 1;
  }

  const streams = new Map();
  const dicts = new Map();
  const numSet = new Set();
  let maxNum = 0;
  const OBJ = /\b(\d+) (\d+) obj\b/g;
  let m;
  while ((m = OBJ.exec(s)) !== null) {
    const num = Number(m[1]);
    const gen = Number(m[2]);
    const dictStart = m.index + m[0].length;
    const endObj = s.indexOf(END_OF_OBJECT, dictStart);
    if (endObj === -1) {
      throw new Error(`object ${num}: no endobj — refusing a truncated file`);
    }

    let stream = null;
    const streamIdx = s.indexOf('stream', dictStart);
    if (streamIdx !== -1 && streamIdx < endObj) {
      const kwEnd = streamIdx + 'stream'.length;
      // A real stream keyword: after the dict, before endobj, EOL following.
      if (s[kwEnd] === '\n' || (s[kwEnd] === '\r' && s[kwEnd + 1] === '\n')) {
        const dataStart = s[kwEnd] === '\r' ? kwEnd + 2 : kwEnd + 1;
        const endStream = s.indexOf(END_OF_STREAM, dataStart);
        if (endStream !== -1) {
          let dataEnd = endStream;
          if (s[dataEnd - 1] === '\n') dataEnd--; // the EOL PDF wrote before it
          if (s[dataEnd - 1] === '\r') dataEnd--;
      const objEnd = s.indexOf(END_OF_OBJECT, endStream);
          if (objEnd === -1) throw new Error(`stream ${num}: no endobj after endstream`);
          stream = {
            dict: s.slice(dictStart, streamIdx),
            dataStart,
            dataEnd,
            bodyStart: m.index,
            bodyEnd: objEnd + END_OF_OBJECT.length,
          };
          OBJ.lastIndex = objEnd + END_OF_OBJECT.length;
        }
      }
    }
    if (stream) {
      streams.set(num, { num, gen, ...stream });
    } else {
      dicts.set(num, { num, gen, body: s.slice(dictStart, endObj).trim() });
      OBJ.lastIndex = endObj + END_OF_OBJECT.length;
    }
    numSet.add(num);
    if (num > maxNum) maxNum = num;
  }

  // The trailer is the dictionary after the LAST `trailer` keyword; the
  // startxref offset that follows is ours to overwrite.
  const tIdx = s.lastIndexOf('trailer');
  if (tIdx === -1) {
    throw new Error('no classic trailer — refusing an incremental or xref-stream-only file');
  }
  const trailerEnd = s.indexOf('>>', tIdx);
  const trailer = s.slice(tIdx + 'trailer'.length, trailerEnd + 2);

  return { headerLine, marker, streams, dicts, numSet, maxNum, trailer };
}

/**
 * Every `/N G R` in a dictionary or object body must name an object the
 * parse found. A mis-scan that dropped a page node would otherwise produce
 * a file that parses but lies.
 */
function assertRefsResolve(streams, dicts, numSet) {
  const REF = /\b(\d+) \d+ R\b/g;
  const check = (text, who) => {
    for (const r of text.matchAll(REF)) {
      const n = Number(r[1]);
      if (!numSet.has(n)) {
        throw new Error(`${who} references object ${n}, which the parse did not find — refusing`);
      }
    }
  };
  for (const o of streams.values()) check(o.dict, `stream ${o.num}'s dict`);
  for (const o of dicts.values()) check(o.body, `object ${o.num}`);
}

/** Deflate at the fixed level. Deterministic: same bytes in, same bytes out. */
const snap = (data) => zlib.deflateSync(data, { level: MINIFY_LEVEL });

/**
 * One stream's on-disk form: deflated when it carries no /Filter (the dict
 * gains /Filter /FlateDecode and a new /Length; /Length1 refers to the
 * UNCOMPRESSED font program and stays as-is), otherwise verbatim.
 */
function serializeStream(o, src, stats) {
  // No leading \b before the slashes: in a dict body `/Length` is preceded
  // by `<` or a newline — non-word chars — so `\b\/` never matches there and
  // every stream would silently take the verbatim path.
  if (/\/Filter\b/.test(o.dict) || !/\/Length\s+\d+\b/.test(o.dict)) {
    // Already filtered, or an indirect /Length (`/Length 9 0 R`) — recompress
    // would mean rewriting another object. Copied verbatim.
    // The newline separating this object's `endobj` from the next object's
    // header is the file's spacing, not the object's: re-attach it, or
    // adjacent parts concatenate as `endobj9 0 obj` and the boundary dies.
    return Buffer.concat([src.slice(o.bodyStart, o.bodyEnd), Buffer.from('\n', 'latin1')]);
  }
  const raw = src.slice(o.dataStart, o.dataEnd);
  const deflated = snap(raw);
  let dict = o.dict.replace(/\/Length\s+\d+\b/, `/Length ${deflated.length}`);
  dict = dict.replace(/>\s*$/, '/Filter /FlateDecode>>');
  stats.streamsRecompressed++;
  stats.streamBytesBefore += raw.length;
  stats.streamBytesAfter += deflated.length;
  return Buffer.concat([
    Buffer.from(`${o.num} ${o.gen} obj${dict}stream\r\n`, 'latin1'),
    deflated,
    Buffer.from(`\r\n${END_OF_STREAM} ${END_OF_OBJECT}\n`, 'latin1'),
  ]);
}

/**
 * Rewrite the whole PDF: header 1.5, every stream in original order
 * (verbatim or freshly deflated), object streams for the packed
 * dictionaries, one xref stream, `startxref`, `%%EOF`.
 * @param {Buffer|Uint8Array} src original PDF bytes
 * @returns {{pdf: Buffer, stats: {bytesBefore: number, bytesAfter: number,
 *   objectsPacked: number, objectStreams: number, streamsRecompressed: number,
 *   streamBytesBefore: number, streamBytesAfter: number}}}
 */
export function minifyPdf(src) {
  const orig = Buffer.isBuffer(src) ? src : Buffer.from(src);

  // A shape check before anything else: garbage selection must fail here.
  const source = parseObjects(orig);
  if (/\/Encrypt\b/.test(source.trailer)) throw new Error('--minify refuses encrypted PDFs');
  if (/\/Prev\b/.test(source.trailer)) throw new Error('--minify refuses incremental updates');
  assertRefsResolve(source.streams, source.dicts, source.numSet);

  const stats = {
    bytesBefore: orig.length,
    bytesAfter: 0,
    objectsPacked: 0,
    objectStreams: 0,
    streamsRecompressed: 0,
    streamBytesBefore: 0,
    streamBytesAfter: 0,
  };

  // Pack the gen-0 dictionaries into ObjStm batches, ascending number.
  const gen0 = [...source.dicts.values()]
    .filter((o) => o.gen === 0)
    .sort((a, b) => a.num - b.num);
  const nextObjNum = source.maxNum + 1;
  const objstm = [];
  let batch = [];
  let batchBytes = 0;
  const flush = () => {
    if (!batch.length) return;
    // ObjStm header: pairs of `objectNumber relativeOffset`, space separated,
    // offset counted from First (i.e. from the first object's bytes). All
    // residents carry gen 0 by definition — the second element is NOT a gen.
    let pos = 0;
    const pairs = batch
      .map((r) => {
        const s = `${r.num} ${pos}`;
        pos += Buffer.byteLength(r.body, 'latin1') + 1; // bodies join '\n'
        return s;
      })
      .join(' ') + ' ';
    const first = Buffer.byteLength(pairs, 'latin1');
    const body = batch.map((r) => r.body).join('\n');
    const deflated = snap(Buffer.from(pairs + body, 'latin1'));
    const num = nextObjNum + objstm.length;
    batch.forEach((r, i) => { r.index = i; });
    objstm.push({
      num,
      dict: `<</Type/ObjStm/N ${batch.length}/First ${first}/Filter /FlateDecode/Length ${deflated.length}>>`,
      data: deflated,
      residents: batch,
    });
    batch = [];
    batchBytes = 0;
  };
  for (const o of gen0) {
    const cost = Buffer.byteLength(o.body, 'latin1') + 1;
    if (batch.length >= OBJSTM_MAX_OBJECTS || (batch.length && batchBytes + cost > OBJSTM_MAX_BYTES)) flush();
    batch.push(o);
    batchBytes += cost;
  }
  flush();
  stats.objectsPacked = gen0.length;
  stats.objectStreams = objstm.length;

  // Object numbering: sources keep theirs; ObjStm batches and the xref
  // stream take fresh numbers above source.maxNum. Each packed object was
  // stamped with its batch index at flush; record the batch number too, so
  // the xref's type-2 rows are O(1) lookups, not a per-row scan.
  const residentIndex = new Map();
  const stmOfResident = new Map();
  for (const b of objstm) {
    for (const r of b.residents) {
      if (r.index === undefined) {
        throw new Error(`object ${r.num} was never assigned an ObjStm index — bookkeeping bug`);
      }
      residentIndex.set(r.num, r.index);
      stmOfResident.set(r.num, b.num);
    }
  }

  // The xref stream object takes the last number.
  const xrefNum = source.maxNum + objstm.length + 1;
  const objstmByNum = new Map(objstm.map((b) => [b.num, b]));

  const parts = [];
  let at = 0;
  const offsets = new Map();
  const put = (buf) => { parts.push(buf); at += buf.length; };
  const objStart = (num) => { offsets.set(num, at); };

  put(Buffer.from(
    `${source.headerLine.replace(/^%PDF-[\d.]+/, '%PDF-1.5')}\n${source.marker ?? '%\xe2\xe3\xcf\xd3'}\n`,
    'latin1'
  ));

  // Objects in ascending number order, always: streams (verbatim or
  // recompressed), unpacked gen>0 strays, ObjStm batches.
  const streamNums = [...source.streams.keys()].sort((a, b) => a - b);
  const strayNums = [...source.dicts.values()].filter((o) => o.gen !== 0).map((o) => o.num).sort((a, b) => a - b);
  const order = [...streamNums, ...strayNums, ...objstm.map((b) => b.num)].sort((a, b) => a - b);
  for (const num of order) {
    objStart(num);
    if (source.streams.has(num)) {
      put(serializeStream(source.streams.get(num), orig, stats));
    } else if (objstmByNum.has(num)) {
      const b = objstmByNum.get(num);
      put(Buffer.from(`${b.num} 0 obj${b.dict}stream\r\n`, 'latin1'));
      put(b.data);
      put(Buffer.from(`\r\n${END_OF_STREAM} ${END_OF_OBJECT}\n`, 'latin1'));
    } else {
      const o = source.dicts.get(num);
      put(Buffer.from(`${o.num} ${o.gen} obj${o.body} endobj\n`, 'latin1'));
    }
  }

  // The whole cross-reference as one compressed /Type /XRef stream:
  // /W [1 4 2] — one byte of type, 4 of offset or ObjStm number, 2 of
  // index or generation. The full range 0..size-1 is emitted contiguously
  // (no /Index needed), with the free-head row for object 0 by convention.
  const size = source.maxNum + objstm.length + 2;
  objStart(xrefNum);
  const rows = [];
  const entry = (t, a, b) => {
    const r = Buffer.alloc(7);
    r[0] = t;
    r.writeUInt32BE(a, 1);
    r.writeUInt16BE(b, 5);
    return r;
  };
  for (let n = 0; n < size; n++) {
    if (offsets.has(n)) {
      // Fresh numbers above maxNum (the ObjStm batches and... no, the xref
      // stream itself) carry gen 0; strays and streams keep their own gen.
      const gen = source.streams.has(n)
        ? source.streams.get(n).gen
        : source.dicts.has(n)
          ? source.dicts.get(n).gen
          : 0;
      rows.push(entry(1, offsets.get(n), gen));
    } else if (residentIndex.has(n)) {
      rows.push(entry(2, stmOfResident.get(n), residentIndex.get(n)));
    } else {
      rows.push(entry(0, 0, 0)); // object 0's free head, or a never-used number
    }
  }
  const xrefData = snap(Buffer.concat(rows));

  // trailer keys ride the xref stream dict: Root, Info, ID.
  const keys = [];
  const refOf = (key) => {
    const m = new RegExp(`\\/${key}\\s+(\\d+ \\d+ R)`).exec(source.trailer);
    return m ? m[1] : null;
  };
  for (const key of ['Root', 'Info']) {
    const ref = refOf(key);
    if (ref) keys.push(`/${key} ${ref}`);
  }
  const idM = /\/ID\s*\[([^\]]*)\]/.exec(source.trailer);
  if (idM) keys.push(`/ID [${idM[1]}]`);

  put(Buffer.from(
    `${xrefNum} 0 obj<</Type/XRef/Size ${size}/W[1 4 2]/Filter /FlateDecode/Length ${xrefData.length}` +
      keys.map((k) => ' ' + k).join('') +
      '>>stream\r\n',
    'latin1'
  ));
  put(xrefData);
  put(Buffer.from(`\r\n${END_OF_STREAM} ${END_OF_OBJECT}\nstartxref\n${offsets.get(xrefNum)}\n%%EOF\n`, 'latin1'));

  const pdf = Buffer.concat(parts);
  stats.bytesAfter = pdf.length;
  return { pdf, stats };
}
