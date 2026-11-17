/* Reading a .wb.svg back in.
   parse() reads what the file says, by wb:kind, into plain data in µm. toKicad() writes that as a KiCad board in the
   form the bench already round-trips: the lands as a footprint, each die as a footprint with wb_kind die, each wire as a
   wb_kind wire footprint, fiducials and parts as footprints, and the board picture as graphics on its own layers. From
   there the bench opens it as it opens any board it wrote, so a reopened file can be edited and exported again.
   Coordinates carry straight over: 1 µm in the file is 0.001 mm on the board, from the same corner. */
(function (W) {
  'use strict';
  const NS = 'urn:wbx:0.1';
  const q = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
  const n = v => { const s = (+v).toFixed(6).replace(/0+$/, '').replace(/\.$/, ''); return s === '-0' || s === '' ? '0' : s; };
  const mm = v => n(v / 1000);

  const wb = (e, k) => e.getAttributeNS(NS, k) || e.getAttribute('wb:' + k);
  const num = (e, k, d) => { const v = e.getAttribute(k); return v === null || v === '' ? (d === undefined ? 0 : d) : +v; };
  const ancestor = (e, kind) => { for (let p = e.parentElement; p; p = p.parentElement) if (wb(p, 'kind') === kind) return p; return null; };
  const titleOf = e => { const t = [...e.children].find(c => c.localName === 'title'); return t ? t.textContent : ''; };

  // translate(x y) [rotate(a)] scale(1 -1), as the spec allows for a die group.
  function dieTransform(s) {
    const m = String(s || '').match(/translate\(\s*([-\d.e]+)[\s,]+([-\d.e]+)\s*\)\s*(?:rotate\(\s*([-\d.e]+)\s*\))?\s*scale\(\s*1[\s,]+-1\s*\)/);
    if (!m) throw new Error('A die group has a transform this can\'t read: ' + s);
    return { tx: +m[1], ty: +m[2], rot: m[3] ? -(+m[3]) : 0 };
  }
  // A land turned by an angle that isn't a quarter turn carries rotate(a cx cy).
  const rotateOf = s => { const m = String(s || '').match(/rotate\(\s*([-\d.e]+)/); return m ? -(+m[1]) : 0; };

  // Path data of straight segments, as lists of points; each M starts a new one.
  function subpaths(d) {
    const out = [], toks = String(d).match(/[MLHVZmlhvz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
    let cur = null, x = 0, y = 0, cmd = 'M', i = 0;
    while (i < toks.length) {
      if (/[A-Za-z]/.test(toks[i])) { cmd = toks[i++]; if (cmd === 'Z' || cmd === 'z') { if (cur) cur.closed = true; continue; } }
      const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
      if (C === 'M' || C === 'L') { const a = +toks[i++], b = +toks[i++]; x = rel ? x + a : a; y = rel ? y + b : b; }
      else if (C === 'H') { const a = +toks[i++]; x = rel ? x + a : a; }
      else if (C === 'V') { const b = +toks[i++]; y = rel ? y + b : b; }
      else { i++; continue; }
      if (C === 'M') { cur = { pts: [x, y], closed: false }; out.push(cur); if (cmd === 'M') cmd = 'L'; else cmd = 'l'; }
      else if (cur) cur.pts.push(x, y);
    }
    return out;
  }

  function shapeOf(e) {
    const k = e.localName;
    if (k === 'circle') return { kind: 'circle', x: num(e, 'cx'), y: num(e, 'cy'), r: num(e, 'r') };
    if (k === 'rect') return { kind: 'rect', x: num(e, 'x'), y: num(e, 'y'), w: num(e, 'width'), h: num(e, 'height') };
    if (k === 'path') {
      const P = subpaths(e.getAttribute('d')).flatMap(s => s.pts), X = P.filter((_, i) => i % 2 === 0), Y = P.filter((_, i) => i % 2 === 1);
      return { kind: 'rect', x: Math.min(...X), y: Math.min(...Y), w: Math.max(...X) - Math.min(...X), h: Math.max(...Y) - Math.min(...Y), path: true };
    }
    if (k === 'g') {
      const parts = [...e.children].filter(c => ['circle', 'rect', 'path', 'g'].includes(c.localName)).map(shapeOf);
      const box = parts.map(s => s.kind === 'circle' ? [s.x - s.r, s.y - s.r, s.x + s.r, s.y + s.r] : [s.x, s.y, s.x + s.w, s.y + s.h]);
      const x0 = Math.min(...box.map(b => b[0])), y0 = Math.min(...box.map(b => b[1])), x1 = Math.max(...box.map(b => b[2])), y1 = Math.max(...box.map(b => b[3]));
      return { kind: 'rect', x: x0, y: y0, w: x1 - x0, h: y1 - y0, path: true };
    }
    return null;
  }
  // The stroke colours were darkened for white paper (see export.js), so this lightens them back.
  const lighten = hex => { const m = String(hex || '').match(/^#(..)(..)(..)$/); return m ? '#' + [m[1], m[2], m[3]].map(v => Math.min(255, Math.round(parseInt(v, 16) / 0.72)).toString(16).padStart(2, '0')).join('') : null; };

  /* ---- reading ---- */
  function parse(text) {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    if (doc.querySelector('parsererror')) throw new Error('This file isn\'t well-formed SVG, so it can\'t be read.');
    const root = doc.documentElement;
    const all = [...root.getElementsByTagName('*')];
    const kinds = k => all.filter(e => wb(e, 'kind') === k);
    if (!kinds('die').length) throw new Error('This SVG has no wirebond.svg die in it (no wb:kind="die"), so there\'s nothing to open.');
    const out = { design: wb(root, 'design') || '', notes: [], rules: {} };
    for (const [k, key] of [['rule-wire-gap', 'gap'], ['rule-edge-clear', 'edge']]) if (wb(root, k)) out.rules[key] = +wb(root, k);

    // The board: its outline and, if there is one, the board view the app writes, with the picture in it.
    const outline = kinds('outline').find(e => !ancestor(e, 'die'));
    out.outline = outline ? { x: num(outline, 'x'), y: num(outline, 'y'), w: num(outline, 'width'), h: num(outline, 'height'), name: wb(outline, 'name') || 'board' } : null;
    const view = kinds('board')[0] || null;
    out.picture = {};
    if (view) for (const g of view.querySelectorAll('g')) {
      const name = g.getAttribute('inkscape:label') || g.getAttributeNS('http://www.inkscape.org/namespaces/inkscape', 'label');
      if (!/^(F|B|In\d+)\.(Cu|SilkS)$|^Edge\.Cuts$/.test(name || '')) continue;
      const L = out.picture[name] = { fills: [], strokes: [], circles: [], texts: [] };
      for (const e of g.children) {
        if (e.localName === 'path') {
          const w = num(e, 'stroke-width', 0), fill = e.getAttribute('class') === 'f';
          for (const s of subpaths(e.getAttribute('d'))) (fill ? L.fills : L.strokes).push({ pts: s.pts, closed: s.closed, w });
        } else if (e.localName === 'circle') L.circles.push([num(e, 'cx'), num(e, 'cy'), num(e, 'r')]);
        else if (e.localName === 'text') {
          const size = num(e, 'font-size', 1000), r = rotateOf(e.getAttribute('transform'));
          L.texts.push({ s: e.textContent, x: num(e, 'x'), y: num(e, 'y') - size * 0.35, size, rot: r });
        }
      }
    }
    /* The substrate's copper marks, in the bond diagram: a fiducial named like one (U102.F1), or the copper the app draws for
       a mark that isn't used. They go back into their footprint as copper, in the order written, so they come back with
       the same names, and their roles go with them. Any other fiducial is the board's own, kept as a footprint below. */
    const MARK = /^(.+)\.F(\d+)'*$/;
    const isMark = e => !ancestor(e, 'die') && !ancestor(e, 'board') && (wb(e, 'kind') === 'fiducial' ? MARK.test(wb(e, 'name') || '') : !wb(e, 'kind') && /\bmark\b/.test(e.getAttribute('class') || ''));
    out.marks = all.filter(isMark).map(e => {
      const name = wb(e, 'kind') ? wb(e, 'name') : (titleOf(e).match(/^(\S+):/) || [])[1] || '', ref = (name.match(MARK) || [])[1];
      const geo = e.localName === 'circle' ? { circle: [num(e, 'cx'), num(e, 'cy'), num(e, 'r')] } : e.localName === 'path' ? { pts: (subpaths(e.getAttribute('d'))[0] || {}).pts } : {};
      return Object.assign({ name, ref, role: wb(e, 'kind') ? wb(e, 'role') || 'align' : 'off', datum: wb(e, 'datum') || null }, geo);
    }).filter(m => m.ref && (m.circle || (m.pts && m.pts.length >= 6)));
    out.fids = kinds('fiducial').filter(e => !ancestor(e, 'die') && !isMark(e)).map(e =>({ name: wb(e, 'name'), role: wb(e, 'role') || 'align', datum: wb(e, 'datum') || null, shape: shapeOf(e) })).filter(f => f.shape);
    if (kinds('fiducial').some(e => ancestor(e, 'die'))) out.notes.push('Eye points drawn inside a die aren\'t kept: the bench has no place for them yet.');
    out.parts = kinds('part').map(e => ({ name: wb(e, 'name'), height: +wb(e, 'height') || null, value: (titleOf(e).match(/^[^:]+: ([^,]+)/) || [])[1] || '', box: shapeOf(e) }));

    // Lands, and the paddle the app draws under the die, which has no wb:kind but places a die when there's nothing else.
    out.lands = kinds('land').map(e => {
      const name = wb(e, 'name') || '', dot = name.lastIndexOf('.');
      const w = num(e, 'width'), h = num(e, 'height'), rx = num(e, 'rx', 0), s = Math.min(w, h);
      return { name, ref: dot > 0 ? name.slice(0, dot) : 'L', num: dot > 0 ? name.slice(dot + 1) : name, net: wb(e, 'net') || null,
        x: num(e, 'x') + w / 2, y: num(e, 'y') + h / 2, w, h, rot: rotateOf(e.getAttribute('transform')),
        shape: rx >= s / 2 - 1e-6 && rx > 0 ? (Math.abs(w - h) < 1e-6 ? 'circle' : 'oval') : rx > 0 ? 'roundrect' : 'rect', rr: rx > 0 ? rx / s : 0 };
    });
    const pad = all.find(e => e.localName === 'rect' && /\bpaddle\b/.test(e.getAttribute('class') || ''));
    out.paddle = pad ? { x: num(pad, 'x') + num(pad, 'width') / 2, y: num(pad, 'y') + num(pad, 'height') / 2, w: num(pad, 'width'), h: num(pad, 'height'), rot: rotateOf(pad.getAttribute('transform')),
      num: (titleOf(pad).match(/^Die paddle \S* (\S+)/) || [])[1] || '' } : null;

    // The stack: each die's thickness and attach, the board's thickness and a glob top.
    const layers = kinds('layer').map(e => ({ name: wb(e, 'name') || '', role: wb(e, 'role') || '', material: wb(e, 'material') || null, z: -(num(e, 'y') + num(e, 'height')), t: num(e, 'height') }));
    const sub = layers.find(l => l.role === 'substrate');
    // A thickness the file marks as assumed stays unstated, so it reads as assumed again.
    const subEl = kinds('layer').find(e => wb(e, 'role') === 'substrate');
    out.boardThick = sub && !/assumed/.test(titleOf(subEl)) ? sub.t : null;
    const mold = layers.find(l => l.role === 'mold');
    out.glob = mold ? mold.z + mold.t : null;

    // Dies: placement, outline, pads, the picture of the artwork and their height.
    const dieGroups = kinds('die');
    // A placement tolerance is read from its indicator's attributes alone; what the indicator draws is for people.
    const tols = kinds('tolerance');
    out.dies = dieGroups.map(g => {
      const id = wb(g, 'name') || 'D1', T = dieTransform(g.getAttribute('transform'));
      const o = [...g.children].find(c => wb(c, 'kind') === 'outline');
      if (!o) throw new Error(`Die ${id} has no outline (wb:kind="outline"), so its size is unknown.`);
      const name = (titleOf(o).match(/^[^:]+: (.+?), [\d.]+ × [\d.]+ mm/) || [])[1] || id;
      const pads = [...g.querySelectorAll('*')].filter(e => wb(e, 'kind') === 'pad').map(e => ({ num: wb(e, 'name'), net: wb(e, 'net') || null, x: num(e, 'x'), y: num(e, 'y'), w: num(e, 'width'), h: num(e, 'height') }));
      // Its artwork: an image inside the group, or the app's own, in a group titled "<name> artwork" just before it.
      let img = g.querySelector('image');
      const prev = g.previousElementSibling;
      if (!img && prev && / artwork$/.test(titleOf(prev))) img = prev.querySelector('image');
      const href = img ? img.getAttribute('href') || img.getAttributeNS('http://www.w3.org/1999/xlink', 'href') : null;
      const art = href && /^data:image\/[a-z]+;base64,/.test(href) ? href.slice(href.indexOf(',') + 1) : null;
      const die = layers.find(l => l.role === 'die' && l.name === id) || (dieGroups.length === 1 ? layers.find(l => l.role === 'die') : null);
      const att = layers.find(l => l.role === 'attach' && l.name === id + ' attach') || (dieGroups.length === 1 ? layers.find(l => l.role === 'attach') : null);
      const tl = tols.find(e => wb(e, 'applies-to') === id), tol = tl && wb(tl, 'char') === 'position' ? +wb(tl, 'tol') || 0 : 0;
      if (tl && !tol) out.notes.push(`${id}'s placement tolerance isn't a position tolerance with a diameter, so it isn't kept.`);
      return { id, name, w: num(o, 'width'), h: num(o, 'height'), tx: T.tx, ty: T.ty, rot: T.rot, pads, art, tol, cell: wb(g, 'gds-cell') || null, padLayer: wb(g, 'pad-layer') || null,
        thick: die ? die.t : null, bottom: die ? die.z : null, attach: die ? (att ? att.t : 0) : null };
    });
    // A die whose underside isn't on its attach on the board sits on another die, or at a height of its own.
    for (const d of out.dies) {
      if (d.bottom == null) continue;
      const base = d.bottom - (d.attach || 0);
      if (base < 0.5) continue;
      const under = out.dies.find(o => o !== d && o.bottom != null && Math.abs(o.bottom + o.thick - base) < 0.5);
      if (under) d.on = under.id; else { d.on = 'custom'; d.customUm = d.bottom; }
    }

    out.profiles = kinds('profile').map(e => {
      const choice = wb(e, 'choice');
      if (choice) return { name: wb(e, 'name'), choice };
      const pl = [...e.children].find(c => c.localName === 'polyline');
      return { name: wb(e, 'name'), material: wb(e, 'material') || 'Au', d: pl ? +pl.getAttribute('stroke-width') : 25, style: wb(e, 'style') || 'ball-wedge', dir: wb(e, 'dir') || 'forward',
        moves: wb(e, 'moves') || '180/0', interp: wb(e, 'interp') === 'polyline' ? 'polyline' : 'spline', colour: pl ? lighten(pl.getAttribute('stroke')) : null };
    });
    out.wires = kinds('wire').map(e => ({ name: wb(e, 'name'), from: wb(e, 'from') || '', to: wb(e, 'to') || '', toKind: wb(e, 'to-kind') || null, profile: wb(e, 'profile') || null,
      seq: +wb(e, 'seq') || null, net: wb(e, 'net') || null, x1: num(e, 'x1'), y1: num(e, 'y1'), x2: num(e, 'x2'), y2: num(e, 'y2'), d: num(e, 'stroke-width', 25) }));
    out.wires.forEach((w, i) => { if (!w.seq) w.seq = i + 1; });
    return out;
  }

  /* ---- writing it as a board ---- */
  const LAYERS = [[0, 'F.Cu', 'signal'], [2, 'B.Cu', 'signal'], [9, 'F.Adhes', 'user', 'F.Adhesive'], [11, 'B.Adhes', 'user', 'B.Adhesive'], [13, 'F.Paste', 'user'], [15, 'B.Paste', 'user'], [5, 'F.SilkS', 'user', 'F.Silkscreen'], [7, 'B.SilkS', 'user', 'B.Silkscreen'], [1, 'F.Mask', 'user'], [3, 'B.Mask', 'user'], [17, 'Dwgs.User', 'user', 'User.Drawings'], [19, 'Cmts.User', 'user', 'User.Comments'], [25, 'Edge.Cuts', 'user'], [31, 'F.CrtYd', 'user', 'F.Courtyard'], [29, 'B.CrtYd', 'user', 'B.Courtyard'], [35, 'F.Fab', 'user'], [33, 'B.Fab', 'user'], [55, 'User.9', 'user', 'Wirebond']];
  const xy = (x, y) => `(xy ${mm(x)} ${mm(y)})`;
  const stroke = w => `(stroke (width ${mm(w)}) (type solid))`;
  const hidden = (k, v) => `\t\t(property ${q(k)} ${q(v)} (at 0 0 0) (layer "F.Fab") (hide yes) (effects (font (size 0.1 0.1) (thickness 0.01))))`;
  const BARE = '(attr board_only exclude_from_pos_files exclude_from_bom allow_missing_courtyard)';
  const rot = (x, y, a) => { const r = a * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return [x * c + y * s, -x * s + y * c]; };

  function toKicad(m) {
    const o = [`(kicad_pcb`, `\t(version 20260206)`, `\t(generator "wbx_explorer")`, `\t(generator_version "10.0")`,
      `\t(general\n${m.boardThick ? `\t\t(thickness ${n(m.boardThick / 1000)})\n` : ''}\t\t(legacy_teardrops no)\n\t)`, `\t(paper "A4")`,
      `\t(layers\n${LAYERS.map(r => `\t\t(${r[0]} ${q(r[1])} ${r[2]}${r[3] ? ' ' + q(r[3]) : ''})`).join('\n')}\n\t)`, `\t(setup\n\t\t(pad_to_mask_clearance 0)\n\t)`,
      `\t(property "wb_source" "opened from a .wb.svg: a picture of the board, its copper has no nets")`];
    if (m.design) o.push(`\t(property "wb_design" ${q(m.design)})`);
    if (m.picture && m.picture['F.Cu']) o.push(`\t(property "wb_picture" "yes")`);
    // A file written from a lone footprint has no board, and its numbers start at the crop's corner: keep it that way.
    if (!m.outline && !(m.picture && m.picture['Edge.Cuts'])) o.push(`\t(property "wb_board" "none")`);

    // The lands, one footprint per reference, at the origin so the pads carry board positions. The paddle joins the biggest.
    const refs = new Map(), marks = new Map();
    for (const l of m.lands) { if (!refs.has(l.ref)) refs.set(l.ref, []); refs.get(l.ref).push(l); }
    for (const k of m.marks || []) { if (!marks.has(k.ref)) marks.set(k.ref, []); marks.get(k.ref).push(k); if (!refs.has(k.ref)) refs.set(k.ref, []); }
    const biggest = [...refs.keys()].sort((a, b) => refs.get(b).length - refs.get(a).length)[0];
    for (const [ref, ls] of refs) {
      o.push(`\t(footprint ${q('wbx_substrate:' + ref)}\n\t\t(layer "F.Cu")\n\t\t(at 0 0)\n\t\t(property "Reference" ${q(ref)} (at 0 0 0) (layer "F.Fab") (hide yes) (effects (font (size 0.5 0.5) (thickness 0.08))))`);
      // Its copper marks: the role of each as a field, and the mark itself as filled copper, in the order the file has them.
      const ms = marks.get(ref) || [];
      for (const k of ms) o.push(hidden('wb_fiducial_' + k.name, k.role));
      for (const k of ms) if (k.datum && /^[BC]$/.test(k.datum)) o.push(hidden('wb_datum_' + k.name, k.datum));
      o.push('\t\t(attr smd)');
      for (const k of ms) o.push(k.circle ? `\t\t(fp_circle (center ${mm(k.circle[0])} ${mm(k.circle[1])}) (end ${mm(k.circle[0] + k.circle[2])} ${mm(k.circle[1])}) (stroke (width 0) (type solid)) (fill yes) (layer "F.Cu"))`
        : `\t\t(fp_poly (pts ${chunk(k.pts)}) (stroke (width 0) (type solid)) (fill yes) (layer "F.Cu"))`);
      for (const l of ls) {
        const shape = l.shape === 'oval' ? 'oval' : l.shape;
        o.push(`\t\t(pad ${q(l.num)} smd ${shape} (at ${mm(l.x)} ${mm(l.y)}${l.rot ? ' ' + n(l.rot) : ''}) (size ${mm(l.w)} ${mm(l.h)})${shape === 'roundrect' ? ` (roundrect_rratio ${n(l.rr)})` : ''} (layers "F.Cu" "F.Mask")${l.net ? ` (net ${q(l.net)})` : ''})`);
      }
      if (m.paddle && ref === biggest) o.push(`\t\t(pad ${q(m.paddle.num)} smd rect (at ${mm(m.paddle.x)} ${mm(m.paddle.y)}${m.paddle.rot ? ' ' + n(m.paddle.rot) : ''}) (size ${mm(m.paddle.w)} ${mm(m.paddle.h)}) (layers "F.Cu" "F.Mask"))`);
      o.push('\t)');
    }

    // Dies, as mechanical footprints: an outline and each pad as a filled Fab rectangle with "number net" over it.
    for (const d of m.dies) {
      const W_ = d.w / 1000, H_ = d.h / 1000, x0 = -W_ / 2, y1 = H_ / 2;
      const [ax, ay] = rot(x0, y1, d.rot), px = d.tx / 1000 - ax, py = d.ty / 1000 - ay;
      o.push(`\t(footprint ${q('wbx_die:' + d.name)}\n\t\t(layer "F.Cu")\n\t\t(at ${n(px)} ${n(py)}${d.rot ? ' ' + n(d.rot) : ''})`,
        `\t\t(property "Reference" ${q(d.id)} (at 0 ${n(-H_ / 2 - 0.3)} 0) (layer "F.Fab") (effects (font (size 0.3 0.3) (thickness 0.05))))`,
        `\t\t(property "Value" ${q(d.name)} (at 0 ${n(H_ / 2 + 0.3)} 0) (layer "F.Fab") (effects (font (size 0.3 0.3) (thickness 0.05))))`,
        hidden('wb_kind', 'die'));
      if (d.thick != null) o.push(hidden('wb_thickness_um', n(d.thick)));
      if (d.tol) o.push(hidden('wb_position_tol_um', n(d.tol)));
      if (d.attach != null) o.push(hidden('wb_attach_um', n(d.attach)));
      if (d.on) { o.push(hidden('wb_sits_on', d.on)); if (d.on === 'custom') o.push(hidden('wb_bottom_um', n(d.customUm))); }
      o.push(`\t\t${BARE}`, `\t\t(fp_rect (start ${n(x0)} ${n(-H_ / 2)}) (end ${n(-x0)} ${n(y1)}) (stroke (width 0.02) (type solid)) (fill no) (layer "F.Fab"))`);
      for (const p of d.pads) {
        const cx = (p.x + p.w / 2) / 1000 + x0, cy = y1 - (p.y + p.h / 2) / 1000, w = p.w / 1000, h = p.h / 1000, size = Math.max(0.01, Math.min(w, h) * 0.22);
        o.push(`\t\t(fp_rect (start ${n(cx - w / 2)} ${n(cy - h / 2)}) (end ${n(cx + w / 2)} ${n(cy + h / 2)}) (stroke (width 0.001) (type solid)) (fill yes) (layer "F.Fab"))`,
          `\t\t(fp_text user ${q(p.num + (p.net ? ' ' + String(p.net).replace(/\s+/g, '_') : ''))} (at ${n(cx)} ${n(cy)}) (layer "F.Fab") (effects (font (size ${n(size)} ${n(size)}) (thickness ${n(size / 8)}))))`);
      }
      o.push('\t)');
    }

    // Wires, as the board form: each says its ends and profile, and draws its run on the Wirebond layer.
    for (const w of m.wires) {
      o.push(`\t(footprint "wbx_wire"\n\t\t(layer "F.Cu")\n\t\t(at ${mm(w.x1)} ${mm(w.y1)})`, hidden('Reference', w.name || 'W' + w.seq), hidden('wb_kind', 'wire'), hidden('wb_from', w.from), hidden('wb_to', w.to));
      if (w.toKind) o.push(hidden('wb_to_kind', w.toKind));
      if (w.profile) o.push(hidden('wb_type', w.profile));
      o.push(hidden('wb_seq', String(w.seq)));
      if (w.net) o.push(hidden('wb_net', w.net));
      o.push(`\t\t${BARE}`, `\t\t(fp_line (start 0 0) (end ${mm(w.x2 - w.x1)} ${mm(w.y2 - w.y1)}) ${stroke(w.d || 25)} (layer "User.9"))`, '\t)');
    }

    // Fiducials and parts, as the footprints the bench recognises when it writes the board view again.
    for (const f of m.fids) {
      const s = f.shape, cx = s.kind === 'circle' ? s.x : s.x + s.w / 2, cy = s.kind === 'circle' ? s.y : s.y + s.h / 2;
      const pad = s.kind === 'circle' ? `(pad "" smd circle (at 0 0) (size ${mm(2 * s.r)} ${mm(2 * s.r)})` : `(pad "" smd rect (at 0 0) (size ${mm(s.w)} ${mm(s.h)})`;
      o.push(`\t(footprint "wbx:fiducial"\n\t\t(layer "F.Cu")\n\t\t(at ${mm(cx)} ${mm(cy)})`, `\t\t(property "Reference" ${q(f.name)} (at 0 -1 0) (layer "F.Fab") (hide yes) (effects (font (size 0.5 0.5) (thickness 0.08))))`,
        hidden('wb_kind', 'fiducial'), hidden('wb_role', f.role));
      if (f.datum) o.push(hidden('wb_datum', f.datum));
      o.push(`\t\t${BARE}`, `\t\t${pad} (layers "F.Cu" "F.Mask")${f.role === 'align' ? ' (property pad_prop_fiducial_glob)' : ''})`, '\t)');
    }
    for (const p of m.parts) {
      const b = p.box, cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      o.push(`\t(footprint "wbx:part"\n\t\t(layer "F.Cu")\n\t\t(at ${mm(cx)} ${mm(cy)})`, `\t\t(property "Reference" ${q(p.name)} (at 0 0 0) (layer "F.Fab") (effects (font (size 0.3 0.3) (thickness 0.05))))`,
        `\t\t(property "Value" ${q(p.value || p.name)} (at 0 0 0) (layer "F.Fab") (hide yes) (effects (font (size 0.3 0.3) (thickness 0.05))))`, hidden('wb_kind', 'part'));
      if (p.height) o.push(hidden('wb_height_um', n(p.height)));
      o.push(`\t\t(attr smd)`, `\t\t(fp_rect (start ${mm(-b.w / 2)} ${mm(-b.h / 2)}) (end ${mm(b.w / 2)} ${mm(b.h / 2)}) (stroke (width 0.05) (type solid)) (fill no) (layer "F.CrtYd"))`, '\t)');
    }

    // The picture, on its own layers. Without one, the outline alone becomes the board edge.
    const pic = m.picture || {};
    for (const [layer, L] of Object.entries(pic)) {
      for (const f of L.fills) o.push(`\t(gr_poly (pts ${chunk(f.pts)}) (stroke (width 0) (type solid)) (fill yes) (layer ${q(layer)}))`);
      for (const s of L.strokes) {
        if (s.closed) o.push(`\t(gr_poly (pts ${chunk(s.pts)}) ${stroke(s.w)} (fill no) (layer ${q(layer)}))`);
        else for (let i = 2; i < s.pts.length; i += 2) o.push(`\t(gr_line (start ${mm(s.pts[i - 2])} ${mm(s.pts[i - 1])}) (end ${mm(s.pts[i])} ${mm(s.pts[i + 1])}) ${stroke(s.w)} (layer ${q(layer)}))`);
      }
      for (const [x, y, r] of L.circles) o.push(`\t(gr_circle (center ${mm(x)} ${mm(y)}) (end ${mm(x + r)} ${mm(y)}) (stroke (width 0) (type solid)) (fill yes) (layer ${q(layer)}))`);
      for (const t of L.texts) o.push(`\t(gr_text ${q(t.s)} (at ${mm(t.x)} ${mm(t.y)}${t.rot ? ' ' + n(t.rot) : ''}) (layer ${q(layer)}) (effects (font (size ${mm(t.size)} ${mm(t.size)}) (thickness ${mm(t.size / 7)}))))`);
    }
    if (!pic['Edge.Cuts'] && m.outline) {
      const b = m.outline;
      o.push(`\t(gr_rect (start ${mm(b.x)} ${mm(b.y)}) (end ${mm(b.x + b.w)} ${mm(b.y + b.h)}) (stroke (width 0.05) (type solid)) (fill no) (layer "Edge.Cuts"))`);
    }
    o.push('\t(embedded_fonts no)', ')');
    return o.join('\n') + '\n';
  }
  function chunk(pts) { const o = []; for (let i = 0; i < pts.length; i += 2) o.push(xy(pts[i], pts[i + 1])); return o.join(' '); }

  // Does this text look like a wirebond.svg, before anything is changed?
  const looks = text => /xmlns:wb\s*=\s*["']urn:wbx:/.test(String(text).slice(0, 4000));

  W.WBX = W.WBX || {};
  W.WBX.wbsvg = { parse, toKicad, looks };
})(window);
