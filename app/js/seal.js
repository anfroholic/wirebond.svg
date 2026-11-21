/* The seal: two SHA-256 digests on a .wb.svg's root that say whether it was changed after it was written.
   wb:data-sha256 covers what a reader reads, and wb:drawing-sha256 everything drawn. SPEC.md, Seal, has the canonical
   form; this is the same as seal_digests() in tools/drc.py and tools/wbsvg.py, and must stay so.
   It isn't a signature. Anyone with this file can work the digests out again, so it catches a file edited in Inkscape or
   a text editor and passed on, not someone who means to hide a change. */
(function (W) {
  'use strict';
  W.WBSVG = W.WBSVG || {};
  const SVGNS = 'http://www.w3.org/2000/svg', WBNS = 'urn:wbsvg:0.2', XLNS = 'http://www.w3.org/1999/xlink';
  const SEAL = ['data-sha256', 'drawing-sha256'];

  // SHA-256 of a string's UTF-8, as hex. Synchronous, so the writer stays so: crypto.subtle is async, and absent on file://.
  const K = Uint32Array.from([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  function sha256(s) {
    const b = new TextEncoder().encode(s), n = (b.length + 72) & ~63, m = new Uint8Array(n), dv = new DataView(m.buffer);
    m.set(b); m[b.length] = 0x80;
    dv.setUint32(n - 8, Math.floor(b.length / 0x20000000)); dv.setUint32(n - 4, (b.length * 8) >>> 0);
    const H = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]), w = new Uint32Array(64);
    for (let o = 0; o < n; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + 4 * i);
      for (let i = 16; i < 64; i++) {
        const x = w[i - 15], y = w[i - 2];
        w[i] = w[i - 16] + ((x >>> 7 | x << 25) ^ (x >>> 18 | x << 14) ^ (x >>> 3)) + w[i - 7] + ((y >>> 17 | y << 15) ^ (y >>> 19 | y << 13) ^ (y >>> 10));
      }
      let a = H[0], c1 = H[1], c2 = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (let i = 0; i < 64; i++) {
        const t1 = (h + ((e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
        const t2 = (((a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10)) + ((a & c1) ^ (a & c2) ^ (c1 & c2))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c2; c2 = c1; c1 = a; a = (t1 + t2) | 0;
      }
      H[0] += a; H[1] += c1; H[2] += c2; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    return [...H].map(x => x.toString(16).padStart(8, '0')).join('');
  }

  const ws = s => String(s == null ? '' : s).replace(/[ \t\n\r]+/g, ' ').replace(/^ | $/g, '');

  /* [data, drawing] for a parsed .wb.svg's root element. One line per element, in document order, as JSON
     [depth, name, [attr, value, ...] sorted by attr, text]. A seal the file already carries is left out. */
  function digests(root) {
    const data = [], draw = [];
    const line = (depth, k, at, txt) => JSON.stringify([depth, k, Object.keys(at).sort().flatMap(a => [a, at[a]]), txt]);
    (function walk(e, depth, inData) {
      if (e.namespaceURI !== SVGNS) return;
      const k = e.localName;
      if (k === 'metadata' || (k === 'defs' && !e.children.length)) return;   // provenance, and the empty defs editors add
      const at = {};
      for (const a of e.attributes) {
        let name;
        if (a.namespaceURI === null) { if (a.localName === 'id') continue; name = a.localName; }
        else if (a.namespaceURI === WBNS) { if (depth === 0 && SEAL.includes(a.localName)) continue; name = 'wb:' + a.localName; }
        else if (a.namespaceURI === XLNS && a.localName === 'href') name = 'href';
        else continue;
        at[name] = ws(a.value);
      }
      const txt = ws([...e.childNodes].filter(c => c.nodeType === 3 || c.nodeType === 4).map(c => c.data).join(''));
      draw.push(line(depth, k, at, txt));
      inData = inData || 'wb:kind' in at;
      const pick = f => Object.fromEntries(Object.entries(at).filter(([a]) => f(a)));
      if (depth === 0) data.push(line(0, k, pick(a => a.startsWith('wb:')), ''));
      else if (inData && k !== 'title' && k !== 'desc') data.push(line(depth, k, pick(a => a !== 'class' && a !== 'style'), txt));
      for (const c of e.children) walk(c, depth + 1, inData);
    })(root, 0, false);
    return [sha256(data.join('\n')), sha256(draw.join('\n'))];
  }

  const parse = text => {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    if (doc.querySelector('parsererror')) throw new Error('This file isn\'t well-formed SVG.');
    return doc.documentElement;
  };

  // The file's text with its seal at the end of the root's start tag, replacing any it had. Nothing else changes.
  function stamp(text) {
    const [d, g] = digests(parse(text));
    return text.replace(/(<svg\b[^>]*?)(\s*\/?>)/, (_, head, end) =>
      head.replace(/\s+wb:(?:data|drawing)-sha256="[^"]*"/g, '') + ` wb:data-sha256="${d}" wb:drawing-sha256="${g}"` + end);
  }

  // What a root element's seal says: 'none', 'intact', 'drawing changed' or 'data changed'.
  function check(root) {
    const d = root.getAttributeNS(WBNS, SEAL[0]), g = root.getAttributeNS(WBNS, SEAL[1]);
    if (!d && !g) return 'none';
    const [D, G] = digests(root);
    return d !== D ? 'data changed' : g !== G ? 'drawing changed' : 'intact';
  }

  W.WBSVG.seal = { sha256, digests, stamp, check };
})(window);
