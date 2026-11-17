/* STEP (ISO 10303-21, AP214) written from scratch, and KiCad's embedded-file wrapping for it.
   Solids only: boxes and other flat-faced blocks for the die, its attach layer and its pads, and each wire as a chain of
   exact cylinders. Every solid is named and coloured. A die with artwork has its top face split into two colours, each
   face coloured on its own: STEP has no pictures, but it does have faces. Units are millimetres, z up, as KiCad places a
   footprint's model. */
(function (W) {
  'use strict';

  // A STEP real always has a decimal point: 1 is written "1.".
  const r = v => { let s = (Math.abs(v) < 5e-10 ? 0 : +v).toFixed(9).replace(/0+$/, ''); return s === '-0.' ? '0.' : s; };
  const str = s => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/[^\x20-\x7e]/g, '_') + "'";
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const len = a => Math.hypot(a[0], a[1], a[2]);
  const unit = a => { const L = len(a) || 1; return [a[0] / L, a[1] / L, a[2] / L]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const perp = t => unit(cross(t, Math.abs(t[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));

  function writer() {
    const lines = [], dirs = new Map(), styles = new Map(), solids = [], styled = [];
    let n = 0;
    const add = s => { lines.push(`#${++n}=${s};`); return '#' + n; };
    const pt = p => add(`CARTESIAN_POINT('',(${p.map(r).join(',')}))`);
    const dir = d => { d = unit(d); const k = d.map(r).join(','); if (!dirs.has(k)) dirs.set(k, add(`DIRECTION('',(${k}))`)); return dirs.get(k); };
    const axis = (p, z, x) => add(`AXIS2_PLACEMENT_3D('',${pt(p)},${dir(z)},${dir(x)})`);
    const vertex = p => add(`VERTEX_POINT('',${pt(p)})`);
    const style = rgb => {
      const k = rgb.map(v => (+v).toFixed(3)).join(',');
      if (!styles.has(k)) {
        const c = add(`COLOUR_RGB('',${k})`);
        const fill = add(`FILL_AREA_STYLE('',(${add(`FILL_AREA_STYLE_COLOUR('',${c})`)}))`);
        const side = add(`SURFACE_SIDE_STYLE('',(${add(`SURFACE_STYLE_FILL_AREA(${fill})`)}))`);
        styles.set(k, add(`PRESENTATION_STYLE_ASSIGNMENT((${add(`SURFACE_STYLE_USAGE(.BOTH.,${side})`)}))`));
      }
      return styles.get(k);
    };
    const solid = (name, rgb, faces) => {
      const id = add(`MANIFOLD_SOLID_BREP(${str(name)},${add(`CLOSED_SHELL('',(${faces.join(',')}))`)})`);
      solids.push(id);
      styled.push(add(`STYLED_ITEM('color',(${style(rgb)}),${id})`));
      return id;
    };

    /* A solid with flat faces: corner points, and each face as corner indices running anticlockwise seen from outside. */
    function block(name, rgb, verts, faces) {
      const vx = verts.map(vertex), edges = new Map();
      const edge = (a, b) => {
        const k = a < b ? a + '_' + b : b + '_' + a;
        if (!edges.has(k)) {
          const [i, j] = a < b ? [a, b] : [b, a], d = sub(verts[j], verts[i]);
          const line = add(`LINE('',${pt(verts[i])},${add(`VECTOR('',${dir(d)},${r(len(d))})`)})`);
          edges.set(k, { i, id: add(`EDGE_CURVE('',${vx[i]},${vx[j]},${line},.T.)`) });
        }
        const e = edges.get(k);
        return add(`ORIENTED_EDGE('',*,*,${e.id},${e.i === a ? '.T.' : '.F.'})`);
      };
      const fs = faces.map(f => {
        const loop = add(`EDGE_LOOP('',(${f.map((a, k) => edge(a, f[(k + 1) % f.length])).join(',')}))`);
        // Newell's normal, so a face that is a little out of square still faces the right way
        let nrm = [0, 0, 0];
        f.forEach((a, k) => { const p = verts[a], q = verts[f[(k + 1) % f.length]]; nrm = [nrm[0] + (p[1] - q[1]) * (p[2] + q[2]), nrm[1] + (p[2] - q[2]) * (p[0] + q[0]), nrm[2] + (p[0] - q[0]) * (p[1] + q[1])]; });
        const plane = add(`PLANE('',${axis(verts[f[0]], nrm, sub(verts[f[1]], verts[f[0]]))})`);
        return add(`ADVANCED_FACE('',(${add(`FACE_OUTER_BOUND('',${loop},.T.)`)}),${plane},.T.)`);
      });
      return solid(name, rgb, fs);
    }
    // Eight corners, bottom four then top four, each four anticlockwise seen from above.
    const BOX_FACES = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
    const hexa = (name, rgb, corners) => block(name, rgb, corners, BOX_FACES);

    /* An exact cylinder from a to b: one curved face with a seam, and two flat ends. */
    function cylinder(name, rgb, a, b, R) {
      const t = unit(sub(b, a)), s = perp(t), L = len(sub(b, a));
      const pa = axis(a, t, s), pb = axis(b, t, s);
      const at = p => [p[0] + R * s[0], p[1] + R * s[1], p[2] + R * s[2]];
      const v0 = vertex(at(a)), v1 = vertex(at(b));
      const c0 = add(`EDGE_CURVE('',${v0},${v0},${add(`CIRCLE('',${pa},${r(R)})`)},.T.)`);
      const c1 = add(`EDGE_CURVE('',${v1},${v1},${add(`CIRCLE('',${pb},${r(R)})`)},.T.)`);
      const seam = add(`EDGE_CURVE('',${v0},${v1},${add(`LINE('',${pt(at(a))},${add(`VECTOR('',${dir(t)},${r(L)})`)})`)},.T.)`);
      const oe = (e, f) => add(`ORIENTED_EDGE('',*,*,${e},${f ? '.T.' : '.F.'})`);
      const face = (loop, surf, sense) => add(`ADVANCED_FACE('',(${add(`FACE_OUTER_BOUND('',${add(`EDGE_LOOP('',(${loop.join(',')}))`)},.T.)`)}),${surf},${sense})`);
      const side = face([oe(c0, 1), oe(seam, 1), oe(c1, 0), oe(seam, 0)], add(`CYLINDRICAL_SURFACE('',${pa},${r(R)})`), '.T.');
      const bottom = face([oe(c0, 0)], add(`PLANE('',${pa})`), '.F.');
      const top = face([oe(c1, 1)], add(`PLANE('',${pb})`), '.T.');
      return solid(name, rgb, [side, bottom, top]);
    }

    /* A wire as a tube along a path of points. The path is thinned to what the tube's own size can show, and each
       cylinder runs a little past a bend, so the outside of the bend has no notch. */
    function tube(name, rgb, pts, d) {
      const R = d / 2, keep = thin(pts, Math.max(0.3 * R, 0.0005));
      if (keep.length < 2) return 0;
      for (let i = 0; i + 1 < keep.length; i++) {
        let a = keep[i], b = keep[i + 1];
        const t = unit(sub(b, a)), L = len(sub(b, a));
        if (L < 1e-7) continue;
        const reach = j => {
          if (j <= 0 || j >= keep.length - 1) return 0;
          const u = unit(sub(keep[j], keep[j - 1])), w = unit(sub(keep[j + 1], keep[j]));
          const th = Math.acos(Math.max(-1, Math.min(1, dot(u, w))));
          return Math.min(R * Math.tan(th / 2), 0.45 * L);
        };
        const ea = reach(i), eb = reach(i + 1);
        a = [a[0] - t[0] * ea, a[1] - t[1] * ea, a[2] - t[2] * ea];
        b = [b[0] + t[0] * eb, b[1] + t[1] * eb, b[2] + t[2] * eb];
        cylinder(name, rgb, a, b, R);
      }
      return keep.length - 1;
    }

    /* A block on a four-cornered outline, from z0 to z1, whose top face is split into two colours. Each loop is an outline
       between the two: an accent area's own outline runs anticlockwise seen from above, a hole in one clockwise. Every loop
       has accent on one side and base on the other, so the faces either side of it share its edges and the solid stays
       closed. faces says which loops bound which face: accent [{outer, holes}], base [{outer, holes}], and the holes in
       the base face that reaches the block's edge. */
    function painted(name, base, accent, quad, z0, z1, loops, faces) {
      const oe = (e, f) => add(`ORIENTED_EDGE('',*,*,${e},${f ? '.T.' : '.F.'})`);
      const lineEdge = (va, vb, a, b) => add(`EDGE_CURVE('',${va},${vb},${add(`LINE('',${pt(a)},${add(`VECTOR('',${dir(sub(b, a))},${r(len(sub(b, a)))})`)})`)},.T.)`);
      const bound = (es, outer) => add(`${outer ? 'FACE_OUTER_BOUND' : 'FACE_BOUND'}('',${add(`EDGE_LOOP('',(${es.join(',')}))`)},.T.)`);
      const at = (p, z) => [p[0], p[1], z];
      const vb = quad.map(p => vertex(at(p, z0))), vt = quad.map(p => vertex(at(p, z1)));
      const eb = quad.map((p, i) => lineEdge(vb[i], vb[(i + 1) % 4], at(p, z0), at(quad[(i + 1) % 4], z0)));
      const et = quad.map((p, i) => lineEdge(vt[i], vt[(i + 1) % 4], at(p, z1), at(quad[(i + 1) % 4], z1)));
      const ev = quad.map((p, i) => lineEdge(vb[i], vt[i], at(p, z0), at(p, z1)));
      const all = [], painted = [];
      all.push(add(`ADVANCED_FACE('',(${bound(eb.map(e => oe(e, 0)).reverse(), true)}),${add(`PLANE('',${axis([0, 0, z0], [0, 0, -1], [1, 0, 0])})`)},.T.)`));
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4, d = sub(at(quad[j], 0), at(quad[i], 0));
        all.push(add(`ADVANCED_FACE('',(${bound([oe(eb[i], 1), oe(ev[j], 1), oe(et[i], 0), oe(ev[i], 0)], true)}),${add(`PLANE('',${axis(at(quad[i], z0), [d[1], -d[0], 0], d)})`)},.T.)`));
      }
      // each outline's edges, made once and used by the face on either side
      const LE = loops.map(L => {
        const vs = L.map(p => vertex(at(p, z1))), n = L.length;
        return L.map((p, i) => lineEdge(vs[i], vs[(i + 1) % n], at(p, z1), at(L[(i + 1) % n], z1)));
      });
      const fwd = i => LE[i].map(e => oe(e, 1)), rev = i => LE[i].map(e => oe(e, 0)).reverse();
      const top = add(`PLANE('',${axis([0, 0, z1], [0, 0, 1], [1, 0, 0])})`);
      const face = (bounds, rgb) => { const f = add(`ADVANCED_FACE('',(${bounds.join(',')}),${top},.T.)`); all.push(f); painted.push([f, rgb]); };
      face([bound(et.map(e => oe(e, 1)), true), ...faces.edgeHoles.map(i => bound(rev(i), false))], base);
      for (const f of faces.base) face([bound(rev(f.outer), true), ...f.holes.map(i => bound(rev(i), false))], base);
      for (const f of faces.accent) face([bound(fwd(f.outer), true), ...f.holes.map(i => bound(fwd(i), false))], accent);
      const id = solid(name, base, all);
      for (const [f, rgb] of painted) styled.push(add(`STYLED_ITEM('color',(${style(rgb)}),${f})`));
      return id;
    }

    function text(name) {
      const ctx = '#' + (n + 1);
      // Fixed entities, numbered after the geometry, which refers to nothing here
      const ids = [];
      const put = s => { lines.push(`#${++n}=${s};`); ids.push(n); return '#' + n; };
      put(`(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${n + 5})) GLOBAL_UNIT_ASSIGNED_CONTEXT((#${n + 2},#${n + 3},#${n + 4})) REPRESENTATION_CONTEXT('',''))`);
      const mm = put(`(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.))`);
      put(`(NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.))`);
      put(`(NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT())`);
      put(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),${mm},'distance_accuracy_value','confusion accuracy')`);
      const app = put(`APPLICATION_CONTEXT('core data for automotive mechanical design processes')`);
      put(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${app})`);
      const pc = put(`PRODUCT_CONTEXT('',${app},'mechanical')`);
      const prod = put(`PRODUCT(${str(name)},${str(name)},'',(${pc}))`);
      put(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(${prod}))`);
      const pdf = put(`PRODUCT_DEFINITION_FORMATION('','',${prod})`);
      const pdc = put(`PRODUCT_DEFINITION_CONTEXT('part definition',${app},'design')`);
      const pd = put(`PRODUCT_DEFINITION('design','',${pdf},${pdc})`);
      const pds = put(`PRODUCT_DEFINITION_SHAPE('','',${pd})`);
      const origin = axis([0, 0, 0], [0, 0, 1], [1, 0, 0]);
      const rep = put(`ADVANCED_BREP_SHAPE_REPRESENTATION(${str(name)},(${[origin, ...solids].join(',')}),${ctx})`);
      put(`SHAPE_DEFINITION_REPRESENTATION(${pds},${rep})`);
      put(`MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(${styled.join(',')}),${ctx})`);
      return `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('Wire bond assembly'),'2;1');\nFILE_NAME(${str(name + '.step')},'2026-01-01T00:00:00',(''),(''),'Wire Bond Bench','Wire Bond Bench','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\nENDSEC;\nDATA;\n${lines.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`;
    }

    return { block, hexa, cylinder, tube, painted, text, get solids() { return solids.length; } };
  }

  // Douglas-Peucker: the fewest points that stay within tol of the path.
  function thin(pts, tol) {
    if (pts.length < 3) return pts.slice();
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [i, j] = stack.pop();
      const a = pts[i], ab = sub(pts[j], a), L = len(ab);
      let far = -1, k = 0;
      for (let m = i + 1; m < j; m++) {
        const am = sub(pts[m], a), dd = L ? len(cross(ab, am)) / L : len(am);
        if (dd > far) { far = dd; k = m; }
      }
      if (far > tol) { keep[k] = 1; stack.push([i, k], [k, j]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  /* ---- a two-colour picture as outlines, for a painted face ----
     mask holds 1 for accent and 0 for base, w by h, row 0 at the top. Points are pixel corners [column, row], rows counting
     down as on screen, so an accent area's outline runs clockwise on screen: anticlockwise once y points up, as in a
     model. Returns the loops, which loops bound which face, as painted() takes them, and the number of points. */
  function outlines(mask, w, h, opts) {
    opts = opts || {};
    const tol = opts.tol === undefined ? 1.2 : opts.tol, minPx = opts.minPx === undefined ? 12 : opts.minPx;
    const m = Uint8Array.from(mask);
    // The edge pixels go to base, so no outline meets the block's edge.
    for (let c = 0; c < w; c++) m[c] = m[(h - 1) * w + c] = 0;
    for (let r = 0; r < h; r++) m[r * w] = m[r * w + w - 1] = 0;
    // No two accent pixels may touch only at a corner: there an outline would meet itself. Filling one of the pair joins them.
    for (let changed = true; changed;) {
      changed = false;
      for (let r = 0; r + 1 < h; r++) for (let c = 0; c + 1 < w; c++) {
        const i = r * w + c, a = m[i], b = m[i + 1];
        if (a !== b && a === m[i + w + 1] && b === m[i + w]) { m[a ? i + 1 : i] = 1; changed = true; }
      }
    }
    const comp = new Int32Array(w * h), stack = new Int32Array(w * h);
    const label = () => {
      comp.fill(-1);
      let n = 0;
      for (let s = 0; s < w * h; s++) {
        if (comp[s] >= 0) continue;
        const v = m[s];
        let top = 0;
        stack[top++] = s; comp[s] = n;
        while (top) {
          const q = stack[--top], c = q % w;
          if (c + 1 < w && comp[q + 1] < 0 && m[q + 1] === v) { comp[q + 1] = n; stack[top++] = q + 1; }
          if (c > 0 && comp[q - 1] < 0 && m[q - 1] === v) { comp[q - 1] = n; stack[top++] = q - 1; }
          if (q + w < w * h && comp[q + w] < 0 && m[q + w] === v) { comp[q + w] = n; stack[top++] = q + w; }
          if (q >= w && comp[q - w] < 0 && m[q - w] === v) { comp[q - w] = n; stack[top++] = q - w; }
        }
        n++;
      }
      return n;
    };
    // Specks smaller than minPx take the colour round them. The base area round the edge never does.
    let n = label();
    if (minPx > 1) {
      const size = new Int32Array(n);
      for (let k = 0; k < w * h; k++) size[comp[k]]++;
      let flipped = false;
      for (let k = 0; k < w * h; k++) if (size[comp[k]] < minPx && comp[k] !== comp[0]) { m[k] = 1 - m[k]; flipped = true; }
      if (flipped) n = label();
    }
    // Every pixel edge between accent and base, with accent on its left once y points up. With no corner-only touches, each
    // corner starts at most one, so an outline is just followed from corner to corner.
    const W1 = w + 1, next = new Int32Array(W1 * (h + 1)).fill(-1);
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const i = r * w + c;
      if (!m[i]) continue;
      if (!m[i + w]) next[(r + 1) * W1 + c] = (r + 1) * W1 + c + 1;
      if (!m[i + 1]) next[(r + 1) * W1 + c + 1] = r * W1 + c + 1;
      if (!m[i - w]) next[r * W1 + c + 1] = r * W1 + c;
      if (!m[i - 1]) next[r * W1 + c] = (r + 1) * W1 + c;
    }
    const loops = [], accent = new Map(), base = new Map(), edgeHoles = [], edge = comp[0];
    const faceOf = (map, k) => map.get(k) || map.set(k, { outer: -1, holes: [] }).get(k);
    let verts = 0;
    for (let s = 0; s < next.length; s++) {
      if (next[s] < 0) continue;
      const pts = [];
      for (let v = s; next[v] >= 0;) { pts.push([v % W1, (v - v % W1) / W1]); const u = next[v]; next[v] = -1; v = u; }
      // which accent area and which base area this outline lies between, from the pixels either side of its first edge
      const [p0, p1] = pts, dc = p1[0] - p0[0], dr = p1[1] - p0[1], mc = (p0[0] + p1[0]) / 2, mr = (p0[1] + p1[1]) / 2;
      const ia = Math.floor(mr - dc / 2) * w + Math.floor(mc + dr / 2), ib = Math.floor(mr + dc / 2) * w + Math.floor(mc - dr / 2);
      let area = 0;
      for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; area += p[0] * q[1] - q[0] * p[1]; }
      const own = area < 0, k = loops.length, L = simplifyLoop(pts, tol);
      loops.push(L); verts += L.length;
      const A = faceOf(accent, comp[ia]);
      if (own) A.outer = k; else A.holes.push(k);
      if (comp[ib] === edge) edgeHoles.push(k);
      else { const B = faceOf(base, comp[ib]); if (!own) B.outer = k; else B.holes.push(k); }
    }
    return { loops, faces: { accent: [...accent.values()], base: [...base.values()], edgeHoles }, verts, w, h };
  }
  // A closed outline with its straight runs as single edges, then thinned to within tol.
  function simplifyLoop(L, tol) {
    const n = L.length;
    const P = L.filter((p, i) => { const a = L[(i + n - 1) % n], b = L[(i + 1) % n]; return (p[0] - a[0]) * (b[1] - p[1]) !== (p[1] - a[1]) * (b[0] - p[0]); });
    if (tol <= 0 || P.length < 6) return P;
    let far = 0, fd = -1;
    P.forEach((p, i) => { const d = (p[0] - P[0][0]) ** 2 + (p[1] - P[0][1]) ** 2; if (d > fd) { fd = d; far = i; } });
    const half = pts => thin(pts.map(p => [p[0], p[1], 0]), tol).map(p => [p[0], p[1]]);
    const out = half(P.slice(0, far + 1)).slice(0, -1).concat(half(P.slice(far).concat([P[0]])).slice(0, -1));
    return out.length >= 3 ? out : P;
  }

  /* ---- embedding a file in a KiCad board or footprint ----
     KiCad stores an embedded file as a zstd frame, base64 encoded, checked by the lowercase SHA-256 of the file itself.
     A zstd frame may hold its data in uncompressed blocks, so no compressor is needed. KiCad compresses it on its next save. */
  function zstdRaw(bytes) {
    const BLK = 131072, nBlocks = Math.max(1, Math.ceil(bytes.length / BLK));
    const out = new Uint8Array(9 + nBlocks * 3 + bytes.length);
    out.set([0x28, 0xb5, 0x2f, 0xfd, 0xa0], 0);   // magic; descriptor: single segment, 4-byte content size
    new DataView(out.buffer).setUint32(5, bytes.length, true);
    let o = 9;
    for (let b = 0; b < nBlocks; b++) {
      const c = bytes.subarray(b * BLK, (b + 1) * BLK), h = (b === nBlocks - 1 ? 1 : 0) | (c.length << 3);
      out[o++] = h & 255; out[o++] = (h >> 8) & 255; out[o++] = (h >> 16) & 255;
      out.set(c, o); o += c.length;
    }
    return out;
  }
  const K256 = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  function sha256(bytes) {
    const L = bytes.length, total = Math.ceil((L + 9) / 64) * 64, m = new Uint8Array(total);
    m.set(bytes); m[L] = 0x80;
    const dv = new DataView(m.buffer);
    dv.setUint32(total - 8, Math.floor(L / 0x20000000), false); dv.setUint32(total - 4, (L * 8) >>> 0, false);
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]), w = new Uint32Array(64);
    const ror = (x, k) => (x >>> k) | (x << (32 - k));
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const s0 = ror(w[i - 15], 7) ^ ror(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = ror(w[i - 2], 17) ^ ror(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0;
        const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    return Array.from(H, x => x.toString(16).padStart(8, '0')).join('');
  }
  function base64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  /* What KiCad needs to embed a file: its checksum, and its data as base64 lines for the "(data |...|)" token. */
  function embed(name, content) {
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const b64 = base64(zstdRaw(bytes)), lines = [];
    for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
    return { name, checksum: sha256(bytes), lines, bytes: bytes.length };
  }
  // The file itself, as KiCad writes it in a board's or a footprint's embedded_files list, at the given indent.
  const fileEntry = (e, type, tab) => `${tab}(file\n${tab}\t(name "${e.name}")\n${tab}\t(type ${type})\n${tab}\t(data |${e.lines.join('\n' + tab + '\t\t')}|)\n${tab}\t(checksum "${e.checksum}")\n${tab})`;
  // A footprint's reference to a file the board holds.
  const fileRef = (e, type, tab) => `${tab}(embedded_files\n${tab}\t(file\n${tab}\t\t(name "${e.name}")\n${tab}\t\t(type ${type})\n${tab}\t\t(checksum "${e.checksum}")\n${tab}\t)\n${tab})`;

  W.WBX = W.WBX || {};
  W.WBX.step = { writer, thin, outlines, zstdRaw, sha256, embed, fileEntry, fileRef };
})(typeof window !== 'undefined' ? window : globalThis);
