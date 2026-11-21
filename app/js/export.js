/* Writers for KiCad: die footprint, die kit, assembled board with 3D wires, bondlist.
   Follows the decided model: the die is mechanical with no copper, nets stay on the lands, one footprint per wire,
   and the type library lives in the board as fields on a footprint.
   Every file written here says where it came from: Wire Bond Bench, part of wirebond.svg,
   https://github.com/anfroholic/wirebond.svg. (c) Andrew Wingate, MIT licence. */
(function (W) {
  'use strict';
  const M = W.WBSVG.model, BR = W.WBSVG.brand;

  const q = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
  const n = v => { const s = (+v).toFixed(6).replace(/0+$/, '').replace(/\.$/, ''); return s === '-0' || s === '' ? '0' : s; };
  function fnv(s, seed) { let h = seed >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  // Same names give the same uuids, so re-exporting doesn't churn a board in version control.
  function uuid(key) {
    const hex = [0x811c9dc5, 0x1234567, 0x9e3779b9, 0xdeadbeef].map(s => fnv('wbx/' + key, s).toString(16).padStart(8, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }
  const safe = s => String(s).replace(/[^\w.+-]+/g, '_') || 'die';
  const uu = k => `(uuid ${q(uuid(k))})`;
  /* Provenance, carried by every footprint written here: a hidden field KiCad lists in the footprint's properties and a line
     in its description. Nothing visible is drawn on the board. */
  const madeWith = (owner, layer) => hiddenProp(owner, 'wb_made_with', BR.credit, layer);
  const descrOf = s => `(descr ${q((s ? s + ' ' : '') + BR.credit + '.')})`;
  const hiddenProp = (owner, key, val, layer) => `\t\t(property ${q(key)} ${q(val)} (at 0 0 0) (layer ${q(layer)}) (hide yes) ${uu(owner + '/p/' + key)} (effects (font (size 0.1 0.1) (thickness 0.01))))`;

  /* KiCad sizes a reference image at 300 pixels per inch times its scale. */
  function shrink(canvas, maxPx) {
    const s = Math.min(1, maxPx / Math.max(canvas.width, canvas.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(canvas.width * s)); c.height = Math.max(1, Math.round(canvas.height * s));
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    return c;
  }
  function artForKicad(canvas, maxPx) {
    if (!canvas) return null;
    const c = shrink(canvas, maxPx);
    const b64 = c.toDataURL('image/png').split(',')[1];
    const lines = [];
    for (let i = 0; i < b64.length; i += 76) lines.push(q(b64.slice(i, i + 76)));
    return { lines, px: c.width };
  }

  function dieItems(die, key, angle, art, origin, courtyard = true) {
    const o = [];
    const W_ = die.x1 - die.x0, H_ = die.y1 - die.y0;
    o.push(`\t\t(fp_rect (start ${n(die.x0)} ${n(die.y0)}) (end ${n(die.x1)} ${n(die.y1)}) (stroke (width 0.02) (type solid)) (fill no) (layer "F.Fab") ${uu(key + '/o')})`);
    if (courtyard) o.push(`\t\t(fp_rect (start ${n(die.x0)} ${n(die.y0)}) (end ${n(die.x1)} ${n(die.y1)}) (stroke (width 0.02) (type solid)) (fill no) (layer "F.CrtYd") ${uu(key + '/c')})`);
    for (const p of die.pads) {
      const x0 = p.x - p.w / 2, y0 = p.y - p.h / 2;
      o.push(`\t\t(fp_rect (start ${n(x0)} ${n(y0)}) (end ${n(x0 + p.w)} ${n(y0 + p.h)}) (stroke (width 0.001) (type solid)) (fill yes) (layer "F.Fab") ${uu(key + '/p' + p.num)})`);
      // KiCad blanks the number of a pad with no copper when it loads one, so numbers and names live in Fab text over the pad.
      const size = Math.max(0.01, Math.min(p.w, p.h) * 0.22);
      o.push(`\t\t(fp_text user ${q(p.num + (p.net ? ' ' + String(p.net).replace(/\s+/g, '_') : ''))} (at ${n(p.x)} ${n(p.y)} ${n(angle)}) (layer "F.Fab") ${uu(key + '/t' + p.num)} (effects (font (size ${n(size)} ${n(size)}) (thickness ${n(size / 8)}))))`);
    }
    if (art) {
      const scale = W_ / (art.px * 25.4 / 300);
      // Unlike every other footprint item, KiCad reads an image's position in board coordinates, not relative to the footprint.
      const ax = (die.x0 + die.x1) / 2 + (origin ? origin[0] : 0), ay = (die.y0 + die.y1) / 2 + (origin ? origin[1] : 0);
      o.push(`\t\t(image (at ${n(ax)} ${n(ay)}) (layer "F.Fab") (scale ${scale.toFixed(6)}) ${uu(key + '/img')}\n\t\t\t(data ${art.lines.join('\n\t\t\t\t')})\n\t\t)`);
    }
    return o;
  }

  function dieFootprintFile(die, opts) {
    opts = opts || {};
    const name = safe(opts.name || die.name), art = opts.art === false ? null : artForKicad(die.artCanvas, opts.artPx || 1024);
    const h = die.y1 - die.y0;
    const descr = die.source === 'gds' ? `Die stand-in from ${die.fileName || 'a GDS'}. Mechanical only, no copper: bond lands live on the board.` : `Die footprint, rewritten as mechanical only.`;
    const out = [`(footprint ${q(name)}`, `\t(version 20260206)`, `\t(generator ${q(BR.generator)})`, `\t(generator_version "10.0")`, `\t(layer "F.Cu")`, `\t${descrOf(descr)}`, `\t(tags ${q('bare_die wire_bond ' + BR.name)})`,
      `\t(property "Reference" "D" (at 0 ${n(die.y0 - 0.3)} 0) (layer "F.Fab") ${uu(name + '/r')} (effects (font (size 0.3 0.3) (thickness 0.05))))`,
      `\t(property "Value" ${q(name)} (at 0 ${n(die.y1 + 0.3)} 0) (layer "F.Fab") ${uu(name + '/v')} (effects (font (size 0.3 0.3) (thickness 0.05))))`,
      hiddenProp(name, 'wb_kind', 'die', 'F.Fab'),
      madeWith(name, 'F.Fab'),
      `\t(attr board_only exclude_from_pos_files exclude_from_bom)`,
      ...dieItems(die, name, 0, art)];
    // A library footprint carries its own model: the file is embedded in it, data and all.
    if (opts.step) {
      const S3 = W.WBSVG.step, e = S3.embed(name + '.step', opts.step);
      out.push(`\t(embedded_files\n${S3.fileEntry(e, 'model', '\t\t')}\n\t)`, `\t(model "kicad-embed://${e.name}" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))`);
    }
    out.push(')');
    return out.join('\n') + '\n';
  }

  /* ---- 3D: one STEP ----
     The die, its attach layer, its pads and every wire go in one STEP, as named, coloured solids, in millimetres with z up
     from the board's top. KiCad shows it, its own STEP export passes it on, and mechanical CAD opens it. Change anything
     and the export writes it again. */
  const BOND_STEP = 'wbsvg_bond.step';   // its name inside a board, so a later export finds and replaces it
  const ATTACH_RGB = [0.35, 0.35, 0.37], DIE_RGB = [0.20, 0.22, 0.27], PAD_RGB = [0.86, 0.86, 0.80];
  const hexToRgb = hex => { const m = String(hex).match(/^#(..)(..)(..)$/); return m ? [m[1], m[2], m[3]].map(v => parseInt(v, 16) / 255) : [0.9, 0.72, 0.25]; };
  // A block standing on a four-cornered outline in the model's plane, from z0 to z1 in mm.
  function prism(w, name, rgb, quad, z0, z1) {
    const area = quad.reduce((s, p, i) => { const q = quad[(i + 1) % 4]; return s + p[0] * q[1] - q[0] * p[1]; }, 0);
    const ccw = area > 0 ? quad : quad.slice().reverse();
    w.hexa(name, rgb, [...ccw.map(p => [p[0], p[1], z0]), ...ccw.map(p => [p[0], p[1], z1])]);
  }
  /* ---- the artwork on the 3D die ----
     STEP has no pictures, so the die's top face is split into faces of two colours. The commonest colour in the picture is
     the die's, the commonest one clearly different from it is the accent, and every pixel that isn't the die's colour
     counts as accent. The picture is read at up to ART_PX on its long side, and coarser when its outlines would need more
     than ART_POINTS points, which keeps the model quick for KiCad to load. Both are worked out once per picture. */
  const ART_PX = 1024, ART_POINTS = 20000;
  const toHex = c => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const colourCache = new WeakMap(), outlineCache = new WeakMap();
  /* The picture's pixels, a band of rows at a time, so a big picture is never all copied at once. Each band is copied to a
     canvas of its own and read there: reading the picture itself makes the browser move it off the GPU, which changes how
     it is shrunk for the footprint image and the .wb.svg, and so what they hold. */
  function eachBand(canvas, fn) {
    const band = 256, tmp = document.createElement('canvas');
    tmp.width = canvas.width; tmp.height = Math.min(band, canvas.height);
    const ctx = tmp.getContext('2d', { willReadFrequently: true });
    for (let r0 = 0; r0 < canvas.height; r0 += band) {
      const rows = Math.min(band, canvas.height - r0);
      ctx.clearRect(0, 0, tmp.width, tmp.height);
      ctx.drawImage(canvas, 0, r0, canvas.width, rows, 0, 0, canvas.width, rows);
      fn(ctx.getImageData(0, 0, canvas.width, rows).data, r0, rows);
    }
  }
  // The two colours, as 0 to 255, or null for a picture of one colour.
  function artColours(canvas) {
    if (!canvas || !canvas.width || !canvas.height) return null;
    if (colourCache.has(canvas)) return colourCache.get(canvas);
    const step = Math.max(1, Math.ceil(Math.sqrt(canvas.width * canvas.height / 1e6))), count = new Map();
    eachBand(canvas, (d, r0, rows) => {
      for (let r = (step - r0 % step) % step; r < rows; r += step) for (let c = 0; c < canvas.width; c += step) {
        const i = (r * canvas.width + c) * 4, k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
        count.set(k, (count.get(k) || 0) + 1);
      }
    });
    const rgb = k => [k >> 16, (k >> 8) & 255, k & 255];
    const order = [...count.entries()].sort((a, b) => b[1] - a[1]).map(e => rgb(e[0]));
    const base = order[0], accent = order.find(c => dist2(c, base) > 40 * 40);
    const out = accent ? { base, accent } : null;
    colourCache.set(canvas, out);
    return out;
  }
  // The picture's outlines in two colours: { cols, out, f } with f picture pixels to an outline pixel, or { tooDetailed }.
  function artOutlines(canvas) {
    if (outlineCache.has(canvas)) return outlineCache.get(canvas);
    const cols = artColours(canvas);
    let res = null;
    if (cols) {
      // Accent coverage on a grid of f by f pixel cells. A pixel is base if it is near the base colour, a quarter of the way to the accent.
      const PW = canvas.width, PH = canvas.height, f0 = Math.max(1, Math.ceil(Math.max(PW, PH) / ART_PX));
      const cw = Math.ceil(PW / f0), ch = Math.ceil(PH / f0), hits = new Uint32Array(cw * ch), total = new Uint32Array(cw * ch);
      const near = Math.max(12 * 12, dist2(cols.base, cols.accent) / 16), b = cols.base;
      eachBand(canvas, (d, r0, rows) => {
        for (let r = 0; r < rows; r++) {
          const row = ((r0 + r) / f0 | 0) * cw;
          for (let c = 0, i = r * PW * 4; c < PW; c++, i += 4) {
            const k = row + (c / f0 | 0);
            total[k]++;
            if ((d[i] - b[0]) ** 2 + (d[i + 1] - b[1]) ** 2 + (d[i + 2] - b[2]) ** 2 > near) hits[k]++;
          }
        }
      });
      // A cell of k by k grid cells is accent when at least half its pixels are.
      for (let k = 1; k <= 4 && !res; k *= 2) {
        const w = Math.ceil(cw / k), h = Math.ceil(ch / k), mask = new Uint8Array(w * h);
        for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
          let a = 0, t = 0;
          for (let y = r * k; y < Math.min(ch, r * k + k); y++) for (let x = c * k; x < Math.min(cw, c * k + k); x++) { a += hits[y * cw + x]; t += total[y * cw + x]; }
          mask[r * w + c] = 2 * a >= t && t > 0 ? 1 : 0;
        }
        const out = W.WBSVG.step.outlines(mask, w, h);
        if (out.verts <= ART_POINTS) res = { cols, out, f: f0 * k };
      }
      if (!res) res = { cols, tooDetailed: true };
    }
    outlineCache.set(canvas, res);
    return res;
  }
  /* What the 3D die gets from its picture under the die's 3D settings ({ on, base, accent }, colours as #rrggbb or empty
     for the picture's own): null for a plain die, or the outlines and two colours as 0 to 1. */
  function dieArt(die, opt) {
    if (!die.artCanvas || (opt && opt.on === false)) return null;
    const a = artOutlines(die.artCanvas);
    if (!a || a.tooDetailed) return a;
    const pick = (v, auto) => /^#[0-9a-f]{6}$/i.test(v || '') ? hexToRgb(v) : auto.map(x => x / 255);
    return { out: a.out, f: a.f, PW: die.artCanvas.width, PH: die.artCanvas.height, base: pick(opt && opt.base, a.cols.base), accent: pick(opt && opt.accent, a.cols.accent) };
  }
  // The colours the 3D die would take from a picture, as #rrggbb, for the panel.
  function artAutoColours(canvas) {
    const c = artColours(canvas);
    return c && { base: toHex(c.base), accent: toHex(c.accent) };
  }

  /* A die as solids. Heights are um above the board, base being where its attach layer starts. `to` takes a point in the
     die's own millimetres, y down as in its footprint, to the model's x and y. art is dieArt's, or null for a plain die. */
  function dieSolids(w, label, die, thick, attach, base, to, art) {
    const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(p => to(p[0], p[1]));
    const z = um => um / 1000, zTop = base + attach + thick;
    if (attach > 0) prism(w, label + ' attach', ATTACH_RGB, rect(die.x0 - 0.01, die.y0 - 0.01, die.x1 + 0.01, die.y1 + 0.01), z(base), z(base + attach));
    if (art && art.out) {
      // The picture covers the die's outline. An outline point is a pixel corner, f picture pixels to one.
      const sx = (die.x1 - die.x0) / art.PW, sy = (die.y1 - die.y0) / art.PH;
      const at = p => to(die.x0 + Math.min(p[0] * art.f, art.PW) * sx, die.y0 + Math.min(p[1] * art.f, art.PH) * sy);
      let quad = rect(die.x0, die.y0, die.x1, die.y1), loops = art.out.loops.map(L => L.map(at));
      // Seen from above, the outline and each accent area must run anticlockwise. Going from y down to y up turns them round;
      // if `to` doesn't, turn them here.
      if (quad.reduce((s, p, i) => { const q = quad[(i + 1) % 4]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) < 0) { quad = quad.reverse(); loops = loops.map(L => L.reverse()); }
      w.painted(label + ' die', art.base, art.accent, quad, z(base + attach), z(zTop), loops, art.out.faces);
    } else prism(w, label + ' die', DIE_RGB, rect(die.x0, die.y0, die.x1, die.y1), z(base + attach), z(zTop));
    // Pads stand a micrometre proud, and start just below the top, so no two faces lie in one plane.
    for (const p of die.pads) prism(w, `${label} pad ${p.num}`, PAD_RGB, rect(p.x - p.w / 2, p.y - p.h / 2, p.x + p.w / 2, p.y + p.h / 2), z(zTop - 0.5), z(zTop + 1));
  }
  // A die on its own, for the die kit: its footprint's origin, sitting on the board. art3d is the die's 3D settings.
  function dieStep(die, thick, attach, name, art3d) {
    const w = W.WBSVG.step.writer();
    const art = dieArt(die, art3d);
    dieSolids(w, name, die, thick, attach, 0, (x, y) => [x, -y], art && art.out ? art : null);
    return w.text(name);
  }

  /* ---- schematic symbol ---- */
  function symbolFile(die) {
    const name = safe(die.name), P = 2.54;
    const groups = { L: [], B: [], R: [], T: [] };
    die.pads.forEach(p => groups[p.side].push(p));
    const pin = p => (p.net || 'P' + p.num).replace(/\s+/g, '_');
    const longest = Math.max(1, ...die.pads.map(p => pin(p).length));
    const half = c => Math.round((c * P / 2 + longest * 0.85 + 2.54) / 2.54) * 2.54;
    const hw = half(Math.max(groups.B.length, groups.T.length)), hh = half(Math.max(groups.L.length, groups.R.length));
    const pins = [];
    for (const k of 'LBRT') {
      const g = groups[k], N = g.length;
      g.forEach((p, j) => {
        const off = Math.round((j - (N - 1) / 2) * 2) / 2 * P;
        const [x, y, a] = k === 'L' ? [-hw - 2.54, -off, 0] : k === 'B' ? [off, -hh - 2.54, 90] : k === 'R' ? [hw + 2.54, off, 180] : [-off, hh + 2.54, 270];
        const type = /^(D?VDD|D?VSS|GND)$/i.test(pin(p)) ? 'power_in' : 'bidirectional';
        pins.push(`\t\t\t(pin ${type} line (at ${n(x)} ${n(y)} ${a}) (length 2.54) (name ${q(pin(p))} (effects (font (size 1 1)))) (number ${q(p.num)} (effects (font (size 1 1)))))`);
      });
    }
    return `(kicad_symbol_lib
\t(version 20241209)
\t(generator ${q(BR.generator)})
\t(symbol ${q(name)} (pin_names (offset 0.5)) (exclude_from_sim no) (in_bom yes) (on_board yes)
\t\t(property "Reference" "U" (at ${n(-hw)} ${n(hh + 1.5)} 0) (effects (font (size 1.27 1.27)) (justify left)))
\t\t(property "Value" ${q(name)} (at ${n(hw)} ${n(hh + 1.5)} 0) (effects (font (size 1.27 1.27)) (justify right)))
\t\t(property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
\t\t(property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
\t\t(property "Description" ${q(`Bare die ${name}, ${die.pads.length} pads, for wire bonding. ${BR.credit}.`)} (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
\t\t(property "ki_keywords" ${q('bare die wire bond ' + BR.name)} (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
\t\t(symbol ${q(name + '_0_1')} (rectangle (start ${n(-hw)} ${n(hh)}) (end ${n(hw)} ${n(-hh)}) (stroke (width 0.254) (type default)) (fill (type background))))
\t\t(symbol ${q(name + '_1_1')}
${pins.join('\n')}
\t\t)
\t)
)
`;
  }

  /* ---- assembled board ---- */
  // Where each child of the outermost list starts and ends, skipping quoted strings and |base64| data.
  function topLevel(text) {
    const out = [];
    let depth = 0, start = -1;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') { for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++; }
      else if (c === '|') { const j = text.indexOf('|', i + 1); i = j < 0 ? text.length : j; }
      else if (c === '(') { if (++depth === 2) start = i; }
      else if (c === ')' && depth-- === 2) out.push([start, i + 1]);
    }
    return out;
  }
  const LAYER_IDS = { 'User.1': 39, 'User.2': 41, 'User.3': 43, 'User.4': 45, 'User.5': 47, 'User.6': 49, 'User.7': 51, 'User.8': 53, 'User.9': 55 };
  function pickWireLayer(text, board) {
    const usedIn = name => new RegExp('\\(layer\\s+"' + name.replace('.', '\\.') + '"\\)').test(text);
    for (const name of Object.keys(LAYER_IDS)) if (!usedIn(name)) return { name, inTable: board.layers.some(l => l.name === name) };
    return { name: 'User.9', inTable: board.layers.some(l => l.name === 'User.9') };
  }
  const BLANK_LAYERS = [[0, 'F.Cu', 'signal'], [2, 'B.Cu', 'signal'], [9, 'F.Adhes', 'user', 'F.Adhesive'], [11, 'B.Adhes', 'user', 'B.Adhesive'], [13, 'F.Paste', 'user'], [15, 'B.Paste', 'user'], [5, 'F.SilkS', 'user', 'F.Silkscreen'], [7, 'B.SilkS', 'user', 'B.Silkscreen'], [1, 'F.Mask', 'user'], [3, 'B.Mask', 'user'], [17, 'Dwgs.User', 'user', 'User.Drawings'], [19, 'Cmts.User', 'user', 'User.Comments'], [21, 'Eco1.User', 'user', 'User.Eco1'], [23, 'Eco2.User', 'user', 'User.Eco2'], [25, 'Edge.Cuts', 'user'], [27, 'Margin', 'user'], [31, 'F.CrtYd', 'user', 'F.Courtyard'], [29, 'B.CrtYd', 'user', 'B.Courtyard'], [35, 'F.Fab', 'user'], [33, 'B.Fab', 'user']];

  // A .kicad_mod substrate needs a board around it. It sits at (ox, oy) on the sheet with a plain outline.
  function boardFromFootprint(S, ox, oy) {
    const src = S.substrate.text;
    const fp = S.substrate.board.fps[0];
    const body = src.slice(src.indexOf('('), src.lastIndexOf(')'));
    const withAt = body.replace(/\(layer\s+"[^"]*"\)/, m => `${m}\n\t(at ${n(ox)} ${n(oy)})`).replace(/\(version\s+\S+\)\s*/, '').replace(/\(generator\s+"[^"]*"\)\s*/, '').replace(/\(generator_version\s+"[^"]*"\)\s*/, '');
    const X = [], Y = [];
    for (const p of fp.pads) { X.push(p.x - p.w, p.x + p.w); Y.push(p.y - p.h, p.y + p.h); }
    for (const d of M.placedDies(S)) for (const [x, y] of M.dieCorners(d)) { X.push(x); Y.push(y); }
    const x0 = Math.min(...X) - 1, x1 = Math.max(...X) + 1, y0 = Math.min(...Y) - 1, y1 = Math.max(...Y) + 1;
    const rows = BLANK_LAYERS.map(r => `\t\t(${r[0]} ${q(r[1])} ${r[2]}${r[3] ? ' ' + q(r[3]) : ''})`);
    const text = `(kicad_pcb\n\t(version 20260206)\n\t(generator ${q(BR.generator)})\n\t(generator_version "10.0")\n\t(general\n\t\t(thickness 0.8)\n\t\t(legacy_teardrops no)\n\t)\n\t(paper "A4")\n\t(layers\n${rows.join('\n')}\n\t)\n\t(setup\n\t\t(pad_to_mask_clearance 0)\n\t)\n${withAt})\n\t(gr_rect (start ${n(x0 + ox)} ${n(y0 + oy)}) (end ${n(x1 + ox)} ${n(y1 + oy)}) (stroke (width 0.05) (type solid)) (fill no) (layer "Edge.Cuts") ${uu('edge')})\n\t(embedded_fonts no)\n)\n`;
    return text;
  }

  function assemble(S, opts) {
    opts = opts || {};
    const sub = S.substrate, die = S.die, files = {}, notes = [];
    const fromMod = sub.board.kind === 'footprint';
    const ox = fromMod ? 100 : 0, oy = fromMod ? 100 : 0;
    let text = fromMod ? boardFromFootprint(S, ox, oy) : sub.text;
    let removed = 0;
    if (!fromMod) {
      // Regenerating replaces what an earlier run wrote, and a die or wire that came in with the board.
      const gen = sub.board.fps.filter(f => f.wbKind === 'die' || f.wbKind === 'wire' || f.wbKind === 'type_library').sort((a, b) => b.s - a.s);
      for (const f of gen) { text = text.slice(0, f.s).replace(/\s+$/, '') + '\n\t' + text.slice(f.e).replace(/^\s+/, ''); removed++; }
    }
    const layer = pickWireLayer(text, sub.board);
    if (fromMod || !layer.inTable) {
      // KiCad won't load a board whose layer table doesn't start with F.Cu, so a new row goes last
      const table = text.search(/\(layers\b/);
      let depth = 0, end = table;
      for (; end < text.length; end++) { if (text[end] === '(') depth++; else if (text[end] === ')' && --depth === 0) break; }
      text = text.slice(0, end).replace(/\s+$/, '') + `\n\t\t(${LAYER_IDS[layer.name]} ${q(layer.name)} user "Wirebond")\n\t` + text.slice(end);
    }
    const ring = sub.selectedRef || 'L';
    const fps = [], attr = '(attr board_only exclude_from_pos_files exclude_from_bom)';
    // Wires and the type library take no space on the board, so they have no courtyard, and say so: a board whose rules
    // make a missing courtyard an error, as the wafer.space COB boards do, would otherwise flag every wire.
    const bare = '(attr board_only exclude_from_pos_files exclude_from_bom allow_missing_courtyard)';
    /* One footprint per die, named by its reference, which is what the wires call it. The first keeps the keys a single die
       always had, so a one-die board writes the same bytes as before. A die off the board says what it sits on. A die on
       another die takes no board space of its own, so it has no courtyard: the one under it already holds that space. */
    const dies = M.placedDies(S), first = dies[0];
    /* The one STEP holds everything and hangs on the first die's footprint, so it is drawn in that footprint's frame:
       x along the footprint, y up (the footprint's y negated), turned with it. */
    const w3 = W.WBSVG.step.writer();
    const toModel = (bx, by) => { const [x, y] = M.boardToDie(first.place, bx, by); return [x, -y]; };
    const STEP_HERE = '\u0000step\u0000';
    for (const d of dies) {
      const die = d.die, P = d.place, key = d === first ? 'die' : 'die/' + d.id;
      const name = safe(die.name), art = artForKicad(die.artCanvas, opts.artPx || 1024);
      const rotArt = art && Math.abs(P.rot % 360) > 1e-6;
      if (rotArt) notes.push(`The ${dies.length > 1 ? d.id + ' ' : ''}die artwork was left out of the board because the die is rotated. KiCad doesn't turn a footprint's image with it.`);
      const y = die.y0 - 0.3, sup = M.dieSupport(S, d), on = sup ? sup.id : P.on === 'custom' ? 'custom' : 'board';
      const stack = (on === 'board' ? '' : `${hiddenProp(key, 'wb_sits_on', on, 'F.Fab')}\n${hiddenProp(key, 'wb_bottom_um', +M.dieBottom(S, d).toFixed(3), 'F.Fab')}\n`)
        + (M.tolOf(d) ? `${hiddenProp(key, 'wb_position_tol_um', M.tolOf(d), 'F.Fab')}\n` : '');
      fps.push(`\t(footprint ${q(name)}\n\t\t(layer "F.Cu") ${uu(key)} (at ${n(P.x + ox)} ${n(P.y + oy)} ${n(P.rot)})
\t\t${descrOf(`Die ${d.id}, placed and bonded.`)}
\t\t(property "Reference" ${q(d.id)} (at 0 ${n(y)} ${n(P.rot)}) (layer "F.Fab") ${uu(key + '/r')} (effects (font (size 0.3 0.3) (thickness 0.05))))
\t\t(property "Value" ${q(name)} (at 0 ${n(die.y1 + 0.3)} ${n(P.rot)}) (layer "F.Fab") ${uu(key + '/v')} (effects (font (size 0.3 0.3) (thickness 0.05))))
${hiddenProp(key, 'wb_kind', 'die', 'F.Fab')}
${hiddenProp(key, 'wb_thickness_um', P.thick, 'F.Fab')}
${hiddenProp(key, 'wb_attach_um', P.attach, 'F.Fab')}
${madeWith(key, 'F.Fab')}
${stack}\t\t${sup ? bare : attr}
${dieItems(die, key, P.rot, rotArt ? null : art, [P.x + ox, P.y + oy], !sup).join('\n')}${d === first ? '\n' + STEP_HERE : ''}
\t)`);
      const base = M.dieBase(S, d), art3d = dieArt(die, d.art3d);
      if (art3d && art3d.tooDetailed) notes.push(`The ${dies.length > 1 ? d.id + ' ' : ''}die artwork is too detailed to paint on the 3D die, so that die is plain in the STEP.`);
      dieSolids(w3, d.id, die, P.thick, M.dieBottom(S, d) - base, base, (x, y) => toModel(...M.dieToBoard(P, x, y)), art3d && art3d.out ? art3d : null);
    }
    const rows = [];
    S.wires.forEach((w, i) => {
      const e = M.wireEnds(S, w);
      if (!e) return;
      const prof = M.wireProfile(S, w, e), T = prof.type, wn = 'W' + String(i + 1).padStart(2, '0');
      const ux = (e.b[0] - e.a[0]) / (e.len || 1), uy = (e.b[1] - e.a[1]) / (e.len || 1);
      // The curve runs from the die pad, in um along the span and up. A reverse loop is drawn from the land, so it is
      // mirrored along the span. A generic or undefined wire has no loop to model, so its curve is the shared stand-in
      // path, as a tube of nominal size: something to see, not a wire size.
      const path = prof.curve.map(p => {
        const s = (prof.reverse ? prof.span - p[0] : p[0]) / 1000;
        return [...toModel(e.a[0] + ux * s, e.a[1] + uy * s), p[1] / 1000];
      });
      w3.tube(wn, hexToRgb(T.colour), path, (prof.choice ? M.CHOICE_TUBE_UM : T.d) / 1000);
      // A wire between two die names the far pad as "die.pad" and says so in wb_to_kind, which a wire to a land doesn't carry.
      const net = (e.land ? e.land.net : e.toPad.net) || e.pad.net || '';
      const to = !e.land ? e.toDie.id + '.' + e.toPad.num : String(e.land.id).includes('.') ? e.land.id : `${e.land.ref || ring}.${e.land.id}`;
      const toKind = e.land ? '' : `\n${hiddenProp(wn, 'wb_to_kind', 'die', layer.name)}`;
      const owner = wn;
      fps.push(`\t(footprint "wbsvg_wire"\n\t\t(layer "F.Cu") ${uu(owner)} (at ${n(e.a[0] + ox)} ${n(e.a[1] + oy)})
\t\t${descrOf('Bond wire.')}
\t\t(property "Reference" ${q(wn)} (at 0 -0.1 0) (layer ${q(layer.name)}) (hide yes) ${uu(owner + '/r')} (effects (font (size 0.1 0.1) (thickness 0.01))))
\t\t(property "Value" ${q(T.name)} (at 0 0.1 0) (layer ${q(layer.name)}) (hide yes) ${uu(owner + '/v')} (effects (font (size 0.1 0.1) (thickness 0.01))))
${hiddenProp(owner, 'wb_kind', 'wire', layer.name)}
${hiddenProp(owner, 'wb_from', e.die.id + '.' + e.pad.num, layer.name)}
${hiddenProp(owner, 'wb_to', to, layer.name)}${toKind}
${hiddenProp(owner, 'wb_type', T.name, layer.name)}
${hiddenProp(owner, 'wb_net', net, layer.name)}
${hiddenProp(owner, 'wb_seq', i + 1, layer.name)}
\t\t${bare}
\t\t(fp_line (start 0 0) (end ${n(e.b[0] - e.a[0])} ${n(e.b[1] - e.a[1])}) (stroke (width ${n(T.d / 1000)}) (type ${prof.dashed ? 'dash' : 'solid'})) (layer ${q(layer.name)}) ${uu(owner + '/l')})
\t)`);
      rows.push({ wn, w, e, prof, net, to, seq: i + 1 });
    });
    // Generic and undefined have no spec to list, so each field is plain words, and only when a wire uses that type.
    const usedTypes = S.types.filter(t => !M.isBonderChoice(t));
    const stand = `the 3D model is a ${M.CHOICE_TUBE_UM} um visual stand-in, not a wire size or loop`;
    const choiceFields = [];
    if (rows.some(r => r.prof.generic)) choiceFields.push(hiddenProp('wblib', 'wb_type_' + M.GENERIC, `generic: bonder's choice, chosen on purpose; the wire and loop are picked at the machine; ${stand}`, layer.name));
    if (rows.some(r => r.prof.dashed)) choiceFields.push(hiddenProp('wblib', 'wb_type_' + M.UNDEFINED, `not specified: no wire or loop given; ${stand}`, layer.name));
    fps.push(`\t(footprint "wbsvg_wire_types"\n\t\t(layer "F.Cu") ${uu('wblib')} (at ${n(first.place.x + ox)} ${n(first.place.y + oy)})
\t\t${descrOf('The wire types the bond wires on this board use.')}
\t\t(property "Reference" "WBLIB" (at 0 -0.1 0) (layer ${q(layer.name)}) (hide yes) ${uu('wblib/r')} (effects (font (size 0.1 0.1) (thickness 0.01))))
\t\t(property "Value" "wire types" (at 0 0.1 0) (layer ${q(layer.name)}) (hide yes) ${uu('wblib/v')} (effects (font (size 0.1 0.1) (thickness 0.01))))
${hiddenProp('wblib', 'wb_kind', 'type_library', layer.name)}
${madeWith('wblib', layer.name)}
${usedTypes.map(t => hiddenProp('wblib', 'wb_type_' + t.name, `${t.style} ${t.material} ${t.d} ${t.dir} ${t.moves}`, layer.name)).concat(choiceFields)
  // Which of the substrate's copper marks are fiducials. The marks stay where they are, in its footprint; this only says how each is used.
  .concat((S.marks || []).map(m => hiddenProp('wblib', 'wb_fiducial_' + m.id, m.role, layer.name)))
  // And, once a die has a placement tolerance, which of them are datums B and C.
  .concat(M.anyTol(S) ? M.datumMarks(S).map(m => hiddenProp('wblib', 'wb_datum_' + m.id, m.datum, layer.name)) : []).join('\n')}
\t\t${bare}
\t)`);
    // The STEP goes in the board. Whatever else the board embeds is kept; an earlier export's STEP is replaced.
    const step = w3.text(safe(sub.fileName.replace(/(\.wb)?\.[^.]+$/i, '')) + '_bond'), S3 = W.WBSVG.step, emb = S3.embed(BOND_STEP, step);
    const kept = [];
    for (const [s, e] of topLevel(text).filter(([s]) => /^\(embedded_files\b/.test(text.slice(s, s + 16))).reverse()) {
      const block = text.slice(s, e);
      for (const [fs, fe] of topLevel(block)) { const f = block.slice(fs, fe); if (!f.includes(`(name "${BOND_STEP}")`)) kept.unshift(f); }
      text = text.slice(0, s).replace(/\s+$/, '') + '\n\t' + text.slice(e).replace(/^\s+/, '');
    }
    const k = text.trimEnd().lastIndexOf(')');
    // keep the board's closing embedded_fonts token last, where KiCad writes it, with the embedded files after it
    const ef = text.slice(0, k).search(/\(embedded_fonts\s+\w+\)\s*$/);
    const at = ef >= 0 ? ef : k;
    const model = `${S3.fileRef(emb, 'model', '\t\t')}\n\t\t(model "kicad-embed://${BOND_STEP}" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))`;
    text = text.slice(0, at).replace(/\s+$/, '') + '\n' + fps.join('\n').replace(STEP_HERE, () => model) + '\n\t' + text.slice(at);
    const k2 = text.trimEnd().lastIndexOf(')');
    text = text.slice(0, k2).replace(/\s+$/, '') + `\n\t(embedded_files\n${[...kept.map(f => '\t\t' + f), S3.fileEntry(emb, 'model', '\t\t')].join('\n')}\n\t)\n` + text.slice(k2);
    files['assembly.kicad_pcb'] = text;
    files['bond.step'] = step;
    return { files, notes, rows, layer: layer.name, removed, ox, oy };
  }

  /* With one die, the columns are as they always were. With several, from and to name the die ("D2.7"), and two more
     columns say what the far end is and which die the coordinates are measured from: the first die's centre. */
  function bondlist(S) {
    const dies = M.placedDies(S), many = dies.length > 1;
    const [cx, cy] = M.dieToBoard(dies[0].place, ...M.dieCentre(dies[0].die));
    const out = ['seq,wire,net,from,to,x1_um,y1_um,z1_um,x2_um,y2_um,z2_um,type,length_um,peak_um' + (many ? ',to_kind,origin' : '')];
    const csv = v => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
    S.wires.forEach((w, i) => {
      const e = M.wireEnds(S, w);
      if (!e) return;
      const p = M.wireProfile(S, w, e);
      const X = v => ((v - cx) * 1000).toFixed(3), Y = v => ((cy - v) * 1000).toFixed(3);
      const first = p.reverse ? e.b : e.a, second = p.reverse ? e.a : e.b;
      const from = many ? e.die.id + '.' + e.pad.num : 'die.' + e.pad.num, to = e.land ? e.land.id : e.toDie.id + '.' + e.toPad.num;
      const row = [i + 1, 'W' + String(i + 1).padStart(2, '0'), (e.land ? e.land.net : e.toPad.net) || e.pad.net || '', from, to, X(first[0]), Y(first[1]), p.reverse ? p.zEnd : p.zTop, X(second[0]), Y(second[1]), p.reverse ? p.zTop : p.zEnd, p.type.name, p.span.toFixed(1), p.choice ? '' : p.peak.toFixed(1)];
      if (many) row.push(e.land ? 'land' : 'die', dies[0].id);
      out.push(row.map(csv).join(','));
    });
    return out.join('\r\n') + '\r\n';
  }

  /* ---- wirebond.svg ----
     The drawing SPEC.md describes: one SVG unit is 1 um, y down, and every wb:kind element is drawn. The board is cropped to
     the bond area and shifted so it starts near 0. Each die group flips y, so its pads read as GDS numbers measured from
     the die's lower-left corner. Shapes with no wb:kind (artwork, balls, labels, the side view's loops) are decoration. */
  const SVGNS = 'http://www.w3.org/2000/svg', WBNS = 'urn:wbsvg:0.2', INKNS = 'http://www.inkscape.org/namespaces/inkscape';
  const um = v => n(Math.round(v * 1000) / 1000);
  const xe = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  // Type colours are picked for the app's dark canvas, so the drawing darkens them to read on white.
  const deep = hex => { const m = String(hex).match(/^#(..)(..)(..)$/); return m ? '#' + [m[1], m[2], m[3]].map(v => Math.round(parseInt(v, 16) * 0.72).toString(16).padStart(2, '0')).join('') : '#8a6a1c'; };
  const CHOICE_INK = '#7d8a87';
  /* The wirebond.svg logo, for light backgrounds, ready to nest in a drawing: its view box, size and inner markup. */
  const BRAND_MARK = (() => {
    const src = BR.logoLight, vb = src.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
    const body = src.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title>[\s\S]*?<\/title>/, '').replace(/\s*\n\s*/g, '');
    return { viewBox: vb.join(' '), w: vb[2], h: vb[3], body };
  })();
  // Dublin Core, as Inkscape writes it and shows under Document Properties, Metadata: what the file is and where it came from.
  const svgMetadata = design => `<metadata><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/"><rdf:Description rdf:about="">`
    + `<dc:title>${xe('Wire bond diagram: ' + design)}</dc:title><dc:format>image/svg+xml</dc:format><dc:type>wire bond diagram, ${xe(BR.name)} v0.2</dc:type>`
    + `<dc:description>${xe(BR.credit)}</dc:description><dc:source>${xe(BR.url)}</dc:source><dc:relation>${xe(BR.url + '/blob/main/SPEC.md')}</dc:relation>`
    + `<dc:contributor>${xe(BR.app)}</dc:contributor></rdf:Description></rdf:RDF></metadata>`;

  /* ---- the board around the bond diagram ----
     A board substrate is written twice over. Its facts, the outline, fiducials and front-side parts, go in as data a
     reader can check against. Its front copper, silk and part outlines go in as a picture, which readers ignore. Both
     sit in the board view, in the same board coordinates as everything else. A lone footprint has no board. */
  function boardOf(S) {
    const sub = S.substrate;
    if (!sub || sub.board.kind !== 'board' || !sub.bounds || sub.board.props.wb_board === 'none') return null;
    const [x0, y0, x1, y1] = sub.bounds;
    return { x0, y0, x1, y1, board: sub.board };
  }
  // A footprint's pads as outlines in board mm: circles stay circles, anything else is its turned rectangle.
  function padShape(p) {
    if (p.shape === 'circle' || (p.shape === 'oval' && Math.abs(p.w - p.h) < 1e-9)) return { circle: true, x: p.x, y: p.y, r: p.w / 2 };
    const hw = p.w / 2, hh = p.h / 2, rot = W.WBSVG.kicad.rot;
    return { pts: [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].flatMap(([a, b]) => { const [x, y] = rot(a, b, p.rot); return [p.x + x, p.y + y]; }) };
  }
  const boxOf = pts => { const X = pts.filter((_, i) => i % 2 === 0), Y = pts.filter((_, i) => i % 2 === 1); return [Math.min(...X), Math.min(...Y), Math.max(...X), Math.max(...Y)]; };
  function boardFacts(S, B) {
    const fids = [], parts = [], names = new Set();
    const landRefs = new Set(S.lands.map(l => l.ref));
    const sub = S.substrate, ring = sub.selected >= 0 ? B.board.fps[sub.selected] : null;
    const unique = (want, fall) => { let k = want && !/[*?]|REF/.test(want) && !names.has(want) ? want : null, i = 1; while (!k) { const c = fall + i++; if (!names.has(c)) k = c; } names.add(k); return k; };
    // A footprint whose marks the bond diagram already draws, as copper marks of the substrate, isn't drawn twice.
    const marked = new Set((S.marks || []).map(m => m.fp));
    for (const m of S.marks || []) names.add(m.id);
    const fidFps = new Set();
    for (const f of W.WBSVG.kicad.fiducialFootprints(B.board, fp => fp === ring || fp.layer !== 'F.Cu')) {
      fidFps.add(f.fp);
      if (!marked.has(f.fp)) fids.push({ name: unique(f.fp.ref, 'FID'), role: f.role, datum: f.datum, shape: padShape(f.pad) });
    }
    for (const fp of B.board.fps) {
      if (fp.wbKind === 'die' || fp.wbKind === 'wire' || fp.wbKind === 'type_library' || fp === ring || fp.layer !== 'F.Cu' || fidFps.has(fp)) continue;
      if (fp.wbKind && fp.wbKind !== 'part') continue;
      if (landRefs.has(fp.ref) && !ring) continue;   // the whole board is the substrate, and this footprint is its lands
      const crt = fp.gfx.filter(g => g.layer === 'F.CrtYd' && g.pts && g.pts.length >= 4).flatMap(g => g.pts);
      const pts = crt.length ? crt : fp.pads.flatMap(p => { const s = padShape(p); return s.circle ? [s.x - s.r, s.y - s.r, s.x + s.r, s.y + s.r] : s.pts; });
      if (!pts.length) continue;
      const h = +fp.props.wb_height_um;
      parts.push({ name: unique(fp.ref, 'P'), value: fp.value || fp.name, box: boxOf(pts), height: h > 0 ? h : null, fromCourtyard: !!crt.length });
    }
    return { fids, parts };
  }
  // The front of the board as SVG: one Inkscape layer per board layer, in board µm with the origin at (ox, oy).
  function boardPicture(B, ox, oy, k) {
    const X = v => Math.round(v * 1000 - ox), Y = v => Math.round(v * 1000 - oy);
    const pathOf = (pts, close) => { let s = `M${X(pts[0])} ${Y(pts[1])}`; for (let i = 2; i < pts.length; i += 2) s += `L${X(pts[i])} ${Y(pts[i + 1])}`; return close ? s + 'Z' : s; };
    const L = {};
    const get = name => L[name] || (L[name] = { fill: [], strokes: new Map(), circles: [], texts: [] });
    const add = (name, g) => {
      if (g.kind === 'text') { if (!g.hide && g.s) get(name).texts.push(g); return; }
      if (!g.pts || g.pts.length < 4) return;
      const T = get(name), closed = g.kind === 'poly';
      if (g.circle && g.fill && !g.w) { T.circles.push(g.circle); return; }
      if (closed && g.fill) T.fill.push(pathOf(g.pts, true));
      if (g.w > 0 && !g.zone) { const w = Math.round(g.w * 1000); if (!T.strokes.has(w)) T.strokes.set(w, []); T.strokes.get(w).push(pathOf(g.pts, closed)); }
    };
    const FRONT = ['F.Cu', 'F.SilkS', 'Edge.Cuts'];
    for (const g of B.board.gfx) {
      if (g.kind === 'via') get('F.Cu').circles.push([g.x, g.y, g.d / 2]);
      else if (FRONT.includes(g.layer)) add(g.layer, g);
    }
    const pictured = B.board.props.wb_picture === 'yes';   // opened from a .wb.svg: the picture already holds every pad
    for (const fp of B.board.fps) {
      if (fp.wbKind === 'die' || fp.wbKind === 'wire' || fp.wbKind === 'type_library') continue;
      const front = fp.layer === 'F.Cu';
      if (pictured) continue;
      for (const g of fp.gfx) if (FRONT.includes(g.layer) && (front || g.layer === 'Edge.Cuts')) add(g.layer, g);
      for (const p of fp.pads) {
        if (!p.layers.some(l => l === 'F.Cu' || l === '*.Cu' || l === 'F&B.Cu')) continue;
        const s = padShape(p);
        if (s.circle) get('F.Cu').circles.push([s.x, s.y, s.r]); else get('F.Cu').fill.push(pathOf(s.pts, true));
      }
    }
    const o = [];
    for (const name of FRONT) {
      const T = L[name];
      if (!T) continue;
      const cls = { 'F.Cu': 'bv-cu', 'F.SilkS': 'bv-silk', 'Edge.Cuts': 'bv-edge' }[name];
      o.push(`<g inkscape:groupmode="layer" inkscape:label="${name}" class="${cls}">`);
      if (T.fill.length) o.push(`<path d="${T.fill.join('')}" class="f"/>`);
      for (const [w, ps] of T.strokes) o.push(`<path d="${ps.join('')}" class="s" stroke-width="${Math.max(w, Math.round(0.4 / k))}"/>`);
      for (const [x, y, r] of T.circles) o.push(`<circle cx="${X(x)}" cy="${Y(y)}" r="${Math.round(r * 1000)}" class="f"/>`);
      for (const t of T.texts) {
        const size = Math.round(t.size * 1000), turn = t.rot ? ` transform="rotate(${n(-t.rot)} ${X(t.x)} ${Y(t.y)})"` : '';
        o.push(`<text x="${X(t.x)}" y="${Math.round(t.y * 1000 - oy + size * 0.35)}" font-size="${size}" text-anchor="middle"${turn}>${xe(t.s)}</text>`);
      }
      o.push('</g>');
    }
    return o;
  }

  function wbSvg(S, opts) {
    opts = opts || {};
    const R = W.WBSVG.rules, rot = W.WBSVG.kicad.rot;
    const dies = M.stackOrder(S), first = M.placedDies(S)[0], ring = (S.substrate && S.substrate.selectedRef) || 'L';
    const design = opts.design || (S.substrate ? S.substrate.board.props.wb_design || S.substrate.fileName.replace(/(\.wb)?\.[^.]+$/i, '') : first.die.name);
    const landName = l => String(l.id).includes('.') ? String(l.id) : `${l.ref || ring}.${l.id}`;

    const wires = [];
    S.wires.forEach((w, i) => { const e = M.wireEnds(S, w); if (e) wires.push({ w, e, prof: M.wireProfile(S, w, e), wn: 'W' + String(i + 1).padStart(2, '0'), seq: i + 1 }); });

    // The crop: every die, land, the paddle and both ends of every wire, with a margin.
    const X = [], Y = [];
    const box = (x, y, w, h) => { const r = Math.hypot(w, h) / 2; X.push(x - r, x + r); Y.push(y - r, y + r); };
    for (const d of dies) for (const [x, y] of M.dieCorners(d)) { X.push(x); Y.push(y); }
    for (const l of S.lands) box(l.x, l.y, l.w, l.h);
    if (S.paddle) box(S.paddle.x, S.paddle.y, S.paddle.w, S.paddle.h);
    const marks = S.marks || [], fidMarks = marks.filter(m => m.role !== 'off');
    const tolDies = dies.filter(d => M.tolOf(d)), letters = M.datumLetters(S);
    for (const m of marks) { X.push(m.box[0], m.box[2]); Y.push(m.box[1], m.box[3]); }
    for (const r of wires) { X.push(r.e.a[0], r.e.b[0]); Y.push(r.e.a[1], r.e.b[1]); }
    const span0 = Math.max(Math.max(...X) - Math.min(...X), Math.max(...Y) - Math.min(...Y), 0.5), mg = Math.max(0.2, 0.06 * span0);
    // Every number in the file is measured from the board's top-left corner, so it's a position on the board. With no
    // board, from the crop's corner. The crop sits on a 0.1 mm grid from that origin, so a reopened file crops the same.
    const B = boardOf(S);
    const gx = B ? Math.round(B.x0 * 1e6) / 1000 : 0, gy = B ? Math.round(B.y0 * 1e6) / 1000 : 0;
    const cx0 = gx + Math.floor(((Math.min(...X) - mg) * 1000 - gx) / 100) * 100, cy0 = gy + Math.floor(((Math.min(...Y) - mg) * 1000 - gy) / 100) * 100;
    const PW = gx + Math.ceil(((Math.max(...X) + mg) * 1000 - gx) / 100) * 100 - cx0, PH = gy + Math.ceil(((Math.max(...Y) + mg) * 1000 - gy) / 100) * 100 - cy0;
    const ox = B ? gx : cx0, oy = B ? gy : cy0;
    const KX = cx0 - ox, KY = cy0 - oy;   // the crop's corner in the file
    const px = v => um(v * 1000 - ox), py = v => um(v * 1000 - oy);
    const U = Math.max(PW, PH) / 100;  // one text unit, so the lettering scales with the drawing
    const fs = { h: 2.6 * U, t: 1.8 * U, s: 1.4 * U };

    const o = [];
    const layer = (label, attrs) => `<g inkscape:groupmode="layer" inkscape:label="${xe(label)}"${attrs ? ' ' + attrs : ''}>`;
    let right = KX + PW;  // the widest any text reaches, from an average glyph width, so the view box holds it
    const text = (x, y, cls, s, extra) => {
      if (fs[cls]) right = Math.max(right, x + String(s).length * fs[cls] * 0.56);
      return `<text x="${um(x)}" y="${um(y)}" class="${cls}"${extra ? ' ' + extra : ''}>${xe(s)}</text>`;
    };
    const title = s => `<title>${xe(s)}</title>`;

    o.push(text(KX, KY - 1.4 * U, 'h', `${design}: top view (1 unit = 1 µm, true scale)`));
    o.push(`<rect x="${um(KX)}" y="${um(KY)}" width="${um(PW)}" height="${um(PH)}" class="sub"/>`);

    // substrate: lands and the paddle
    o.push(layer('substrate'));
    if (S.paddle) {
      const p = S.paddle;
      o.push(`<rect x="${px(p.x - p.w / 2)}" y="${py(p.y - p.h / 2)}" width="${um(p.w * 1000)}" height="${um(p.h * 1000)}"${p.rot ? ` transform="rotate(${n(-p.rot)} ${px(p.x)} ${py(p.y)})"` : ''} class="cu paddle">${title('Die paddle ' + (p.ref || '') + ' ' + (p.num || ''))}</rect>`);
    }
    for (const l0 of S.lands) {
      // A land turned a quarter turn is still an upright rectangle, so it's written as one, with its sides swapped: a
      // reader takes a land's x, y, width and height as its extent. Only other angles need a transform.
      const q = ((Math.round(l0.rot || 0) % 180) + 180) % 180, l = q === 90 ? Object.assign({}, l0, { w: l0.h, h: l0.w, rot: 0 }) : q === 0 ? Object.assign({}, l0, { rot: 0 }) : l0;
      const rx = l.shape === 'circle' || l.shape === 'oval' ? Math.min(l.w, l.h) / 2 : l.shape === 'roundrect' ? Math.min(l.w, l.h) * (l.rr || 0.25) : 0;
      o.push(`<rect x="${px(l.x - l.w / 2)}" y="${py(l.y - l.h / 2)}" width="${um(l.w * 1000)}" height="${um(l.h * 1000)}"${rx ? ` rx="${um(rx * 1000)}"` : ''}${l.rot ? ` transform="rotate(${n(-l.rot)} ${px(l.x)} ${py(l.y)})"` : ''} class="cu" wb:kind="land" wb:name="${xe(landName(l))}"${l.net ? ` wb:net="${xe(l.net)}"` : ''}>${title(`${landName(l)}${l.net ? ' net ' + l.net : ', no net'}`)}</rect>`);
    }
    // The substrate's copper marks. One picked as a fiducial is data: a board fiducial drawn as the copper it is, so the
    // bonder finds the board by the layer its lands are on. The rest are copper with no wb:kind, so the drawing is the board's.
    for (const m of marks) {
      const use = m.role !== 'off', what = `${m.shape === 'cross' ? 'a plus' : m.shape === 'dot' ? 'a dot' : m.shape === 'square' ? 'a rectangle' : 'a shape'} on front copper, ${n(+(m.w * 1000).toFixed(1))} × ${n(+(m.h * 1000).toFixed(1))} µm, ${m.from === 'copper' ? 'drawn in' : 'a pad of'} ${m.ref}`;
      let words = use ? `${m.id} fiducial, ${m.role === 'align' ? 'align: a machine may fit to it' : 'orient: a mark for people'}; ${what}` : `${m.id}: copper mark, not a fiducial; ${what}`;
      const dm = use && tolDies.length && m.datum ? m.datum : null;
      const at = use ? `class="cu fid" wb:kind="fiducial" wb:name="${xe(m.id)}" wb:role="${m.role}"${dm ? ` wb:datum="${dm}"` : ''}` : 'class="cu mark"';
      if (dm) words += `; datum ${dm}`;
      o.push(m.circle ? `<circle cx="${px(m.circle[0])}" cy="${py(m.circle[1])}" r="${um(m.circle[2] * 1000)}" ${at}>${title(words)}</circle>`
        : `<path d="M${m.pts.map((v, i) => i % 2 ? '' : px(v) + ',' + py(m.pts[i + 1])).filter(Boolean).join(' L')} Z" ${at}>${title(words)}</path>`);
    }
    o.push('</g>');

    // dies, lowest first, each with its artwork under it
    for (const d of dies) {
      const die = d.die, P = d.place, Wd = (die.x1 - die.x0) * 1000, Hd = (die.y1 - die.y0) * 1000;
      const turn = P.rot % 360 ? ` rotate(${n(-P.rot)})` : '';
      if (die.artCanvas && opts.art !== false) {
        const art = artForKicad(die.artCanvas, opts.artPx || 1024);
        o.push(`<g transform="translate(${px(P.x)} ${py(P.y)})${turn}">${title(die.name + ' artwork')}<image x="${um(die.x0 * 1000)}" y="${um(die.y0 * 1000)}" width="${um(Wd)}" height="${um(Hd)}" preserveAspectRatio="none" href="data:image/png;base64,${art.lines.map(s => s.slice(1, -1)).join('')}"/></g>`);
      }
      const [tx, ty] = rot(die.x0, die.y1, P.rot);
      const info = die.info || {};
      const sup = M.dieSupport(S, d);
      o.push(layer('die ' + d.id, `transform="translate(${px(P.x + tx)} ${py(P.y + ty)})${turn} scale(1 -1)" wb:kind="die" wb:name="${xe(d.id)}"${info.cell ? ` wb:gds-cell="${xe(info.cell)}"` : ''}${info.padLayer ? ` wb:pad-layer="${xe(info.padLayer)}"` : ''}`));
      o.push(`<rect x="0" y="0" width="${um(Wd)}" height="${um(Hd)}" class="die${die.artCanvas && opts.art !== false ? ' art' : ''}" wb:kind="outline">${title(`${d.id}: ${die.name}, ${n(Wd / 1000)} × ${n(Hd / 1000)} mm${sup ? ', on ' + sup.id : ''}`)}</rect>`);
      for (const p of die.pads) {
        o.push(`<rect x="${um((p.x - p.w / 2 - die.x0) * 1000)}" y="${um((die.y1 - p.y - p.h / 2) * 1000)}" width="${um(p.w * 1000)}" height="${um(p.h * 1000)}" class="pad" wb:kind="pad" wb:name="${xe(p.num)}"${p.net ? ` wb:net="${xe(p.net)}"` : ''}>${title(`${d.id} pad ${p.num}${p.net ? ' net ' + p.net : ''}`)}</rect>`);
      }
      o.push('</g>');
    }

    // wires, then the balls and land labels drawn from them
    const ink = T => M.isBonderChoice(T) ? CHOICE_INK : deep(T.colour);
    const widthOf = r => r.prof.choice ? M.CHOICE_TUBE_UM : r.prof.type.d;
    o.push(layer('wires'));
    for (const r of wires) {
      const { e, prof } = r, T = prof.type, net = (e.land ? e.land.net : e.toPad.net) || e.pad.net || '';
      const to = e.land ? landName(e.land) : e.toDie.id + '.' + e.toPad.num;
      const what = prof.choice ? M.typeLabel(T.name) : `${T.material} ${T.d} µm ${T.style}, ${T.name}`;
      o.push(`<line x1="${px(e.a[0])}" y1="${py(e.a[1])}" x2="${px(e.b[0])}" y2="${py(e.b[1])}" stroke-width="${um(widthOf(r))}" stroke="${ink(T)}"${prof.dashed ? ` stroke-dasharray="${um(3 * M.CHOICE_TUBE_UM)} ${um(2 * M.CHOICE_TUBE_UM)}"` : ''} class="w" wb:kind="wire" wb:name="${r.wn}" wb:from="${xe(e.die.id + '.' + e.pad.num)}" wb:to="${xe(to)}"${e.land ? '' : ' wb:to-kind="die"'} wb:profile="${xe(T.name)}" wb:seq="${r.seq}"${net ? ` wb:net="${xe(net)}"` : ''}>${title(`${r.wn}${net ? ' ' + net : ''}: ${e.die.id}.${e.pad.num} to ${to}, ${what}, ${n(e.len)} mm, seq ${r.seq}`)}</line>`);
    }
    o.push('</g>', layer('bonds (derived)'));
    for (const r of wires) {
      if (r.prof.choice) continue;
      const at = r.prof.reverse ? r.e.b : r.e.a;
      o.push(`<circle cx="${px(at[0])}" cy="${py(at[1])}" r="${um(1.3 * r.prof.type.d)}" fill="${ink(r.prof.type)}"/>`);
    }
    o.push('</g>', layer('labels (derived)'));
    for (const l of S.lands) {
      if (!l.net) continue;
      const size = Math.min(1.2 * U, Math.min(l.w, l.h) * 1000 * 0.45);
      o.push(`<text x="${px(l.x)}" y="${um(l.y * 1000 - oy + size * 0.35)}" class="lab" font-size="${um(size)}" text-anchor="middle">${xe(l.net)}</text>`);
    }
    // A ring round each fiducial and its name, so the eye finds them as the camera does. The name goes on the side away from the lands.
    const midX = S.lands.length ? S.lands.reduce((a, l) => a + l.x, 0) / S.lands.length : 0;
    for (const m of fidMarks) {
      const r = Math.max(m.w, m.h) * 1000 * 0.8, size = Math.min(1.2 * U, Math.max(r, 0.6 * U)), out = m.cx >= midX ? 1 : -1;
      o.push(`<circle cx="${px(m.cx)}" cy="${py(m.cy)}" r="${um(r)}" class="fidring" stroke-width="${um(0.12 * U)}"/>`);
      o.push(`<text x="${um(m.cx * 1000 - ox + out * (r + 0.3 * U))}" y="${um(m.cy * 1000 - oy + size * 0.35)}" class="fidlab" font-size="${um(size)}"${out < 0 ? ' text-anchor="end"' : ''}>${xe(m.id.slice(m.ref.length + 1))} ${m.role}</text>`);
    }
    o.push('</g>');

    /* Placement tolerance (draft). For each die that has one, one group holds it: its wb: attributes are the data, and the
       tolerance indicator drawn inside it is the same rule for people, both written from the same numbers here. The zone
       circles and the datum flags are drawn from it too, as decoration with no wb:kind. See SPEC.md. */
    const gsw = g => `stroke-width="${um(0.08 * g)}"`;
    // A datum flag: a filled triangle on the feature at x, y, then a boxed letter along ux, uy. g sets its size.
    const datumFlag = (k, x, y, ux, uy, g) => {
      const qx = -uy, qy = ux, bx = x + ux * 2.4 * g, by = y + uy * 2.4 * g;
      return `<path d="M${um(x + 0.6 * g * qx)} ${um(y + 0.6 * g * qy)} L${um(x - 0.6 * g * qx)} ${um(y - 0.6 * g * qy)} L${um(x + 0.8 * g * ux)} ${um(y + 0.8 * g * uy)} Z" class="gdf"/>`
        + `<line x1="${um(x + 0.8 * g * ux)}" y1="${um(y + 0.8 * g * uy)}" x2="${um(x + 1.6 * g * ux)}" y2="${um(y + 1.6 * g * uy)}" class="gd" ${gsw(g)}/>`
        + `<rect x="${um(bx - 0.8 * g)}" y="${um(by - 0.8 * g)}" width="${um(1.6 * g)}" height="${um(1.6 * g)}" class="gdb" ${gsw(g)}/>`
        + `<text x="${um(bx)}" y="${um(by + 0.37 * g)}" font-size="${um(1.05 * g)}" text-anchor="middle" class="gdt">${k}</text>`;
    };
    if (tolDies.length) {
      o.push(layer('placement tolerance'));
      const ks = letters.split(' ');
      for (const d of tolDies) {
        const t = M.tolOf(d), P = M.tolPads(S, d), die = d.die;
        const at = (x, y) => { const [a, b] = M.dieToBoard(d.place, x, y); return [a * 1000 - ox, b * 1000 - oy]; };
        for (const p of P) { const [x, y] = at(p.x, p.y); o.push(`<circle cx="${um(x)}" cy="${um(y)}" r="${um(t / 2)}" class="zone" stroke-width="${um(Math.max(1, t / 25))}"/>`); }
        // The indicator, sized to the die: the symbol, the diameter and CZ, then a box per datum. It sits clear of the die and
        // its wires, off their top-left corner, as a drawing places one, and inside the crop.
        const g = Math.min(U, Math.min(die.x1 - die.x0, die.y1 - die.y0) * 1000 / 18), G = 1.2 * g, clr = M.tolClear(S, d);
        const label = `⌀${n(t)} CZ`, H = 1.8 * g, xs = [0, 2.2 * g, 3 * g + 0.62 * g * label.length];
        for (const k of ks) xs.push(xs[xs.length - 1] + 1.6 * g);
        const fw = xs[xs.length - 1], fx = Math.max(clr[0] * 1000 - ox - G - fw, KX + 0.5 * g), fy = Math.max(clr[1] * 1000 - oy - G - H, KY + 1.6 * g);
        const X = xs.map(v => fx + v), cy = fy + H / 2, sx = (X[0] + X[1]) / 2, sx0 = X[X.length - 1], sx1 = sx0 + G;
        const words = `Position, diameter ${n(t)} µm, combined zone (CZ), datums ${ks.join(' | ')}: the centre of each of the ${P.length} bonded pads of ${d.id} lies in a ${n(t)} µm circle around its nominal place, and the circles move together`;
        o.push(`<g wb:kind="tolerance" wb:applies-to="${xe(d.id)}" wb:char="position" wb:tol="${n(t)}" wb:modifier="CZ" wb:datums="${letters}">${title(words)}`);
        o.push(`<rect x="${um(fx)}" y="${um(fy)}" width="${um(X[X.length - 1] - fx)}" height="${um(H)}" class="gdb" ${gsw(g)}/>`);
        for (const x of X.slice(1, -1)) o.push(`<line x1="${um(x)}" y1="${um(fy)}" x2="${um(x)}" y2="${um(fy + H)}" class="gd" ${gsw(g)}/>`);
        o.push(`<circle cx="${um(sx)}" cy="${um(cy)}" r="${um(0.5 * g)}" class="gd" ${gsw(g)}/><path d="M${um(sx - 0.8 * g)} ${um(cy)} H${um(sx + 0.8 * g)} M${um(sx)} ${um(cy - 0.8 * g)} V${um(cy + 0.8 * g)}" class="gd" ${gsw(g)}/>`);
        [label, ...ks].forEach((s, i) => o.push(`<text x="${um((X[i + 1] + X[i + 2]) / 2)}" y="${um(cy + 0.37 * g)}" font-size="${um(1.05 * g)}" text-anchor="middle" class="gdt">${xe(s)}</text>`));
        o.push(`<text x="${um(fx)}" y="${um(fy - 0.4 * g)}" font-size="${um(1.05 * g)}" class="gdt">${P.length}×</text>`);
        // The leader: a short shoulder from the indicator's right end, then straight to the edge of the bonded pad nearest it,
        // with its arrow on the pad.
        const near = P.map(p => ({ p, c: at(p.x, p.y) })).sort((a, b) => Math.hypot(a.c[0] - sx1, a.c[1] - cy) - Math.hypot(b.c[0] - sx1, b.c[1] - cy))[0];
        const [px_, py_] = near.c, L = Math.hypot(px_ - sx1, py_ - cy) || 1, ux = (px_ - sx1) / L, uy = (py_ - cy) / L;
        const quarter = Math.round(((d.place.rot % 180) + 180) % 180) === 90, hw = (quarter ? near.p.h : near.p.w) * 500, hh = (quarter ? near.p.w : near.p.h) * 500;
        const e = Math.min(ux ? hw / Math.abs(ux) : 1e9, uy ? hh / Math.abs(uy) : 1e9), ex = px_ - ux * e, ey = py_ - uy * e, a = 0.8 * g, w = 0.28 * g;
        o.push(`<polyline points="${um(sx0)},${um(cy)} ${um(sx1)},${um(cy)} ${um(ex - ux * a * 0.9)},${um(ey - uy * a * 0.9)}" class="gd" ${gsw(g)}/>`);
        o.push(`<path d="M${um(ex)} ${um(ey)} L${um(ex - ux * a - uy * w)} ${um(ey - uy * a + ux * w)} L${um(ex - ux * a + uy * w)} ${um(ey - uy * a - ux * w)} Z" class="gdf"/>`);
        o.push('</g>');
      }
      // B and C, on their fiducials, above each one.
      for (const m of M.datumMarks(S)) o.push(datumFlag(m.datum, m.cx * 1000 - ox, m.box[1] * 1000 - oy, 0, -1, U));
      o.push('</g>');
    }

    // Side view: z up is -y. Layers are true thickness; the loops are each wire seen from the front, as decoration.
    const sub = S.substrate && S.substrate.text && S.substrate.text.match(/\(general\s*\(thickness\s+([\d.]+)\)/);
    const subT = sub ? +sub[1] * 1000 : 800;  // what boardFromFootprint gives a footprint substrate
    const glob = R.on(S, 'globTop') ? +R.value(S, 'globTop') : 0;
    const peak = Math.max(0, ...dies.map(d => M.dieTop(S, d)), ...wires.map(r => r.prof.peak), glob);
    const Y0 = KY + PH + 6 * U + peak;
    o.push(text(KX, KY + PH + 4 * U, 'h', 'Side view, looking along +y (true scale, z up)'));
    o.push(layer('stack', `transform="translate(0 ${um(Y0)})" wb:kind="stack"`));
    const lay = (name, role, x0, x1, z, t, extra, words) => `<rect x="${um(x0)}" y="${um(-(z + t))}" width="${um(x1 - x0)}" height="${um(t)}" class="L-${role}" wb:kind="layer" wb:name="${xe(name)}" wb:role="${role}"${extra || ''}>${title(words)}</rect>`;
    const layers = [{ name: 'SUB', role: 'substrate', z: -subT, t: subT, words: `Substrate, ${n(subT)} µm${sub ? '' : ' assumed'}` }];
    // With a placement tolerance, the substrate's top face is datum A, flagged near its left end.
    o.push(lay('SUB', 'substrate', KX, KX + PW, -subT, subT, tolDies.length ? ' wb:datum="A"' : '', layers[0].words + (tolDies.length ? '; its top face is datum A' : '')));
    if (tolDies.length) o.push(datumFlag('A', KX + 3 * U, 0, 0, -1, U));
    for (const d of dies) {
      const xs = M.dieCorners(d).map(c => c[0] * 1000 - ox), x0 = Math.min(...xs), x1 = Math.max(...xs);
      const top = M.dieTop(S, d), bot = M.dieBottom(S, d), base = M.dieBase(S, d);
      if (bot - base > 0) {
        const words = `${d.id} attach, ${n(bot - base)} µm assumed`;
        o.push(lay(d.id + ' attach', 'attach', x0 - 10, x1 + 10, base, bot - base, '', words));
        layers.push({ name: d.id + ' attach', z: base, t: bot - base, words });
      }
      const words = `${d.id} die, ${n(top - bot)} µm assumed`;
      o.push(lay(d.id, 'die', x0, x1, bot, top - bot, '', words));
      layers.push({ name: d.id, z: bot, t: top - bot, words });
    }
    if (glob) {
      const xs = wires.flatMap(r => [r.e.a[0], r.e.b[0]]).concat(dies.flatMap(d => M.dieCorners(d).map(c => c[0]))).map(x => x * 1000 - ox);
      const x0 = Math.max(KX, Math.min(...xs) - 200), x1 = Math.min(KX + PW, Math.max(...xs) + 200), words = `Glob top, ${n(glob)} µm from the DRC rules`;
      o.push(lay('glob top', 'mold', x0, x1, 0, glob, '', words));
      layers.push({ name: 'glob top', z: 0, t: glob, words });
    }
    for (const r of wires) {
      const { e, prof } = r, ux = (e.b[0] - e.a[0]) / (e.len || 1);
      const pts = prof.curve.map(p => { const s = prof.reverse ? prof.span - p[0] : p[0]; return `${um(e.a[0] * 1000 - ox + ux * s)},${um(-p[1])}`; });
      o.push(`<polyline points="${pts.join(' ')}" class="w" stroke="${ink(prof.type)}" stroke-width="${um(widthOf(r))}"${prof.dashed ? ` stroke-dasharray="${um(3 * M.CHOICE_TUBE_UM)} ${um(2 * M.CHOICE_TUBE_UM)}"` : ''}/>`);
    }
    o.push('</g>');
    const bottom0 = Y0 + subT;

    // The right-hand column: loop profiles, stack, key.
    const used = S.types.filter(t => wires.some(r => r.prof.type === t));
    const spans = t => wires.filter(r => r.prof.type === t).map(r => r.prof.span).sort((a, b) => a - b);
    const refSpan = t => { const s = spans(t); return s.length ? Math.round(s[s.length >> 1] / 10) * 10 : 1000; };
    const refs = used.map(refSpan), maxRef = Math.max(1000, ...refs);
    const CX = KX + PW + 8 * U, TX = CX + maxRef + 3 * U;
    let yy = KY;
    o.push(text(CX, KY - 1.4 * U, 'h', 'Loop profiles (drawn at reference span)'));
    used.forEach((t, i) => {
      const ref = refs[i];
      if (M.isBonderChoice(t)) {
        const h = 2 * U;
        o.push(layer('profile ' + t.name, `transform="translate(${um(CX)} ${um(yy + h)})" wb:kind="profile" wb:name="${xe(t.name)}" wb:choice="${t.generic ? 'generic' : 'undefined'}"`));
        o.push(`<line x1="0" y1="0" x2="${um(ref)}" y2="0" class="w" stroke="${CHOICE_INK}" stroke-width="${M.CHOICE_TUBE_UM}"${t.generic ? '' : ` stroke-dasharray="${um(3 * M.CHOICE_TUBE_UM)} ${um(2 * M.CHOICE_TUBE_UM)}"`}>${title(M.typeLabel(t.name))}</line></g>`);
        o.push(text(TX, yy + U, 't', M.typeLabel(t.name)));
        o.push(text(TX, yy + 3 * U, 's', t.generic ? 'Chosen on purpose: wire and loop are picked at the bonder.' : 'Nobody has said: no wire or loop given.'));
        o.push(text(TX, yy + 4.8 * U, 's', `No size or loop: drawn ${M.CHOICE_TUBE_UM} µm wide, and loop checks skip it.`));
        yy += 8 * U;
        return;
      }
      const ctrl = M.loopPts(t.moves, ref, 0), curve = M.loopCurve(t, ref, 0);
      const top = Math.max(0, ...curve.map(p => p[1])), h = Math.max(top, 2 * U);
      o.push(layer('profile ' + t.name, `transform="translate(${um(CX)} ${um(yy + h)})" wb:kind="profile" wb:name="${xe(t.name)}" wb:material="${xe(t.material)}" wb:style="${xe(t.style)}" wb:dir="${xe(t.dir)}" wb:moves="${xe(t.moves)}" wb:interp="${xe(t.interp)}" wb:ref-span="${um(ref)}"`));
      o.push(`<polyline points="${ctrl.map(p => um(p[0]) + ',' + um(-p[1])).join(' ')}" class="w ctrl" stroke="${ink(t)}" stroke-width="${um(t.d)}">${title(`${t.name} moves ${t.moves}`)}</polyline>`);
      o.push(`<line x1="0" y1="0" x2="${um(ref)}" y2="0" class="base"/>`);
      if (t.interp !== 'polyline') o.push(`<polyline points="${curve.map(p => um(p[0]) + ',' + um(-p[1])).join(' ')}" class="w" stroke="${ink(t)}" stroke-width="${um(t.d)}"/>`);
      o.push('</g>');
      o.push(text(TX, yy + U, 't', `${t.name}: ${t.material} ${t.d} µm, ${t.style}`));
      o.push(text(TX, yy + 3 * U, 's', `${t.dir === 'reverse' ? 'reverse, first bond on the land' : 'forward, first bond on the die'}; moves ${t.moves}`));
      o.push(text(TX, yy + 4.8 * U, 's', `control points at ${n(ref)} µm span, ${t.interp} between them`));
      yy += Math.max(h, 5 * U) + 3 * U;
    });
    yy += 3 * U;
    o.push(text(CX, yy, 'h', 'Stack')); yy += 3 * U;
    for (const L of layers.slice().reverse()) { o.push(text(CX, yy, 't', `${L.words}, z ${n(L.z)} to ${n(L.z + L.t)}`)); yy += 2.4 * U; }
    yy += 3 * U;
    o.push(text(CX, yy, 'h', 'Key')); yy += 3 * U;
    for (const t of used) {
      const n_ = wires.filter(r => r.prof.type === t).length;
      o.push(`<line x1="${um(CX)}" y1="${um(yy - 0.5 * U)}" x2="${um(CX + 4 * U)}" y2="${um(yy - 0.5 * U)}" class="w" stroke="${ink(t)}" stroke-width="${um(0.6 * U)}"${M.isUndefinedType(t) ? ` stroke-dasharray="${um(U)} ${um(0.6 * U)}"` : ''}/>`);
      o.push(text(CX + 5.5 * U, yy, 't', `${M.typeLabel(t.name)}: ${n_} wire${n_ === 1 ? '' : 's'}`)); yy += 2.4 * U;
    }
    yy += 2 * U;
    const gap = R.on(S, 'wireGap') ? R.value(S, 'wireGap') : null, edge = R.on(S, 'edgeClear') ? R.value(S, 'edgeClear') : null;
    for (const s of [
      `${wires.length} wires on ${dies.length} die. Hover any wire, pad, land or layer for details.`,
      ...(marks.length ? [fidMarks.length ? `Board fiducials on the substrate copper: ${fidMarks.map(m => `${m.id} ${m.role}`).join(', ')}.` : `${marks.length} copper mark${marks.length === 1 ? '' : 's'} on the substrate, none used as a fiducial.`] : []),
      ...tolDies.map(d => `Placement tolerance, draft: ${d.id} position ⌀${n(M.tolOf(d))} CZ | ${letters.split(' ').join(' | ')} on its ${M.tolPads(S, d).length} bonded pads.`),
      gap != null || edge != null ? `Rules: ${[gap != null && `wire gap ${n(gap)} µm`, edge != null && `die edge clearance ${n(edge)} µm`].filter(Boolean).join(', ')}.` : 'No wire gap or edge clearance rule set.',
      'Die thickness and attach are assumed. Written by Wire Bond Bench.',
    ]) { o.push(text(CX, yy, 's', s)); yy += 2.2 * U; }

    // The board view: the whole board under the key, at a round scale. Inside it, coordinates are the same board
    // coordinates as the rest of the file; its transform only places the drawing on the sheet.
    if (B) {
      const F = boardFacts(S, B), BW = (B.x1 - B.x0) * 1000, BH = (B.y1 - B.y0) * 1000;
      const want = Math.min(1, 0.55 * PW / BW, 0.75 * PH / BH);
      const k = [1, 0.5, 0.4, 0.25, 0.2, 0.1, 0.05, 0.04, 0.025, 0.02, 0.01, 0.005, 0.0025, 0.002, 0.001].find(v => v <= want) || want;
      const line = w => n(+(w / k).toFixed(1));   // a stroke that keeps its width on the sheet
      yy += 3 * U;
      o.push(text(CX, yy, 'h', `Board, top view (1 : ${n(1 / k)})`)); yy += 1.6 * U;
      o.push(`<g transform="translate(${um(CX)} ${um(yy)}) scale(${n(k)})" wb:kind="board" inkscape:groupmode="layer" inkscape:label="board view">`);
      o.push(`<rect x="0" y="0" width="${um(BW)}" height="${um(BH)}" class="bv-board"/>`);
      o.push(...boardPicture(B, ox, oy, k));
      o.push(layer('parts'));
      for (const p of F.parts) {
        const [a, b, c, d] = p.box, w = (c - a) * 1000, h = (d - b) * 1000, size = Math.min(fs.s / k * 0.7, Math.max(w, h) * 0.45);
        o.push(`<rect x="${px(a)}" y="${py(b)}" width="${um(w)}" height="${um(h)}" class="bv-part" stroke-width="${line(0.15 * U)}" wb:kind="part" wb:name="${xe(p.name)}"${p.height ? ` wb:height="${n(p.height)}"` : ''}>${title(`${p.name}: ${p.value}, ${p.fromCourtyard ? 'its courtyard' : 'its pads, as it has no courtyard'}, ${p.height ? n(p.height) + ' µm tall' : 'height not given'}`)}</rect>`);
        o.push(`<text x="${um((a + c) / 2 * 1000 - ox)}" y="${um((b + d) / 2 * 1000 - oy + size * 0.35)}" font-size="${um(size)}" text-anchor="middle" class="bv-ref">${xe(p.name)}</text>`);
      }
      o.push('</g>');
      // Each die with its artwork, placed and turned as in the bond diagram, so the board view shows which way round it
      // goes. A smaller copy, as the board view is drawn small, made from the image the diagram holds, so a reopened file
      // writes it the same. Its title isn't "<name> artwork", so a reader doesn't take it for the die's.
      for (const d of dies) {
        const die = d.die, P = d.place, hasArt = die.artCanvas && opts.art !== false;
        if (hasArt) {
          const art = artForKicad(shrink(die.artCanvas, opts.artPx || 1024), 384);
          o.push(`<g transform="translate(${px(P.x)} ${py(P.y)})${P.rot % 360 ? ` rotate(${n(-P.rot)})` : ''}">${title(die.name + ', on the board')}<image x="${um(die.x0 * 1000)}" y="${um(die.y0 * 1000)}" width="${um((die.x1 - die.x0) * 1000)}" height="${um((die.y1 - die.y0) * 1000)}" preserveAspectRatio="none" href="data:image/png;base64,${art.lines.map(s => s.slice(1, -1)).join('')}"/></g>`);
        }
        o.push(`<path d="M${M.dieCorners(d).map(([x, y]) => px(x) + ' ' + py(y)).join(' L')} Z" class="bv-die${hasArt ? ' art' : ''}" stroke-width="${line(0.1 * U)}"/>`);
      }
      o.push(`<rect x="${um(KX)}" y="${um(KY)}" width="${um(PW)}" height="${um(PH)}" class="bv-crop" stroke-width="${line(0.25 * U)}" stroke-dasharray="${line(1.2 * U)} ${line(0.7 * U)}">${title('The area the bond diagram above shows')}</rect>`);
      o.push(`<rect x="0" y="0" width="${um(BW)}" height="${um(BH)}" class="bv-outline" stroke-width="${line(0.2 * U)}" wb:kind="outline" wb:name="board">${title(`Board outline, ${n(BW / 1000)} × ${n(BH / 1000)} mm, the extent of its Edge.Cuts`)}</rect>`);
      for (const f of F.fids) {
        const s = f.shape, at = `class="bv-fid" wb:kind="fiducial" wb:name="${xe(f.name)}" wb:role="${f.role}"${f.datum ? ` wb:datum="${xe(f.datum)}"` : ''}`;
        const words = title(`${f.name} fiducial, ${f.role === 'align' ? 'align: a machine may fit to it' : 'orient: a mark for people'}${f.datum ? ', datum ' + f.datum : ''}`);
        o.push(s.circle ? `<circle cx="${px(s.x)}" cy="${py(s.y)}" r="${um(s.r * 1000)}" ${at}>${words}</circle>`
          : `<path d="M${[0, 2, 4, 6].map(i => px(s.pts[i]) + ',' + py(s.pts[i + 1])).join(' L')} Z" ${at}>${words}</path>`);
      }
      o.push('</g>');
      right = Math.max(right, CX + BW * k);
      yy += BH * k + 2 * U;
      o.push(text(CX, yy, 's', `${F.fids.length} fiducial${F.fids.length === 1 ? '' : 's'} and ${F.parts.length} front-side part${F.parts.length === 1 ? '' : 's'} on the board. Dashed: the diagram's area.`)); yy += 2.2 * U;
    }

    // Where the file came from, last in the right-hand column: the wirebond.svg logo, linked to the project, and one line
    // under it. Decoration, with no wb:kind, so readers pass over it.
    yy += 2 * U;
    const LH = 5 * U, LW = LH * BRAND_MARK.w / BRAND_MARK.h;
    o.push(`<a href="${xe(BR.url)}" target="_blank" class="madewith">${title(BR.credit)}<svg x="${um(CX)}" y="${um(yy)}" width="${um(LW)}" height="${um(LH)}" viewBox="${BRAND_MARK.viewBox}">${BRAND_MARK.body}</svg></a>`);
    right = Math.max(right, CX + LW);
    yy += LH + 1.8 * U;
    o.push(text(CX, yy, 's', `Made with ${BR.name}: ${BR.url.replace(/^https:\/\//, '')}`)); yy += 2.2 * U;

    const VX = KX - 2 * U, VY = KY - 5 * U, VW = right + 2 * U - VX, VH = Math.max(bottom0, yy) + 3 * U - VY;
    const style = `text{font-family:Helvetica,Arial,sans-serif;fill:#222}.h{font-size:${um(fs.h)}px;font-weight:bold}.t{font-size:${um(fs.t)}px}.s{font-size:${um(fs.s)}px;fill:#555}`
      + '.sub{fill:#eef3ea;stroke:#9aa;stroke-width:4}.cu{fill:#d9a441}.paddle{fill-opacity:.5}.die{fill:#c9ccd6;stroke:#667;stroke-width:4}.die.art{fill:none}.pad{fill:#f7f7fa;fill-opacity:.85;stroke:#445;stroke-width:2}'
      + '.w{fill:none;stroke-linecap:round;stroke-linejoin:round}.ctrl{stroke-opacity:.35}.base{stroke:#bbb;stroke-width:4}.lab{fill:#333}'
      + (marks.length ? '.mark{fill-opacity:.55}.fid{stroke:#0b7a66;stroke-width:4}.fidring{fill:none;stroke:#0b7a66}.fidlab{fill:#0b7a66;font-weight:bold}' : '')
      + (tolDies.length ? '.zone{fill:#e67e22;fill-opacity:.35;stroke:#e67e22}.gd{fill:none;stroke:#222}.gdb{fill:#fff;stroke:#222}.gdf,.gdt{fill:#222}' : '')
      + '.L-substrate{fill:#eef3ea;stroke:#9aa;stroke-width:4}.L-attach{fill:#888}.L-die{fill:#c9ccd6;stroke:#667;stroke-width:4}.L-mold{fill:#7aa7c7;fill-opacity:.18;stroke:#7aa7c7;stroke-width:4;stroke-dasharray:30 20}'
      + (B ? '.bv-board{fill:#e4ede5}.bv-cu .f{fill:#c99a3d;fill-opacity:.55}.bv-cu .s{fill:none;stroke:#c99a3d;stroke-opacity:.55;stroke-linecap:round;stroke-linejoin:round}'
        + '.bv-silk .f{fill:#3a4442}.bv-silk .s{fill:none;stroke:#3a4442;stroke-linecap:round;stroke-linejoin:round}.bv-silk text{fill:#3a4442}.bv-edge .s{fill:none;stroke:#2b3532}'
        + '.bv-part{fill:#7b5cb8;fill-opacity:.08;stroke:#7b5cb8}.bv-ref{fill:#5b3f96}.bv-die{fill:#c9ccd6;stroke:#667}.bv-die.art{fill:none}.bv-crop{fill:none;stroke:#b03a8c}.bv-outline{fill:none;stroke:#2b3532}.bv-fid{fill:#0b7a66}' : '');
    const rootAttrs = [`wb:version="0.2"`, `wb:units="um"`, `wb:design="${xe(design)}"`];
    if (gap != null) rootAttrs.push(`wb:rule-wire-gap="${n(gap)}"`);
    if (edge != null) rootAttrs.push(`wb:rule-edge-clear="${n(edge)}"`);
    const pxW = 1400;
    // Sealed last, over everything above: see seal.js. A reader that finds it no longer matches knows the file was edited.
    return W.WBSVG.seal.stamp(`<?xml version='1.0' encoding='utf-8'?>
<!-- ${xe(BR.credit)} -->
<svg xmlns="${SVGNS}" xmlns:wb="${WBNS}" xmlns:inkscape="${INKNS}" viewBox="${um(VX)} ${um(VY)} ${um(VW)} ${um(VH)}" width="${pxW}" height="${Math.round(pxW * VH / VW)}" ${rootAttrs.join(' ')}>
<title>Wire bond diagram: ${xe(design)}</title>
<desc>A wire bond diagram in the ${xe(BR.name)} format, v0.2: a true-scale drawing that is also the data. ${xe(BR.credit)}</desc>
${svgMetadata(design)}
<style>${style}</style>
${o.join('\n')}
</svg>
`);
  }

  /* ---- zip, stored ---- */
  const CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
  const crc32 = b => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function zip(files) {
    const enc = new TextEncoder(), parts = [], central = [];
    let off = 0;
    for (const [name, content] of Object.entries(files)) {
      const nb = enc.encode(name), data = typeof content === 'string' ? enc.encode(content) : content, crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nb.length, true);
      parts.push(new Uint8Array(h.buffer), nb, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nb.length, true); c.setUint32(42, off, true);
      central.push(new Uint8Array(c.buffer), nb);
      off += 30 + nb.length + data.length;
    }
    const cs = central.reduce((a, b) => a + b.length, 0);
    const e = new DataView(new ArrayBuffer(22));
    const count = Object.keys(files).length;
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, count, true); e.setUint16(10, count, true); e.setUint32(12, cs, true); e.setUint32(16, off, true);
    return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/zip' });
  }

  W.WBSVG.export = { dieFootprintFile, dieStep, dieArt, artAutoColours, BOND_STEP, symbolFile, assemble, bondlist, wbSvg, zip, safe };
})(window);
