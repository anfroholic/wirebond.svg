/* The bench: holds the session, loads files, and wires the panels to the model and views.
   Wire Bond Bench, part of wirebond.svg: https://github.com/anfroholic/wirebond.svg. (c) Andrew Wingate, MIT licence. */
(function (W) {
  'use strict';
  const BRAND = W.WBSVG.brand, K = W.WBSVG.kicad, G = W.WBSVG.gds, M = W.WBSVG.model, X = W.WBSVG.export, V = W.WBSVG.view, DRC = W.WBSVG.rules;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fx = (v, d) => (+v).toFixed(d === undefined ? 2 : d);
  // A generic or undefined wire's length is the straight distance from pad to land, so it reads as an estimate.
  const fxLen = (w, v) => (M.isBonderChoiceWire(S, w) ? '≈' : '') + fx(v);
  const shortLabel = t => M.isGenericType(t) ? 'Generic' : M.isUndefinedType(t) ? 'Undefined' : M.typeLabel(t.name);
  const typeOptions = (chosen, shortName) => S.types.map(t => `<option value="${esc(t.name)}" ${t.name === chosen ? 'selected' : ''}>${esc(shortName ? shortLabel(t) : M.typeLabel(t.name))}</option>`).join('');

  /* One slot per die. Each carries everything that belongs to that die: its source, its placement and its regime. */
  const newSlot = (id, regime) => ({
    id, die: null, place: { x: 0, y: 0, rot: 0, thick: 280, attach: 25, on: 'board', customUm: 0, tol: 0 }, padBy: new Map(),
    regime: regime || 'number', numberOffset: 0, placeNote: null,
    gdsOpts: { cell: null, padLayer: null, minUm: 30, maxUm: 300, peripheralOnly: true, corner: 'auto', dir: 'ccw', markText: 'ws_ip__(id|qrcode)', firstKey: null, removed: [], artPx: 4096, labelLayer: 'auto' },
    netOverride: {}, dieRemoved: [], dieMode: 'gds', layers: null,
    // The artwork painted on the die in the STEP, in two colours; an empty colour is the artwork's own.
    art3d: { on: true, base: '', accent: '' },
    gds: { lib: null, top: null, file: null, cands: null }, artToken: null,
  });
  const S = {
    substrate: null, dies: [newSlot('D1')], active: 'D1', lands: [], paddle: null, landBy: new Map(),
    wires: [], types: M.DEFAULT_TYPES(), typeRules: [], defaultType: M.GENERIC, rules: DRC.defaults(),
    bond: { mode: 'inner', mm: 0.2 }, boardWires: [], drawn: [], maxLand: 2, landSkip: [], existingDie: null, sidecars: {},
    marks: [], fidRole: {}, fidDatum: null,
  };
  // S.limits is a view onto S.rules, for code written before the DRC rules. Assigning it, as an old session does, writes into the rules.
  DRC.attach(S);
  // S.die, S.place and the rest read and write the selected die, so whatever acts on one die needs no change for several.
  const slot = () => M.activeDie(S);
  for (const k of ['die', 'place', 'padBy', 'regime', 'numberOffset', 'placeNote', 'gdsOpts', 'netOverride', 'dieRemoved', 'dieMode', 'layers', 'art3d'])
    Object.defineProperty(S, k, { enumerable: false, get: () => slot()[k], set: v => { slot()[k] = v; } });
  const gds = {};
  for (const k of ['lib', 'top', 'file', 'cands']) Object.defineProperty(gds, k, { enumerable: true, get: () => slot().gds[k], set: v => { slot().gds[k] = v; } });
  // Run something as if this die were selected.
  function withDie(d, fn) { const was = S.active; S.active = d.id; try { return fn(); } finally { S.active = was; } }
  const placedDies = () => M.placedDies(S);
  const manyDies = () => placedDies().length > 1;
  // A new name for a die: not one in use, and not a footprint's in the board, which the wires name their ends by.
  function nextDieId() {
    const taken = new Set(S.dies.map(d => d.id));
    if (S.substrate && S.substrate.board) for (const f of S.substrate.board.fps) if (f.wbKind !== 'die') taken.add(f.ref);
    let k = 1;
    while (taken.has('D' + k)) k++;
    return 'D' + k;
  }
  // Keep whatever sits on a die where it is relative to that die, through a move or a turn.
  function carryStack(d, was) {
    const now = d.place;
    if (was.x === now.x && was.y === now.y && was.rot === now.rot) return;
    for (const o of M.stackedOn(S, d)) {
      const [x, y] = M.dieToBoard(now, ...M.boardToDie(was, o.place.x, o.place.y));
      o.place = Object.assign({}, o.place, { x, y, rot: ((o.place.rot + now.rot - was.rot) % 360 + 360) % 360 });
    }
  }
  const app = {
    S, sel: null, selWire: null, flagged: null, flagId: null, preview: null, mode: 'plan', tab: 'regimes', regimes: {}, checks: null,
  };
  W.WBSVG.app = app;
  /* Wire selection. app.selWires holds every selected wire, by object; app.selWire is the primary one, and setting it selects that wire alone (null clears),
     so code that only knows one wire keeps working. app.anchor is where a Shift range starts. None of it is saved with the session. */
  let primaryWire = null;
  app.selWires = new Set(); app.anchor = null;
  Object.defineProperty(app, 'selWire', {
    enumerable: true,
    get: () => primaryWire,
    set: w => { primaryWire = w || null; app.selWires = new Set(primaryWire ? [primaryWire] : []); app.anchor = primaryWire; },
  });
  function setSel(set, primary, anchor) {
    app.selWires = set;
    primaryWire = set.has(primary) ? primary : [...set].pop() || null;
    app.anchor = anchor === undefined ? app.anchor : anchor;
  }
  // Drop selected wires that are gone, such as deleted ones or those another die took with it.
  function syncSel() {
    if (!app.selWires.size) return;
    const live = new Set(S.wires);
    if ([...app.selWires].every(w => live.has(w))) return;
    setSel(new Set([...app.selWires].filter(w => live.has(w))), primaryWire, live.has(app.anchor) ? app.anchor : null);
  }
  let plan, tilt;

  /* ---- feedback ---- */
  function toast(msg, kind) {
    const d = document.createElement('div');
    d.className = 'toast' + (kind ? ' ' + kind : '');
    d.textContent = msg;
    $('toasts').appendChild(d);
    setTimeout(() => d.remove(), kind === 'err' ? 9000 : 5200);
  }
  function busy(text, frac) {
    if (text === null) { $('busy').hidden = true; return; }
    $('busy').hidden = false;
    $('busyText').textContent = text;
    $('busyBar').style.width = frac === undefined ? '100%' : (frac * 100).toFixed(0) + '%';
  }
  const frame = () => new Promise(r => setTimeout(r, 0));
  function guarded(fn) { return async (...a) => { try { return await fn(...a); } catch (e) { console.error(e); toast(e.message || String(e), 'err'); busy(null); } }; }
  // The same, as one undo step, for an edit that waits on reading a GDS or drawing. Undo waits for it.
  const stepped = fn => guarded((...a) => oneStep(() => fn(...a)));

  /* ---- derived state ---- */
  function indexDie() { S.padBy = new Map((S.die ? S.die.pads : []).map(p => [p.num, p])); }
  function indexLands() { S.landBy = new Map(S.lands.map(l => [l.id, l])); }
  function pruneWires() { S.wires = S.wires.filter(w => M.wireEnds(S, w)); }

  function refreshLands() {
    if (!S.substrate) { S.lands = []; S.paddle = null; S.drawn = []; S.marks = []; indexLands(); return; }
    const b = S.substrate.board;
    const fps = S.substrate.selected >= 0 ? [b.fps[S.substrate.selected]] : b.fps.filter((f, i) => !S.dies.some(d => d.dieMode === 'footprint' && d.die && d.die.boardIndex === i));
    const r = K.landsFrom(fps, { maxLen: S.maxLand });
    S.lands = r.lands.filter(l => !S.landSkip.includes(l.id));
    S.paddle = r.paddle;
    S.landsSkipped = r.skipped;
    S.substrate.selectedRef = S.substrate.selected >= 0 ? b.fps[S.substrate.selected].ref : '';
    S.drawn = K.drawnLines(fps);
    // Copper marks near the lands, each with the role picked for it or the one its shape suggests.
    const near = S.lands.concat(S.paddle ? [S.paddle] : []);
    const box = near.length ? [Math.min(...near.map(l => l.x - l.w)) - 2, Math.min(...near.map(l => l.y - l.h)) - 2, Math.max(...near.map(l => l.x + l.w)) + 2, Math.max(...near.map(l => l.y + l.h)) + 2] : null;
    S.marks = K.marksFrom(fps, box);
    applyMarkRoles();
    indexLands();
  }
  /* Each mark's role, as picked or as its shape suggests, then the datum letters B and C. Picked by hand they're
     S.fidDatum, { B: mark id, C: mark id }; otherwise they go to the two align marks farthest apart, as a machine would pick. */
  function applyMarkRoles() {
    for (const m of S.marks) { m.role = S.fidRole[m.id] || m.auto; m.datum = null; }
    const live = S.marks.filter(m => m.role !== 'off');
    let pick = S.fidDatum;
    if (!pick) {
      const al = live.filter(m => m.role === 'align');
      let far = -1;
      pick = {};
      for (let i = 0; i < al.length; i++) for (let j = i + 1; j < al.length; j++) {
        const d = Math.hypot(al[i].cx - al[j].cx, al[i].cy - al[j].cy);
        if (d > far) { far = d; pick = { B: al[i].id, C: al[j].id }; }
      }
    }
    for (const [k, id] of Object.entries(pick)) { const m = live.find(x => x.id === id); if (m) m.datum = k; }
  }

  function computeRegimes() {
    app.regimes = {};
    if (!S.die || !S.lands.length) return;
    for (const [k, R] of Object.entries(M.REGIMES)) {
      if (R.needs && !R.needs(S)) { app.regimes[k] = null; continue; }
      const wires = R.run(S);
      app.regimes[k] = { wires, m: M.measure(S, wires) };
    }
  }
  function applyRegime(key, opts) {
    opts = opts || {};
    if (!S.die || !S.lands.length) { S.wires = S.wires.filter(w => w.pinned || !M.wireTouchesDie(S, w, S.active)); pruneWires(); return; }
    const R = M.REGIMES[key];
    if (key !== 'manual' && (!R || (R.needs && !R.needs(S)))) return;
    // A regime replaces its own wires only. The board speaks for every die, and the others for the selected one.
    const all = key === 'board';
    if (all) for (const d of S.dies) d.regime = key; else S.regime = key;
    const kept = S.wires.filter(w => w.pinned || (!all && M.wireDieId(S, w) !== S.active));
    if (key === 'manual') S.wires = kept;
    else {
      // A pad already spoken for keeps its wire, whichever end of that wire it is.
      const taken = new Set();
      for (const w of kept) for (const k of M.wireEndKeys(S, w)) taken.add(k);
      S.wires = kept.concat(R.run(S).filter(w => !M.wireEndKeys(S, w).some(k => k.indexOf('land\t') !== 0 && taken.has(k))));
    }
    pruneWires();
    app.selWire = null; app.flagged = null; app.flagId = null;
  }
  // The regime worth showing first: one that pairs the most pads without crossings, the board's own wires when it has them.
  function pickRegime() {
    computeRegimes();
    if (app.regimes.board && app.regimes.board.m.wires) return 'board';
    const ok = k => app.regimes[k] && app.regimes[k].m.wires >= 0.8 * S.die.pads.length && !app.regimes[k].m.cross;
    if (ok('number')) return 'number';
    if (ok('nets')) return 'nets';
    return 'ring';
  }
  // A new substrate starts the wires again, for every die. A die added beside others starts by hand, unless its slot was already following a regime.
  function regenWires() {
    S.wires = [];
    const dies = placedDies();
    for (const d of dies) {
      if (d !== dies[0] && d.regime === 'manual') continue;
      if (S.lands.length) withDie(d, () => applyRegime(pickRegime()));
      if (d.regime === 'board') break;
    }
  }
  function placeDies() {
    if (S.substrate) for (const d of M.stackOrder(S)) if (!d.die.placed) withDie(d, () => { M.autoPlace(S); d.die.placed = true; });
  }
  // scope 'die': only the selected die's source changed, so only its wires go.
  function afterSources(scope) {
    indexDie(); refreshLands();
    placeDies();
    if (scope === 'die' && manyDies()) {
      S.wires = S.wires.filter(w => !M.wireTouchesDie(S, w, S.active));
      if (S.die && S.lands.length && S.regime !== 'manual') applyRegime(pickRegime());
    } else regenWires();
    pruneWires();
    renderAll();
    plan.fit();
    if (app.mode === '3d') tilt.fit();
    save();
  }

  /* ---- loading ---- */
  const extOf = name => { const n = name.toLowerCase(); if (n.endsWith('.gds.gz') || n.endsWith('.gds2.gz')) return 'gds.gz'; return n.split('.').pop(); };
  async function readGdsBuffer(file) {
    if (extOf(file.name) === 'gz' || extOf(file.name) === 'gds.gz') {
      if (!W.DecompressionStream) throw new Error('This browser can\'t decompress .gz files. Unzip it and drop the .gds.');
      return new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    }
    return file.arrayBuffer();
  }
  // A board's layers start shown, apart from the drawing and courtyard layers.
  function boardLayersShown() {
    plan.vis = {};
    if (S.substrate) for (const n of S.substrate.layerNames) plan.vis[n] = !/CrtYd|Fab|Dwgs|Cmts/.test(n);
  }
  function setSubstrate(board, text, fileName) {
    const selected = board.kind === 'footprint' ? 0 : K.suggestSubstrate(board);
    S.substrate = { board, text, fileName, selected, kind: board.kind };
    V.buildBoardPaths(S.substrate);
    S.boardWires = board.kind === 'board' ? K.boardWires(board) : [];
    boardLayersShown();
    const fromBoard = K.boardTypes(board);
    for (const t of fromBoard) {
      t.colour = t.colour || (S.types.find(o => o.name === t.name) || {}).colour || '#e8b84a';
      const i = S.types.findIndex(o => o.name === t.name);
      if (i >= 0) S.types[i] = Object.assign({}, S.types[i], t); else S.types.push(t);
    }
    if (fromBoard.length) toast(`Read ${fromBoard.length} wire types from the board.`);
    S.landSkip = [];
    S.fidRole = K.markRoles(board);
    S.fidDatum = K.markDatums(board);
    S.existingDie = null;
    if (board.kind === 'board') {
      const d = board.fps.find(f => f.wbKind === 'die');
      if (d) {
        const die = K.dieFromFootprint(d), [a, b] = K.rot(...M.dieCentre(die), d.rot);
        S.existingDie = { x: d.x + a, y: d.y + b, rot: d.rot };
      }
    }
    for (const d of S.dies) if (d.die) d.die.placed = false;
  }
  const loadSubstrateText = (text, name) => {
    const low = name.toLowerCase();
    const board = low.endsWith('.kicad_mod') ? K.parseFootprintFile(text) : K.parseBoard(text);
    if (board.kind === 'footprint') board.fps[0].ref = board.fps[0].ref && !/REF/.test(board.fps[0].ref) ? board.fps[0].ref : 'J1';
    setSubstrate(board, text, name);
    return board;
  };
  async function artFromImages(die) {
    const im = die.images && die.images[0];
    if (!im) return;
    const img = new Image();
    await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = 'data:image/png;base64,' + im.b64; }).catch(() => null);
    if (!img.width) return;
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    die.artCanvas = c;
    delete die.images;
  }
  async function useFootprintDie(fp, fileName, opts) {
    opts = opts || {};
    const die = K.dieFromFootprint(fp);
    die.fileName = fileName;
    die.sourceText = opts.text || null;
    if (opts.boardIndex !== undefined) { die.boardIndex = opts.boardIndex; S.place = Object.assign({}, S.place, { x: fp.x, y: fp.y, rot: fp.rot }); die.placed = true; }
    await artFromImages(die);
    S.die = die; S.dieMode = 'footprint'; S.layers = null; gds.lib = null; gds.file = null; S.netOverride = {}; S.dieRemoved = [];
    S.existingDie = null;
    afterSources('die');
    toast(`Die from footprint: ${die.pads.length} pads.`);
  }
  function buildOptions() {
    const o = S.gdsOpts;
    let re = null;
    try { re = o.markText ? new RegExp(o.markText, 'i') : null; } catch (e) { /* a half-typed pattern finds no mark */ }
    return { padLayer: o.padLayer, minUm: o.minUm, maxUm: o.maxUm, peripheralOnly: o.peripheralOnly, corner: o.corner, dir: o.dir, markRe: re, firstKey: o.firstKey, removed: o.removed, labelLayer: o.labelLayer };
  }
  const ctlBusy = label => ({ onTick() { busy(label); } });
  function keepArt(next, prev) {
    if (prev && prev.artCanvas) { next.artCanvas = prev.artCanvas; next.artBlob = prev.artBlob; }
    next.fileName = (prev && prev.fileName) || (gds.file && gds.file.name);
  }
  async function rebuildGds() {
    const prev = S.die, ctl = ctlBusy('Reading pads');
    busy('Reading pads');
    await frame();
    const die = await G.buildDie(gds.lib, gds.top, Object.assign({ candidates: gds.cands }, buildOptions()), ctl);
    delete die.candidatesRaw;
    keepArt(die, prev);
    die.placed = prev ? prev.placed : false;
    applyNetOverrides(die);
    S.die = die;
    busy(null);
  }
  function applyNetOverrides(die) {
    for (const p of die.pads) if (S.netOverride[p.key] !== undefined) p.net = S.netOverride[p.key] || null;
    if (die.source === 'footprint' && S.dieRemoved.length) die.pads = die.pads.filter(p => !S.dieRemoved.includes(p.key));
  }
  async function selectCell(name) {
    const top = gds.lib.cells.get(name) || gds.lib.tops[0];
    gds.top = top;
    S.gdsOpts.cell = top.name;
    busy('Looking for pads');
    await frame();
    gds.cands = await G.padCandidates(gds.lib, top, buildOptions(), ctlBusy('Looking for pads'));
    if (!gds.cands.some(c => c.key === S.gdsOpts.padLayer)) S.gdsOpts.padLayer = gds.cands[0] ? gds.cands[0].key : null;
    S.layers = G.defaultLayers(gds.lib, top);
    S.die = null;
    await rebuildGds();
    S.die.placed = false;
  }
  // fresh: the drawing changed (a layer or the resolution), so it goes on a copy of the die, and the undo step before keeps the old picture.
  async function renderArt(fresh) {
    if (!gds.lib || !S.die || !S.layers) return;
    const me = slot();
    if (me.artToken) me.artToken.cancelled = true;
    if (fresh) S.die = Object.assign({}, S.die);
    const die = S.die;
    const ctl = me.artToken = {
      onLayer(f, key, canvas) {
        if (ctl.cancelled) return;
        busy('Drawing ' + key, f);
        die.artCanvas = canvas;
        plan.draw(); tilt.draw();
      },
      onTick() { },
    };
    busy('Drawing artwork', 0);
    const t0 = performance.now();
    const canvas = await G.render(gds.lib, gds.top, S.layers, S.gdsOpts.artPx, ctl);
    if (ctl.cancelled || !canvas) return;
    me.artToken = null;
    die.artCanvas = canvas;
    die.artBlob = null;
    die.artMs = performance.now() - t0;
    busy(null);
    plan.draw(); tilt.draw();
    renderLeft();
    save();
  }
  const loadGds = guarded(async file => {
    if (/\.(oas|oasis)$/i.test(file.name)) throw new Error('OASIS isn\'t supported yet. Export the die as GDS first.');
    busy('Reading ' + file.name, 0);
    await frame();
    const buf = await readGdsBuffer(file);
    busy('Parsing GDS', 0);
    await frame();
    const t0 = performance.now();
    const lib = await G.parse(buf, f => busy('Parsing GDS', f));
    gds.lib = lib; gds.file = file;
    S.dieMode = 'gds';
    S.netOverride = {}; S.dieRemoved = [];
    Object.assign(S.gdsOpts, { firstKey: null, removed: [], padLayer: null, corner: 'auto' });
    await selectCell(lib.tops[0].name);
    S.die.fileName = file.name;
    afterSources('die');
    busy(null);
    const i = S.die.info;
    toast(`${file.name}: ${fx((S.die.x1 - S.die.x0))} × ${fx(S.die.y1 - S.die.y0)} mm, ${S.die.pads.length} pads on ${i.padLayer}, ${i.netsFound} named, in ${fx((performance.now() - t0) / 1000, 1)} s.`);
    guarded(renderArt)();
  });
  async function ensureGds() {
    if (gds.lib) return true;
    if (!gds.file) { toast('Drop the GDS again to change this. Only its result was saved.', 'warn'); return false; }
    busy('Reading ' + gds.file.name);
    const buf = await readGdsBuffer(gds.file);
    gds.lib = await G.parse(buf, f => busy('Parsing GDS', f));
    gds.top = gds.lib.cells.get(S.gdsOpts.cell) || gds.lib.tops[0];
    gds.cands = await G.padCandidates(gds.lib, gds.top, buildOptions(), ctlBusy('Looking for pads'));
    busy(null);
    return true;
  }
  // Files dropped together are one undo step, however many saves loading them takes.
  const loadFiles = guarded((files, role) => oneStep(() => readFiles(files, role)));
  async function readFiles(files, role) {
    const list = [...files], mods = [], rest = [], side = [];
    for (const f of list) { const e = extOf(f.name); (e === 'kicad_mod' ? mods : e === 'kicad_pro' || e === 'kicad_sch' ? side : rest).push(f); }
    const fresh = {};
    for (const f of side) fresh[extOf(f.name) === 'kicad_pro' ? 'pro' : 'sch'] = await f.text();
    for (const f of rest) {
      const e = extOf(f.name);
      if (e === 'kicad_pcb') { S.sidecars = {}; loadSubstrateText(await f.text(), f.name); if (!S.die || S.dieMode !== 'gds') tryDieInBoard(); afterSources(); toast(`${f.name}: ${S.substrate.board.fps.length} footprints.`); }
      else if (['gds', 'gds2', 'gdsii', 'gz', 'gds.gz'].includes(e)) await loadGds(f);
      else if (['oas', 'oasis'].includes(e)) toast('OASIS isn\'t supported yet. Export the die as GDS first.', 'err');
      else if (e === 'svg') await openWbSvg(await f.text(), f.name);
      else toast(`${f.name} isn't a file this reads. It takes .kicad_pcb, .kicad_mod, .gds, .gds.gz and .wb.svg.`, 'err');
    }
    if (side.length) {
      Object.assign(S.sidecars, fresh);
      if (!rest.length && !mods.length) { renderLeft(); save(); toast('Project files will travel with the exported board.'); }
    }
    if (!mods.length) return;
    const parsed = [];
    for (const f of mods) { const text = await f.text(); parsed.push({ f, text, board: K.parseFootprintFile(text) }); }
    const areaOf = p => { const d = K.dieFromFootprint(p.board.fps[0]); return (d.x1 - d.x0) * (d.y1 - d.y0); };
    const assign = async (p, as) => {
      if (as === 'die') await useFootprintDie(p.board.fps[0], p.f.name, { text: p.text });
      else { loadSubstrateText(p.text, p.f.name); afterSources(); toast(`${p.f.name} is the substrate: ${S.lands.length} lands.`); }
    };
    if (role) { for (const p of parsed) await assign(p, role); return; }
    if (parsed.length >= 2) {
      // Of two footprints, the die is the one that fits inside the other.
      parsed.sort((a, b) => areaOf(b) - areaOf(a));
      await assign(parsed[0], 'substrate');
      await assign(parsed[1], 'die');
    } else {
      const p = parsed[0], declared = p.board.fps[0].wbKind === 'die';
      await assign(p, declared || S.substrate ? 'die' : 'substrate');
    }
  }
  // Every die footprint in the board comes in as a die, named by its reference, because that's what its wires call it.
  function tryDieInBoard() {
    // In order of reference, because KiCad reorders footprints when it saves a board.
    const b = S.substrate.board, found = b.fps.map((f, i) => ({ f, i })).filter(x => x.f.wbKind === 'die')
      .sort((x, y) => String(x.f.ref).localeCompare(String(y.f.ref), undefined, { numeric: true }) || x.i - y.i);
    if (!found.length || placedDies().length) return;
    S.dies = S.dies.filter(d => d.die || d.id === S.active);
    found.forEach(({ f, i }, n) => {
      const die = K.dieFromFootprint(f);
      die.fileName = S.substrate.fileName; die.boardIndex = i; die.placed = true;
      // One die keeps the name D1 it always had. Several take their references, because their wires tell them apart by it.
      const ref = found.length > 1 && f.ref && !/REF/.test(f.ref) && !S.dies.some((d, k) => d.id === f.ref && (n === 0 ? k > 0 : true)) ? f.ref : null;
      let d;
      if (n === 0) { d = slot(); if (ref) { d.id = ref; S.active = ref; } }
      else { d = newSlot(ref || nextDieId(), 'board'); S.dies.push(d); }
      d.place = Object.assign({}, d.place, { x: f.x, y: f.y, rot: f.rot });
      d.die = die; d.dieMode = 'footprint';
      d.padBy = new Map(die.pads.map(p => [p.num, p]));
      if (f.props.wb_thickness_um) d.place.thick = +f.props.wb_thickness_um;
      if (f.props.wb_attach_um) d.place.attach = +f.props.wb_attach_um;
      if (f.props.wb_sits_on) { d.place.on = f.props.wb_sits_on; d.place.customUm = +f.props.wb_bottom_um || 0; }
      if (+f.props.wb_position_tol_um > 0) d.place.tol = +f.props.wb_position_tol_um;
      artFromImages(die).then(() => { plan.draw(); tilt.draw(); });
    });
    // A die that names something not in this board keeps the height the board recorded.
    for (const d of S.dies) if (d.place.on && d.place.on !== 'board' && d.place.on !== 'custom' && !M.dieById(S, d.place.on)) d.place.on = 'custom';
    S.existingDie = null;
  }
  /* ---- opening a .wb.svg ----
     It replaces the session. The file is rewritten as a board in the form the bench writes for KiCad, and opened as one,
     so everything after this, editing, saving the session and exporting, works as it does for that board. */
  async function openWbSvg(text, name) {
    const WB = W.WBSVG.wbsvg;
    if (!WB.looks(text)) throw new Error(`${name} is an SVG but not a wirebond.svg: it has no wb: namespace.`);
    const doc = WB.parse(text);
    await reset(true, true);
    // Its wire profiles join the built-in ones, replacing any of the same name, so there are others to switch to.
    for (const p of doc.profiles) {
      if (p.choice) continue;
      const i = S.types.findIndex(t => t.name === p.name), was = i >= 0 ? S.types[i] : null;
      const t = { name: p.name, family: was ? was.family : 'custom', style: p.style, material: p.material, d: p.d, dir: p.dir, moves: p.moves, interp: p.interp, colour: (was && was.colour) || p.colour || '#e8b84a' };
      if (i >= 0) S.types[i] = t; else S.types.push(t);
    }
    // Rules the file states are on at its numbers; the ones it leaves out were off when it was written.
    const rule = (id, v) => ({ value: v == null ? S.rules[id].value : v, on: v != null });
    S.rules = DRC.normalise(Object.assign({}, S.rules, { wireGap: rule('wireGap', doc.rules.gap), edgeClear: rule('edgeClear', doc.rules.edge), globTop: rule('globTop', doc.glob) }));
    S.sidecars = {};
    loadSubstrateText(WB.toKicad(doc), name);
    tryDieInBoard();
    for (const src of doc.dies) {
      const d = M.dieById(S, src.id) || (doc.dies.length === 1 ? placedDies()[0] : null);
      if (!d || !d.die) continue;
      if (src.cell) d.die.info = Object.assign({}, d.die.info, { cell: src.cell, padLayer: src.padLayer });
      if (src.art) { d.die.images = [{ b64: src.art }]; await artFromImages(d.die); }
    }
    afterSources();
    // The file's own bond points, where they differ from where the bench would put them: kept as offsets on the wire.
    const bySeq = new Map(doc.wires.map(w => [w.seq, w]));
    for (const w of S.wires) {
      const f = bySeq.get(w.seq), e = f && M.wireEnds(S, w);
      if (!e) continue;
      const a = [f.x1 / 1000, f.y1 / 1000], b = [f.x2 / 1000, f.y2 / 1000], far = 5e-4;
      if (Math.hypot(a[0] - e.a[0], a[1] - e.a[1]) > far) { const [x, y] = M.boardToDie(e.die.place, ...a); w.padOff = [x - e.pad.x, y - e.pad.y]; }
      if (Math.hypot(b[0] - e.b[0], b[1] - e.b[1]) > far) {
        if (e.land) { const ax = M.landAxis(e.land), dx = b[0] - e.land.x, dy = b[1] - e.land.y; w.landOff = [dx * ax.ux + dy * ax.uy, -dx * ax.uy + dy * ax.ux]; }
        else { const [x, y] = M.boardToDie(e.toDie.place, ...b); w.toPadOff = [x - e.toPad.x, y - e.toPad.y]; }
      }
    }
    renderAll(); plan.draw(); tilt.draw(); save();
    const kept = [`${placedDies().length} die`, `${S.lands.length} lands`, `${S.wires.length} of ${doc.wires.length} wires`];
    toast(`Opened ${name}: ${kept.join(', ')}.${doc.notes.length ? ' ' + doc.notes.join(' ') : ''}`, doc.seal === 'data changed' ? 'err' : doc.seal === 'drawing changed' ? 'warn' : undefined);
  }
  /* ---- bundled examples ----
     The files live in samples/<id>.js, written by make_samples.py, and that script is only added when its example is
     chosen. The last file is the die, and everything before it is the substrate and its project files. A lone .wb.svg
     opens whole, with every die and wire it holds. */
  const EXAMPLES = [
    { id: 'ring', group: 'ws', title: 'wafer.space die on its padring', art: 'ring', die: 'gds',
      files: ['waferspace_1x1_die.gds', 'waferspace_default_padring_v0.2.kicad_mod'],
      blurb: 'The usual way in: a GDS from the template and the footprint it bonds to. Land n is drawn for pad n.' },
    { id: 'wired', group: 'ws', title: 'wafer.space die, already wired', art: 'board', die: 'gds', wired: true,
      files: ['waferspace_1x1_die.gds', 'example.kicad_pcb'],
      blurb: 'The main example as a KiCad board, with all 74 wires, their types and the fiducials, so it opens finished.' },
    { id: 'board', group: 'ws', title: 'wafer.space die on a real COB board', art: 'board', die: 'gds',
      files: ['waferspace_1x1_die.gds', '1x1-mezzanine.kicad_pcb', '.kicad_pro', '.kicad_sch'],
      blurb: 'The run-2 1x1 mezzanine, with its project and schematic, so the export is a board KiCad opens as it was.' },
    { id: 'mods', group: 'ws', title: 'wafer.space die, no GDS yet', art: 'ring', die: 'fp',
      files: ['waferspace_1x1_die.kicad_mod', 'waferspace_default_padring_v0.2.kicad_mod'],
      blurb: 'The die as a plain footprint: pad positions and names, no artwork. Where you start before the layout is final.' },
    { id: 'ring-1x0p5', group: 'other', title: 'EuroSynth die on its 1x0p5 padring', art: 'ring', die: 'gds',
      files: ['eurosynth_1x0p5_die.gds', 'waferspace_1x0p5_padring_v0.1.kicad_mod'],
      blurb: 'EuroSynth, a synth chip taped out on the template in the half-height slot, with its art. On the 1x0p5 padring.' },
    { id: 'two-die', group: 'multi', title: 'wafer.space die beside a RAM die', art: 'two', die: 'gds', wired: true,
      files: ['two_die.wb.svg'],
      blurb: 'Two die on one board: twelve wires straight across from die to die, and the RAM\'s supply wires to its own lands.' },
    { id: 'stacked', group: 'multi', title: 'RAM die stacked on the wafer.space die', art: 'stack', die: 'gds', wired: true,
      files: ['stacked_die.wb.svg'],
      blurb: 'The same RAM, turned and glued on top: twelve wires down the step to the logo die, and its supply wires over it to the board.' },
  ];
  const REPO_URL = BRAND.url;   // the published repo: the format, the examples and this app's source
  const EXAMPLE_GROUPS = {
    ws: ['wafer.space 1x1', 'The gf180mcu project template die, with the wafer.space logo: 3.93 × 5.12 mm, 74 pads'],
    other: ['Other slots', 'The same die in another slot size'],
    multi: ['Several die', 'The logo die and a made-up RAM die, side by side and stacked, wired to each other and to the board'],
  };
  app.examples = EXAMPLES;
  // A small drawing of what an example holds: a land ring or a board, and a die with artwork (GDS) or only pads (footprint).
  function exampleArt(ex) {
    if (ex.art === 'two') return twoDieArt();
    if (ex.art === 'stack') return stackedArt();
    const lands = [], pads = [];
    for (let i = 0; i < 7; i++) {
      const t = 22 + i * 9.3;
      lands.push(`<rect x="${t}" y="12" width="4" height="9"/><rect x="${t}" y="69" width="4" height="9"/>`);
      if (i < 5) { const s = 26 + i * 9.6; lands.push(`<rect x="12" y="${s - 2}" width="9" height="4"/><rect x="99" y="${s - 2}" width="9" height="4"/>`); }
    }
    for (let i = 0; i < 6; i++) { const t = 41 + i * 7.8; pads.push(`<rect x="${t}" y="30" width="3" height="3"/><rect x="${t}" y="57" width="3" height="3"/>`); }
    for (let i = 0; i < 3; i++) { const s = 38.5 + i * 6.5; pads.push(`<rect x="36" y="${s}" width="3" height="3"/><rect x="81" y="${s}" width="3" height="3"/>`); }
    const board = ex.art === 'board' ? '<rect class="pcb" x="2" y="3" width="116" height="84" rx="6"/><rect class="part" x="104" y="6" width="9" height="5"/><rect class="part" x="7" y="79" width="5" height="5"/>' : '';
    const art = ex.die === 'gds' ? '<rect class="art" x="45" y="38" width="30" height="14" rx="1"/><circle class="logo" cx="42" cy="39" r="2.4"/>' : '';
    const wires = ex.wired ? Array.from({ length: 6 }, (_, i) => `<line x1="${42.5 + i * 7.8}" y1="31.5" x2="${28.6 + i * 9.3}" y2="20"/><line x1="${42.5 + i * 7.8}" y1="58.5" x2="${28.6 + i * 9.3}" y2="70"/>`).join('') : '';
    return `<svg class="exart" viewBox="0 0 120 90" aria-hidden="true">${board}<g class="lands">${lands.join('')}</g><g class="wires">${wires}</g><rect class="die ${ex.die}" x="33" y="27" width="54" height="36" rx="1.5"/>${art}<g class="pads">${pads.join('')}</g></svg>`;
  }
  // Two die side by side: lands round three sides of the first, wires straight across to the second, and its own lands.
  function twoDieArt() {
    const lands = [], pads = [], wires = [];
    for (let i = 0; i < 5; i++) {
      const x = 12 + i * 8, px = 24 + i * 6;
      lands.push(`<rect x="${x}" y="8" width="3.5" height="9"/><rect x="${x}" y="73" width="3.5" height="9"/>`);
      pads.push(`<rect x="${px}" y="23" width="2.2" height="2.2"/><rect x="${px}" y="64.8" width="2.2" height="2.2"/>`);
      wires.push(`<line x1="${px + 1.1}" y1="24.1" x2="${x + 1.75}" y2="17"/><line x1="${px + 1.1}" y1="65.9" x2="${x + 1.75}" y2="73"/>`);
    }
    for (let i = 0; i < 6; i++) {
      const y = 27 + i * 7.2;
      lands.push(`<rect x="3" y="${y}" width="9" height="3.5"/>`);
      pads.push(`<rect x="21" y="${y + 0.65}" width="2.2" height="2.2"/>`);
      wires.push(`<line x1="22.1" y1="${y + 1.75}" x2="12" y2="${y + 1.75}"/>`);
    }
    for (let i = 0; i < 7; i++) {
      const y = 33 + i * 4;
      pads.push(`<rect x="48.8" y="${y}" width="2.2" height="2.2"/><rect x="69" y="${y}" width="2.2" height="2.2"/>`);
      wires.push(`<line class="d2d" x1="49.9" y1="${y + 1.1}" x2="70.1" y2="${y + 1.1}"/>`);
    }
    for (let i = 0; i < 3; i++) {
      const y = 35 + i * 8;
      lands.push(`<rect x="104" y="${y}" width="9" height="3.5"/>`);
      pads.push(`<rect x="86.8" y="${y + 0.65}" width="2.2" height="2.2"/>`);
      wires.push(`<line x1="87.9" y1="${y + 1.75}" x2="104" y2="${y + 1.75}"/>`);
    }
    for (const x of [74, 83]) {
      lands.push(`<rect x="${x}" y="14" width="3.5" height="9"/><rect x="${x}" y="67" width="3.5" height="9"/>`);
      pads.push(`<rect x="${x + 0.65}" y="30" width="2.2" height="2.2"/><rect x="${x + 0.65}" y="57.8" width="2.2" height="2.2"/>`);
      wires.push(`<line x1="${x + 1.75}" y1="31.1" x2="${x + 1.75}" y2="23"/><line x1="${x + 1.75}" y1="58.9" x2="${x + 1.75}" y2="67"/>`);
    }
    const banks = [[72, 34], [80, 34], [72, 46], [80, 46]].map(([x, y]) => `<rect class="bank" x="${x}" y="${y}" width="6" height="9"/>`).join('');
    return `<svg class="exart" viewBox="0 0 120 90" aria-hidden="true"><g class="lands">${lands.join('')}</g><g class="wires">${wires.join('')}</g>` +
      `<rect class="die gds" x="20" y="22" width="32" height="46" rx="1.5"/><rect class="art" x="26" y="37" width="20" height="16" rx="1"/><circle class="logo" cx="27" cy="31" r="2.4"/>` +
      `<rect class="die gds" x="68" y="29" width="22" height="32" rx="1.2"/>${banks}<g class="pads">${pads.join('')}</g></svg>`;
  }
  // A die stacked on another: one row of lands round the lower die, wires down the step to its pads on the right, and the
  // upper die's own wires out over it to lands between the lower die's.
  function stackedArt() {
    const lands = [], pads = [], wires = [], low = [], top = [];
    for (const y of [24, 32, 40, 48, 56, 64]) {
      lands.push(`<rect x="26" y="${y - 1.5}" width="8" height="3"/>`);
      low.push(`<rect x="41" y="${y - 1.1}" width="2.2" height="2.2"/>`);
      wires.push(`<line x1="42.1" y1="${y}" x2="34" y2="${y}"/>`);
    }
    for (const x of [46, 53, 60, 67, 74]) {
      lands.push(`<rect x="${x - 1.5}" y="4" width="3" height="8"/><rect x="${x - 1.5}" y="78" width="3" height="8"/>`);
      low.push(`<rect x="${x - 1.1}" y="14.8" width="2.2" height="2.2"/><rect x="${x - 1.1}" y="73" width="2.2" height="2.2"/>`);
      wires.push(`<line x1="${x}" y1="15.9" x2="${x}" y2="12"/><line x1="${x}" y1="74.1" x2="${x}" y2="78"/>`);
    }
    for (const y of [22, 68]) {
      lands.push(`<rect x="86" y="${y - 1.5}" width="8" height="3"/>`);
      low.push(`<rect x="76.8" y="${y - 1.1}" width="2.2" height="2.2"/>`);
      wires.push(`<line x1="77.9" y1="${y}" x2="86" y2="${y}"/>`);
    }
    for (const y of [34, 40, 46, 52, 58]) {
      low.push(`<rect x="76.8" y="${y - 1.1}" width="2.2" height="2.2"/>`);
      top.push(`<rect x="68.2" y="${y - 1.1}" width="2.2" height="2.2"/>`);
      wires.push(`<line class="d2d" x1="69.3" y1="${y}" x2="77.9" y2="${y}"/>`);
    }
    // the upper die's supply wires, between the lower die's
    for (const [x1, y1, x2, y2] of [[50.6, 36, 30, 36], [50.6, 52, 30, 52], [56.5, 31.6, 56.5, 8], [63.5, 58.4, 63.5, 82]]) {
      lands.push(x2 === 30 ? `<rect x="26" y="${y2 - 1.5}" width="8" height="3"/>` : `<rect x="${x2 - 1.5}" y="${y2 - 4}" width="3" height="8"/>`);
      top.push(`<rect x="${x1 - 1.1}" y="${y1 - 1.1}" width="2.2" height="2.2"/>`);
      wires.push(`<line class="stk" x1="${x1}" y1="${y1}" x2="${x2 === 30 ? 34 : x2}" y2="${y2 === 8 ? 12 : y2 === 82 ? 78 : y2}"/>`);
    }
    const banks = [[52, 33], [61, 33], [52, 46], [61, 46]].map(([x, y]) => `<rect class="bank" x="${x}" y="${y}" width="7" height="10"/>`).join('');
    return `<svg class="exart" viewBox="0 0 120 90" aria-hidden="true"><g class="lands">${lands.join('')}</g>` +
      `<rect class="die gds" x="39" y="13" width="42" height="64" rx="1.5"/><circle class="logo" cx="45" cy="21" r="2.4"/><g class="pads">${low.join('')}</g>` +
      `<rect class="die gds" x="49" y="30" width="22" height="30" rx="1.2"/>${banks}<g class="pads">${top.join('')}</g><g class="wires">${wires.join('')}</g></svg>`;
  }
  const exampleCard = ex => `<button class="excard" data-act="sample" data-sample="${ex.id}">${exampleArt(ex)}<span class="t"><b>${esc(ex.title)}</b><span>${esc(ex.blurb)}</span><span class="ext">${ex.files.map(f => esc(f).replace(/[_.]/g, '$&<wbr>')).join(' ')}</span></span></button>`;
  function renderExampleMenu() {
    $('sampleMenu').innerHTML = Object.entries(EXAMPLE_GROUPS).map(([g, [name]]) => `<h5>${esc(name)}</h5>` +
      EXAMPLES.filter(e => e.group === g).map(e => `<button data-act="sample" data-sample="${e.id}">${esc(e.title)}<small>${esc(e.files.join(', '))}</small></button>`).join('')).join('');
  }
  // samples/<id>.js lists an example's files, and each file is its own script in samples/files/, so a file several
  // examples share, such as the die, is fetched once.
  const addScript = src => new Promise((ok, bad) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = ok; s.onerror = () => { s.remove(); bad(new Error('missing')); };
    document.head.appendChild(s);
  });
  async function sampleScript(which) {
    const X = W.WBSVG;
    if (!(X.sampleData && X.sampleData[which])) await addScript('samples/' + encodeURIComponent(which) + '.js');
    await Promise.all(X.sampleData[which].map(name => X.sampleFiles && X.sampleFiles[name] ? null : addScript('samples/files/' + encodeURIComponent(name) + '.js')));
  }
  async function gunzip(b64) {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  async function loadSample(which) {
    const ex = EXAMPLES.find(e => e.id === which);
    if (!ex) return;
    busy('Opening ' + ex.title);
    try { await sampleScript(which); } catch (e) {
      busy(null);
      toast('This example isn\'t bundled in this copy. Run python app/make_samples.py.', 'err');
      return;
    }
    const files = await Promise.all(W.WBSVG.sampleData[which].map(async name => new File([await gunzip(W.WBSVG.sampleFiles[name])], name)));
    // One undo step, back to whatever was open before.
    await oneStep(async () => {
      await reset(true, true);
      await loadFiles(files.slice(0, -1), 'substrate');
      await loadFiles(files.slice(-1), 'die');
    });
  }

  /* ---- session: survives a reload, in this browser only ---- */
  const DB = 'wire-bond-bench', STORE = 'session';
  const openDb = () => new Promise((ok, bad) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
  let saveTimer = null, wiping = false;
  // Every edit ends here: it becomes an undo step at once, and reaches the browser's storage a moment later.
  function save() { commit(); persist(); }
  function persist() { if (wiping) return; clearTimeout(saveTimer); saveTimer = setTimeout(() => saveNow().catch(e => console.warn('session not saved', e)), 700); }
  async function saveNow() {
    const dies = [];
    for (const d of S.dies) {
      if (d.die && d.die.artCanvas && !d.die.artBlob) { const c = d.die.artCanvas; d.die.artBlob = await new Promise(r => c.toBlob(r, 'image/png')); }
      const die = d.die && Object.assign({}, d.die);
      if (die) delete die.artCanvas;
      dies.push({ id: d.id, die, gdsFile: d.gds.file, place: d.place, regime: d.regime, numberOffset: d.numberOffset, placeNote: d.placeNote, gdsOpts: d.gdsOpts, netOverride: d.netOverride, dieRemoved: d.dieRemoved, dieMode: d.dieMode, layers: d.layers, art3d: d.art3d });
    }
    const snap = { v: 2, substrate: S.substrate && { text: S.substrate.text, fileName: S.substrate.fileName, selected: S.substrate.selected }, dies, active: S.active, wires: S.wires, types: S.types, typeRules: S.typeRules, defaultType: S.defaultType, limits: Object.assign({}, S.limits), rules: S.rules, bond: S.bond, sidecars: S.sidecars, maxLand: S.maxLand, landSkip: S.landSkip, fidRole: S.fidRole, fidDatum: S.fidDatum };
    const db = await openDb();
    await new Promise((ok, bad) => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(snap, 'current'); t.oncomplete = ok; t.onerror = () => bad(t.error); });
    db.close();
  }
  async function restore() {
    let snap = null;
    try {
      const db = await openDb();
      snap = await new Promise((ok, bad) => { const r = db.transaction(STORE).objectStore(STORE).get('current'); r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
      db.close();
    } catch (e) { return false; }
    // A session saved before several die existed holds one die at the top level: it becomes the first slot, and its wires that die's.
    const saved = snap && (snap.dies || (snap.die || snap.substrate ? [Object.assign({ id: 'D1' }, snap)] : []));
    if (!snap || !(snap.substrate || saved.some(d => d.die))) return false;
    try {
      for (const k of ['types', 'typeRules', 'defaultType', 'limits', 'bond', 'sidecars', 'maxLand', 'landSkip']) if (snap[k] !== undefined) S[k] = snap[k];
      // A session from before the DRC rules has only limits, which the line above wrote into the rules. A newer one has the rules themselves.
      if (snap.rules) S.rules = DRC.normalise(snap.rules);
      S.dies = saved.map(o => {
        const d = newSlot(o.id);
        for (const k of ['die', 'regime', 'numberOffset', 'placeNote', 'netOverride', 'dieRemoved', 'dieMode', 'layers', 'art3d']) if (o[k] !== undefined) d[k] = o[k];
        if (o.place) d.place = Object.assign(d.place, o.place);
        if (o.gdsOpts) d.gdsOpts = o.gdsOpts;
        d.gds.file = o.gdsFile || null;
        return d;
      });
      S.active = snap.active && M.dieById(S, snap.active) ? snap.active : S.dies[0].id;
      if (snap.substrate) {
        const keepTypes = S.types;
        loadSubstrateText(snap.substrate.text, snap.substrate.fileName);
        S.types = keepTypes;
        S.landSkip = snap.landSkip || [];
        if (snap.fidRole) S.fidRole = snap.fidRole;
        if (snap.fidDatum !== undefined) S.fidDatum = snap.fidDatum;
        S.substrate.selected = snap.substrate.selected;
      }
      for (const d of S.dies) {
        if (!d.die) continue;
        d.die.placed = true;
        if (d.die.artBlob) {
          const bmp = await createImageBitmap(d.die.artBlob), c = document.createElement('canvas');
          c.width = bmp.width; c.height = bmp.height; c.getContext('2d').drawImage(bmp, 0, 0);
          d.die.artCanvas = c;
        }
        d.padBy = new Map(d.die.pads.map(p => [p.num, p]));
      }
      refreshLands();
      S.wires = snap.wires || [];
      for (const w of S.wires) if (w.die == null) w.die = S.dies[0].id;
      pruneWires();
      M.ensureUndefinedType(S);
      S.existingDie = null;
      return true;
    } catch (e) { console.warn('saved session unreadable', e); return false; }
  }
  // Start over empties the undo history too, so it can't be undone. Opening an example or a .wb.svg empties the session
  // the same way but keeps the history (keepHistory), so undo goes back to what was open before.
  async function reset(quiet, keepHistory) {
    if (!keepHistory) for (const d of S.dies) if (d.artToken) d.artToken.cancelled = true;
    clearTimeout(saveTimer);
    const opts = Object.assign({}, S.gdsOpts, { cell: null, padLayer: null, firstKey: null, removed: [], corner: 'auto', dir: 'ccw' });
    Object.assign(S, { substrate: null, dies: [newSlot('D1')], active: 'D1', sidecars: {}, lands: [], paddle: null, wires: [], boardWires: [], drawn: [], types: M.DEFAULT_TYPES(), rules: DRC.defaults(), bond: { mode: 'inner', mm: 0.2 }, landSkip: [], marks: [], fidRole: {}, fidDatum: null, existingDie: null, typeRules: [], defaultType: M.GENERIC });
    S.gdsOpts = opts;
    app.sel = app.selWire = app.flagged = app.flagId = app.preview = null;
    indexDie(); indexLands();
    if (!keepHistory) clearHistory();
    try { const db = await openDb(); await new Promise(ok => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).delete('current'); t.oncomplete = ok; t.onerror = ok; }); db.close(); } catch (e) { /* nothing saved */ }
    busy(null);
    plan.fitted = false;
    renderAll();
    plan.draw();
    if (!quiet) toast('Cleared.');
  }

  /* ---- undo and redo ----
     A step is the session as it stood after an edit saved, so every edit that saves is one step. A drag, or a slider, is one step,
     taken when it lets go. A step copies what the person can change. The board, each die and its artwork, and a loaded GDS are
     replaced rather than changed, so a step keeps them as they are, which is what makes loading a file cheap to undo. A die's pad
     list and pad nets are the exception, changed in place by a net or a removed pad, so a step keeps those too.
     Selection, the view, the zoom and what's shown aren't steps. Each step does remember the selection just before the edit
     that followed it, so undoing a delete selects the wires again.
     Work that takes several saves, such as opening an example or reading a GDS, is held as one step (oneStep), and undo
     waits for it. History lives in memory only: a reload starts a new one, and Start over empties it. */
  const HISTORY_MAX = 100, ART_MAX = 6;
  const hist = { steps: [], at: -1, hold: 0, selBefore: null };
  const SESSION_KEYS = ['wires', 'types', 'typeRules', 'defaultType', 'rules', 'bond', 'maxLand', 'landSkip', 'fidRole', 'fidDatum'];
  const SLOT_KEYS = ['id', 'place', 'regime', 'numberOffset', 'placeNote', 'gdsOpts', 'netOverride', 'dieRemoved', 'dieMode', 'layers', 'art3d'];
  const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o[k]]));
  // The selection, as positions in the wire list, so it can be found again in a step's copy of the wires.
  function selNow() {
    const at = new Map(S.wires.map((w, i) => [w, i])), ix = w => (at.has(w) ? at.get(w) : -1);
    return { wires: [...app.selWires].map(ix).filter(i => i >= 0), primary: ix(primaryWire), anchor: ix(app.anchor), sel: app.sel };
  }
  function capture() {
    const data = structuredClone({
      s: pick(S, SESSION_KEYS),
      dies: S.dies.map(d => Object.assign(pick(d, SLOT_KEYS), { nets: d.die ? d.die.pads.map(p => p.net) : null, placed: !!(d.die && d.die.placed) })),
    });
    return {
      data, key: JSON.stringify(data), sel: selNow(), active: S.active,
      substrate: S.substrate, selected: S.substrate ? S.substrate.selected : -1, existingDie: S.existingDie, sidecars: Object.assign({}, S.sidecars),
      dies: S.dies.map(d => ({ slot: d, die: d.die, pads: d.die && d.die.pads, gds: Object.assign({}, d.gds) })),
    };
  }
  function sameStep(a, b) {
    const side = Object.keys(a.sidecars);
    return a.key === b.key && a.substrate === b.substrate && a.selected === b.selected &&
      side.length === Object.keys(b.sidecars).length && side.every(k => a.sidecars[k] === b.sidecars[k]) &&
      a.dies.length === b.dies.length && a.dies.every((x, i) => x.slot === b.dies[i].slot && x.die === b.dies[i].die && x.pads === b.dies[i].pads);
  }
  function commit() {
    if (hist.hold || hist.at < 0) return;
    const step = capture(), top = hist.steps[hist.at];
    // Nothing that can be undone changed, as when another die is picked or the artwork finishes: keep the step, with what's newer.
    if (sameStep(step, top)) { top.active = step.active; top.dies.forEach((x, i) => { x.gds = step.dies[i].gds; }); return; }
    if (hist.selBefore) top.sel = hist.selBefore;
    hist.selBefore = null;
    hist.steps.splice(hist.at + 1, Infinity, step);
    // A die's picture can be tens of MB, and changing a layer or opening a file makes another, so history keeps only a few
    // pictures besides the ones showing. The oldest steps go first.
    const pictures = () => new Set(hist.steps.flatMap(s => s.dies.map(x => x.die && x.die.artCanvas).filter(Boolean))).size;
    while (hist.steps.length > 2 && (hist.steps.length > HISTORY_MAX || pictures() > ART_MAX + S.dies.length)) hist.steps.shift();
    hist.at = hist.steps.length - 1;
    historyButtons();
    dropStaleTol();
  }
  function clearHistory() { hist.steps = [capture()]; hist.at = 0; hist.selBefore = null; historyButtons(); }
  // Several saves, and whatever they wait for, as one step. Undo waits until it's done.
  async function oneStep(fn) {
    hist.hold++;
    historyButtons();
    try { return await fn(); } finally { hist.hold--; commit(); historyButtons(); }
  }
  function historyButtons() {
    const u = $('undoBtn'), r = $('redoBtn');
    if (u) u.disabled = hist.hold > 0 || hist.at <= 0;
    if (r) r.disabled = hist.hold > 0 || hist.at >= hist.steps.length - 1;
  }
  function stepTo(to) {
    if (to < 0 || to >= hist.steps.length || to === hist.at) return;
    if (hist.hold) { toast('Still working. Undo once it has finished.', 'warn'); return; }
    hist.at = to;
    dropStaleTol();
    const st = hist.steps[to], data = structuredClone(st.data);
    Object.assign(S, data.s);
    S.sidecars = Object.assign({}, st.sidecars);
    const newBoard = S.substrate !== st.substrate;
    if (newBoard) {
      S.substrate = st.substrate;
      S.boardWires = S.substrate && S.substrate.board.kind === 'board' ? K.boardWires(S.substrate.board) : [];
      boardLayersShown();
    }
    if (S.substrate) S.substrate.selected = st.selected;
    S.existingDie = st.existingDie;
    S.dies = st.dies.map((x, i) => {
      const d = x.slot, o = data.dies[i];
      for (const k of SLOT_KEYS) d[k] = o[k];
      d.die = x.die;
      Object.assign(d.gds, x.gds);
      if (d.die) { d.die.pads = x.pads; x.pads.forEach((p, j) => { p.net = o.nets[j]; }); d.die.placed = o.placed; }
      d.padBy = new Map(d.die ? d.die.pads.map(p => [p.num, p]) : []);
      return d;
    });
    S.active = M.dieById(S, st.active) ? st.active : S.dies[0].id;
    refreshLands();
    const w = i => S.wires[i] || null;
    setSel(new Set(st.sel.wires.map(w).filter(Boolean)), w(st.sel.primary), w(st.sel.anchor));
    app.sel = st.sel.sel;
    app.flagged = app.flagId = app.preview = null;
    plan.rubber = null;
    hist.selBefore = null;
    renderAll();
    if ($('drc').open) renderDrc();
    if (newBoard) { plan.fit(); if (app.mode === '3d') tilt.fit(); }
    historyButtons();
    persist();
  }
  const undo = () => stepTo(hist.at - 1), redo = () => stepTo(hist.at + 1);
  app.history = { undo, redo, can: () => ({ undo: !hist.hold && hist.at > 0, redo: !hist.hold && hist.at < hist.steps.length - 1, at: hist.at, steps: hist.steps.length, busy: hist.hold > 0 }) };

  /* ---- left panel ---- */
  const fieldNum = (label, bind, value, step, extra) => `<label class="field"><span>${label}</span><input type="number" data-bind="${bind}" value="${esc(value)}" step="${step || 'any'}" ${extra || ''}></label>`;
  // A small ⓘ for a longer explanation, from js/tips.js. Clicking it only shows the tip.
  const info = (key, about) => `<span class="info" role="button" tabindex="0" data-tip="${esc(key)}" aria-label="About ${esc(about)}">ⓘ</span>`;
  function renderLeft() {
    const sub = S.substrate, die = S.die;
    let h = '';

    // 1 substrate
    h += `<section class="step ${sub ? 'done' : ''}"><h3><span class="num">1</span>Substrate<small>a footprint, or a board holding one</small></h3><div class="body">
      <button class="drop" data-act="pick" data-role="substrate" data-drop="substrate">${sub ? `<b>${esc(sub.fileName)}</b><small>Drop another to replace it</small>` : `<b>Drop a .kicad_pcb or .kicad_mod</b><small>or click to choose</small>`}</button>`;
    if (sub) {
      if (sub.kind === 'board') {
        const opts = sub.board.fps.map((f, i) => ({ f, i })).filter(({ f }) => !f.wbKind && f.pads.some(p => p.type === 'smd'));
        h += `<label class="field"><span>Use footprint</span><select data-bind="substrateFp"><option value="-1" ${sub.selected < 0 ? 'selected' : ''}>Whole board: every front SMD pad</option>${opts.map(({ f, i }) => `<option value="${i}" ${sub.selected === i ? 'selected' : ''}>${esc(f.ref)} ${esc(f.name)} (${f.pads.length})</option>`).join('')}</select></label>`;
      }
      const named = S.lands.filter(l => l.net).length;
      h += `<div class="stats"><div data-tip="stat:lands"><b>${S.lands.length}</b><span>lands</span></div><div data-tip="stat:landNets"><b>${named}</b><span>with nets</span></div><div data-tip="stat:paddle"><b>${S.paddle ? fx(S.paddle.w, 1) + '×' + fx(S.paddle.h, 1) : 'none'}</b><span>paddle, mm</span></div></div>`;
      h += `<details class="more"><summary>What counts as a land</summary>${fieldNum('Longest side', 'maxLand', S.maxLand, 0.1, 'min="0.1"')}<div class="note">SMD pads on front copper, up to this many mm long. The biggest pad over that is the paddle. ${S.landSkip.length ? `<button class="link" data-act="unskipLands">Bring back ${S.landSkip.length} skipped</button>` : ''}</div></details>`;
      if (S.marks.length) {
        const by = r => S.marks.filter(m => m.role === r).length, al = by('align'), or = by('orient');
        h += `<div class="note" data-tip="stat:fids">Fiducials: <b>${al}</b> align${or ? `, <b>${or}</b> orient` : ''}, from ${S.marks.length} copper mark${S.marks.length === 1 ? '' : 's'} on the substrate. Click one in the plan to change how it's used.</div>`;
      }
      if (!S.lands.length) h += `<div class="warnline">No lands here. Try another footprint, or the whole board.</div>`;
      if (sub.kind === 'board') h += `<div class="note">${S.sidecars.pro ? 'Project file loaded: its design rules travel with the export.' : 'Add the .kicad_pro to keep the design rules in the export.'}</div>`;
    }
    h += `</div></section>`;

    // 2 die
    h += `<section class="step ${die ? 'done' : ''}"><h3><span class="num">2</span>Die<small>from a GDS or a footprint</small></h3><div class="body">
      ${S.dies.length > 1 ? dieList() : ''}
      <div class="seg" style="margin-bottom:7px"><button data-act="dieMode" data-mode="gds" class="${S.dieMode === 'gds' ? 'on' : ''}">From GDS</button><button data-act="dieMode" data-mode="footprint" class="${S.dieMode === 'footprint' ? 'on' : ''}">From footprint</button></div>`;
    if (S.dieMode === 'gds') {
      const f = die && die.source === 'gds' ? die.fileName : null;
      h += `<button class="drop" data-act="pick" data-role="die-gds" data-drop="die-gds">${f ? `<b>${esc(f)}</b><small>Drop another to replace it</small>` : `<b>Drop a .gds or .gds.gz</b><small>or click to choose</small>`}</button>`;
      if (die && die.source === 'gds') h += renderGdsControls();
    } else {
      const f = die && die.source === 'footprint' ? die.fileName : null;
      h += `<button class="drop" data-act="pick" data-role="die" data-drop="die">${f ? `<b>${esc(f)}</b><small>Drop another to replace it</small>` : `<b>Drop a .kicad_mod</b><small>or click to choose</small>`}</button>`;
      if (sub && sub.kind === 'board') {
        const opts = sub.board.fps.map((x, i) => ({ x, i })).filter(({ x, i }) => i !== sub.selected && x.wbKind !== 'wire' && x.wbKind !== 'type_library' && (x.pads.length || x.wbKind === 'die'));
        h += `<label class="field"><span>Or from board</span><select data-bind="dieFromBoard"><option value="">Choose…</option>${opts.map(({ x, i }) => `<option value="${i}" ${die && die.boardIndex === i ? 'selected' : ''}>${esc(x.ref)} ${esc(x.name)}</option>`).join('')}</select></label>`;
      }
      if (die && die.source === 'footprint') {
        h += dieStats(die);
        for (const n of die.info.notes) h += `<div class="warnline">${esc(n)}</div>`;
        h += `<div class="note">Outline from ${esc(die.info.outlineFrom)}.</div>`;
      }
    }
    if (sub && die && die.source === 'footprint' && sub.kind === 'footprint' && S.dies.length === 1) h += `<div class="note"><button class="link" data-act="swapRoles">Swap die and substrate</button></div>`;
    if (die) h += art3dControls(die);
    if (die) h += `<div class="note"><button class="link" data-act="addDie">Add another die</button></div>`;
    h += `</div></section>`;

    // 3 placement
    if (die) {
      const P = S.place, many = manyDies();
      h += `<section class="step done"><h3><span class="num">3</span>Placement${many ? ` of ${esc(S.active)}` : ''}</h3><div class="body">
        <div class="duo">${fieldNum('X, mm', 'place.x', fx(P.x, 4))}${fieldNum('Y, mm', 'place.y', fx(P.y, 4))}</div>
        <label class="field"><span>Rotation</span><select data-bind="place.rot">${[0, 90, 180, 270].map(a => `<option value="${a}" ${P.rot === a ? 'selected' : ''}>${a}° on the board</option>`).join('')}${[0, 90, 180, 270].includes(P.rot) ? '' : `<option selected value="${P.rot}">${fx(P.rot, 1)}°</option>`}</select></label>
        ${bottomControls(many)}
        <div class="duo">${fieldNum('Die, µm', 'place.thick', P.thick, 5, 'min="1"')}${P.on === 'custom' ? '' : fieldNum('Attach, µm', 'place.attach', P.attach, 5, 'min="0"')}</div>
        ${tolControls()}
        <div class="note">${S.placeNote ? `Centred on <b>${esc(S.placeNote.from)}</b>. ` : ''}Thickness is assumed. <button class="link" data-act="autoPlace">Place again</button></div>
        ${S.placeNote && S.placeNote.lengths.some(l => l.mm) ? `<div class="note" data-tip="place:lengths">Total wire by rotation: ${S.placeNote.lengths.map(l => `${l.rot}° ${fx(l.mm, 0)}`).join(', ')} mm</div>` : ''}
        <details class="more" ${S.bond.mode !== 'inner' || S.bond.mm !== 0.2 ? 'open' : ''}><summary>Where a wire ends on a land</summary>
          <label class="field"><span>Second bond ${info('info:secondBond', 'the second bond')}</span><select data-bind="bond.mode"><option value="inner" ${S.bond.mode === 'inner' ? 'selected' : ''}>In from the inner end</option><option value="centre" ${S.bond.mode === 'centre' ? 'selected' : ''}>Land centre</option></select></label>
          ${S.bond.mode === 'inner' ? `<label class="field"><span>Distance</span><input type="range" min="0" max="1" step="0.01" data-live="bond.mm" value="${S.bond.mm}"></label><div class="note"><output id="bondOut" data-tip="bond:out">${fx(S.bond.mm)}</output> mm from the inner end. This is open question 8 in the plan.</div>` : ''}
        </details>
      </div></section>`;
    }
    $('left').innerHTML = h;
  }
  // The die's placement tolerance: one number, and what it means with the datums it's measured from.
  function tolControls() {
    const me = slot(), t = M.tolOf(me);
    let h = `<label class="field" data-tip="bind:place.tol"><span>Tolerance ⌀, µm ${info('info:placeTol', 'the position tolerance')}</span><input type="number" data-bind="place.tol" value="${t || ''}" step="5" min="0" placeholder="none"></label>`;
    if (!t) return h;
    const D = M.datumMarks(S), n = M.tolPads(S, me).length;
    h += `<div class="note" id="tolWords" data-tip="place:tol">${n}× pads: position ⌀${fx(t, 0)} CZ | ${M.datumLetters(S).split(' ').join(' | ')}. A is the board's top face${D.length ? `; ${D.map(m => `${m.datum} is ${esc(m.id)}`).join(', ')}` : ''}. <a href="../docs/primer/gdt.html#box" target="_blank" rel="noopener" data-tip="top:gdt">How to read it</a></div>`;
    if (D.length < 2) h += `<div class="warnline">${D.length ? 'Only one copper mark is a datum.' : 'No copper mark is a datum.'} Click a fiducial in the plan and give it B or C, so the die's place is tied to the board.</div>`;
    const why = tolCheckWhy();
    h += `<div class="tools"><button class="btn small" data-act="tolCheck" id="tolCheckBtn" ${why ? 'disabled' : ''}>Check at the zone's edges</button></div>`;
    if (tolRun && tolRun.step === hist.steps[hist.at]) h += tolRun.html;
    return h;
  }
  /* ---- the checks again, with each die at the edges of its tolerance zone: M.zoneCheck ---- */
  let tolRun = null;   // the last check at the zone's edges: { step it was run on, html }. Any change or undo drops it.
  function tolCheckWhy() {
    if (!S.wires.length) return 'There are no wires to check yet.';
    return '';
  }
  function dropStaleTol() {
    if (!tolRun || tolRun.step === hist.steps[hist.at]) return;
    tolRun = null;
    const e = $('tolRun'); if (e) e.remove();
  }
  const um = v => v === Infinity ? 'none near' : fx(v, 0) + ' µm';
  async function tolCheck() {
    const why = tolCheckWhy();
    if (why) { toast(why, 'warn'); return; }
    const step = hist.steps[hist.at], btn = $('tolCheckBtn');
    if (btn) btn.disabled = true;
    let r;
    try {
      busy('Checking at the zone\'s edges');
      await new Promise(go => setTimeout(go, 0));   // so the busy line shows before the work starts
      r = M.zoneCheck(S);
    } finally { busy(null); if (btn) btn.disabled = false; }
    const many = r.zones.length > 1, who = z => many ? z.id + ' ' : '';
    const turns = r.zones.map(z => `${who(z)}±${fx(z.turn, 2)}°`).join(', ');
    const least = `Least at the edges: die edge ${um(r.least.edge)}, wire gap ${um(r.least.gap)}. The zone allows a turn of ${turns}.`;
    let html;
    if (!r.found.length) html = `<div class="note" id="tolRun" data-tip="zone:run"><b>Nothing gets worse</b> at the zone's edges. ${least}</div>`;
    else {
      const checks = new Set(r.found.map(f => f.id)).size, fails = r.found.some(f => f.status === 'fail');
      const shown = r.found.slice(0, 6).map(f => `<li class="${f.status === 'fail' ? 'err' : 'warn'}">${esc((many ? f.die + ' ' : '') + f.at)}: ${esc(f.label)}, ${esc(f.value)}</li>`).join('');
      html = `<div class="warnline" id="tolRun" data-tip="zone:run"><b>${checks} check${checks > 1 ? 's' : ''} ${fails ? 'fail or ' : ''}get${checks > 1 ? '' : 's'} worse</b> at the zone's edges. ${least}` +
        `<ul class="zoneout">${shown}${r.found.length > 6 ? `<li>and ${r.found.length - 6} more</li>` : ''}</ul></div>`;
    }
    tolRun = { step, html };
    renderLeft();
  }
  const sitsWords = d => d.place.on === 'custom' ? fx(M.dieBottom(S, d), 0) + ' µm' : M.dieSupport(S, d) ? 'on ' + d.place.on : 'on board';
  function dieList() {
    return `<div class="dielist" role="list">${S.dies.map(d => `<div class="dierow ${d.id === S.active ? 'on' : ''}" role="listitem" data-act="selectDie" data-id="${esc(d.id)}"><b>${esc(d.id)}</b><span${d.die ? ' data-tip="die:name"' : ''}>${d.die ? esc(d.die.name) : 'no file yet'}</span><small${d.die ? ' data-tip="die:sits"' : ''}>${d.die ? esc(sitsWords(d)) : ''}</small><button class="x" data-act="removeDie" data-id="${esc(d.id)}" aria-label="Remove ${esc(d.id)}">×</button></div>`).join('')}</div>`;
  }
  // Where the die's underside is. With one die it stays folded away unless someone has moved it off the board.
  function bottomControls(many) {
    const me = slot(), P = me.place, above = new Set(M.stackedOn(S, me).map(d => d.id));
    const others = placedDies().filter(d => d !== me && !above.has(d.id));
    const on = M.dieSupport(S, me) ? P.on : P.on === 'custom' ? 'custom' : 'board';
    const controls = `<label class="field"><span>Sits on ${info('info:sitsOn', 'Sits on')}</span><select data-bind="place.on"><option value="board" ${on === 'board' ? 'selected' : ''}>The board</option>${others.map(d => `<option value="${esc(d.id)}" ${on === d.id ? 'selected' : ''}>Top of ${esc(d.id)} (${esc(d.die.name)})</option>`).join('')}<option value="custom" ${on === 'custom' ? 'selected' : ''}>A custom height</option></select></label>
      ${on === 'custom' ? fieldNum('Underside, µm', 'place.customUm', fx(M.dieBottom(S, me), 1), 5, 'min="0"') : ''}
      <div class="note" id="dieHeights" data-tip="die:heights">Underside ${fx(M.dieBottom(S, me), 0)} µm, top ${fx(M.dieTop(S, me), 0)} µm above the board.${M.dieSupport(S, me) ? ` Follows ${esc(P.on)}.` : ''}</div>`;
    if (many || on !== 'board') return controls;
    return `<details class="more"><summary>Bottom of the die</summary>${controls}</details>`;
  }
  function dieStats(die) {
    const c = die.info.counts;
    return `<div class="stats"><div data-tip="stat:dieSize"><b>${fx(die.x1 - die.x0)}×${fx(die.y1 - die.y0)}</b><span>mm</span></div><div data-tip="stat:pads"><b>${die.pads.length}</b><span>pads</span></div><div data-tip="stat:named"><b>${die.pads.filter(p => p.net).length}</b><span>named</span></div></div>
      <div class="note mono" data-tip="stat:sides">bottom ${c.B}, right ${c.R}, top ${c.T}, left ${c.L}</div>`;
  }
  function renderGdsControls() {
    const die = S.die, o = S.gdsOpts, i = die.info;
    let h = dieStats(die);
    const cells = gds.lib ? gds.lib.choices : [{ name: o.cell }];
    h += `<label class="field"><span>Cell</span><select data-bind="gds.cell">${cells.slice(0, 60).map(c => `<option ${c.name === o.cell ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>`;
    h += `<label class="field"><span>Pad layer</span><select data-bind="gds.padLayer">${i.candidates.map(c => `<option value="${esc(c.key)}" ${c.key === i.padLayer ? 'selected' : ''}>${esc(c.key)}: ${c.modal === c.count ? c.count : c.modal + ' of ' + c.count} at ${esc(c.size)} µm</option>`).join('')}${i.candidates.length ? '' : '<option>none found</option>'}</select></label>`;
    const cornerText = { mark: `found <b>${esc(i.mark && i.mark.name)}</b>, ${i.corner}`, assumed: `no mark found, so <b>assumed ${i.corner}</b>`, labels: 'numbers read from the labels', set: `set to ${i.corner}` }[i.cornerSource];
    h += `<label class="field"><span>Pin 1 corner</span><select data-bind="gds.corner"><option value="auto" ${o.corner === 'auto' ? 'selected' : ''}>Auto</option>${['BL', 'BR', 'TR', 'TL'].map(k => `<option value="${k}" ${o.corner === k ? 'selected' : ''}>${{ BL: 'Bottom left', BR: 'Bottom right', TR: 'Top right', TL: 'Top left' }[k]}</option>`).join('')}</select></label>
      <label class="field"><span>Direction</span><select data-bind="gds.dir"><option value="ccw" ${o.dir === 'ccw' ? 'selected' : ''}>Counter-clockwise</option><option value="cw" ${o.dir === 'cw' ? 'selected' : ''}>Clockwise</option></select></label>
      <div class="note">Pin 1: ${cornerText}. ${o.firstKey ? `<button class="link" data-act="clearFirst">Pad 1 was set by hand; undo</button>` : 'Click a pad to set pad 1 by hand.'}</div>`;
    if (!die.pads.length) h += `<div class="warnline">No pads found. Try other size limits.</div>`;
    if (!i.netsFound) h += `<div class="note">No labels sit on the pads, so pads have numbers only. Wires still generate.</div>`;
    if (i.notes) for (const n of i.notes) h += `<div class="warnline">${esc(n)}</div>`;
    h += `<details class="more"><summary>How pads are found</summary>
      <div class="duo">${fieldNum('Min, µm', 'gds.minUm', o.minUm, 5, 'min="1"')}${fieldNum('Max, µm', 'gds.maxUm', o.maxUm, 5, 'min="1"')}</div>
      <label class="field wide" data-tip="bind:gds.peripheralOnly"><span><input type="checkbox" data-bind="gds.peripheralOnly" ${o.peripheralOnly ? 'checked' : ''}> Near the edge only (drops ${i.dropped.internal} internal)</span></label>
      <label class="field"><span>Pin 1 mark</span><input type="text" data-bind="gds.markText" value="${esc(o.markText)}"></label>
      ${o.removed.length ? `<div class="note"><button class="link" data-act="unremovePads">Bring back ${o.removed.length} removed pads</button></div>` : ''}
      <div class="note">Layers holding labels on pads: ${i.labelLayers.length ? esc(i.labelLayers.map(l => `${l.key} (${l.n})`).join(', ')) : 'none'}.</div>
    </details>`;
    if (S.layers) {
      h += `<details class="more"><summary>Artwork layers (${S.layers.filter(l => l.on).length} on)</summary>
        <label class="field"><span>Resolution</span><select data-bind="gds.artPx">${[1024, 2048, 4096, 8192].map(p => `<option value="${p}" ${o.artPx === p ? 'selected' : ''}>${p} px</option>`).join('')}</select></label>
        <div class="layerlist">${S.layers.map((L, k) => `<label data-tip="bind:layerOn"><input type="checkbox" data-bind="layerOn" data-k="${k}" ${L.on ? 'checked' : ''}><input type="color" data-bind="layerColour" data-k="${k}" value="${colourHex(L.colour)}" aria-label="Colour of ${esc(L.key)}"><span>${esc(L.key)}</span><small>${shortCount(L.count)}</small></label>`).join('')}</div>
        ${die.artMs ? `<div class="note">Drawn in ${fx(die.artMs / 1000, 1)} s.</div>` : ''}
      </details>`;
    }
    return h;
  }
  /* The artwork on the 3D die: on or off, and its two colours, which start as the artwork's own. A picture of one colour has nothing to paint. */
  function art3dControls(die) {
    const auto = die.artCanvas && X.artAutoColours(die.artCanvas);
    if (!auto) return '';
    const o = S.art3d;
    let h = `<label class="field wide" data-tip="bind:art3d.on"><span><input type="checkbox" data-bind="art3d.on" ${o.on ? 'checked' : ''}> Artwork on the 3D die</span></label>`;
    if (o.on) {
      h += `<div class="duo"><label class="field" data-tip="bind:art3d.base"><span>Die colour</span><input type="color" data-bind="art3d.base" value="${esc(o.base || auto.base)}"></label>`
        + `<label class="field" data-tip="bind:art3d.accent"><span>Accent</span><input type="color" data-bind="art3d.accent" value="${esc(o.accent || auto.accent)}"></label></div>`;
      if (o.base || o.accent) h += `<div class="note"><button class="link" data-act="art3dAuto">Use the artwork's own colours</button></div>`;
    }
    return h;
  }
  const shortCount = n => n >= 1e6 ? fx(n / 1e6, 1) + 'M' : n >= 1e3 ? fx(n / 1e3, 0) + 'k' : String(n);
  function colourHex(c) {
    if (c[0] === '#') return c;
    const t = document.createElement('canvas').getContext('2d');
    t.fillStyle = c;
    return t.fillStyle;
  }

  /* ---- right panel ---- */
  function renderRight() {
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === app.tab));
    app.checks = (S.die && S.wires.length) || manyDies() ? M.check(S) : null;
    if (app.checks && !app.checks.list.length) app.checks = null;
    const counts = { fail: 0, warn: 0 };
    if (app.checks) for (const c of app.checks.list) if (counts[c.status] !== undefined) counts[c.status]++;
    const cb = document.querySelector('#tabs [data-tab=checks]');
    cb.innerHTML = 'Checks' + (counts.fail ? `<span class="count bad">${counts.fail}</span>` : counts.warn ? `<span class="count warn">${counts.warn}</span>` : '');
    document.querySelector('#tabs [data-tab=wires]').innerHTML = 'Wires' + (S.wires.length ? `<span class="count">${S.wires.length}</span>` : '');
    const body = $('tabBody');
    const scroll = body.scrollTop, listFocused = !!document.activeElement && document.activeElement.matches('table.wires');
    body.innerHTML = { regimes: renderRegimes, checks: renderChecks, wires: renderWires, types: renderTypes }[app.tab]();
    body.scrollTop = scroll;
    // Keep keyboard focus on the wire list through a rebuild, so Ctrl+A and the arrows still reach it after a bulk edit.
    const list = listFocused && body.querySelector('table.wires');
    if (list) list.focus({ preventScroll: true });
    markPanel();
  }
  // Mark the selected wire in whichever tab is showing. Only classes change, so scroll and focus survive. Returns the first thing marked.
  function markPanel() {
    syncSel();
    const sel = app.selWires, body = $('tabBody');
    let first = null;
    const mark = (el, cls, on) => { el.classList.toggle(cls, on); if (on && !first) first = el; };
    if (app.tab === 'wires') body.querySelectorAll('tr[data-wire]').forEach(el => mark(el, 'on', sel.has(S.wires[+el.dataset.wire])));
    else if (app.tab === 'types') { const Ts = new Set([...sel].map(w => M.typeOf(S, w.type))); body.querySelectorAll('.type[data-type]').forEach(el => mark(el, 'on', Ts.has(S.types[+el.dataset.type]))); }
    else if (app.tab === 'checks') body.querySelectorAll('[data-check]').forEach(el => mark(el, 'hit', !!sel.size && app.checks.list.find(c => c.id === el.dataset.check).wires.some(w => sel.has(w))));
    return first;
  }
  // A wire picked in the 3D view shows up in the panel. Regimes has nothing per wire and Checks may not name this one, so those go to the Wires tab.
  function revealWire() {
    let el = markPanel();
    if (app.selWire && !el) { app.tab = 'wires'; renderRight(); el = markPanel(); }
    if (el) el.scrollIntoView({ block: 'nearest' });
  }
  // A regime covers the selected die, except the board's, which covers every die.
  function metricCells(m, die, all) {
    const miss = all ? placedDies().reduce((n, d) => n + d.die.pads.length, 0) - m.padsUsed : die.pads.length - (m.padsOn[S.active] || 0);
    return `<div class="metrics">
      <div data-tip="metric:wires"><b class="${miss ? 'warn' : ''}">${m.wires}</b>wires${miss > 0 ? `, ${miss} pads free` : ''}</div>
      <div data-tip="metric:total"><b>${m.estimate ? '≈' : ''}${fx(m.total, 1)}</b>total mm</div>
      <div data-tip="metric:longest"><b>${m.estimate ? '≈' : ''}${fx(m.longest)}</b>longest mm</div>
      <div data-tip="metric:cross"><b class="${m.cross ? 'bad' : ''}">${m.cross}</b>crossings</div>
      <div data-tip="metric:nets"><b class="${m.compared && m.agree < m.compared ? 'warn' : ''}">${m.compared ? m.agree + '/' + m.compared : 'n/a'}</b>nets agree</div>
    </div>`;
  }
  function renderRegimes() {
    if (!S.die || !S.lands.length) return `<p class="lead">Load a substrate and a die. Each way of pairing pads with lands then appears here with its wire count, length, crossings and net agreement, and one click uses it.</p>`;
    let h = `<p class="lead">Each row is a different way to decide which pad goes to which land. Hover to see its wires dashed, and click to use it. Moving the die keeps the pairs and recalculates the geometry.</p>`;
    if (manyDies()) h += `<p class="note" id="regimeFor">For <b>${esc(S.active)}</b> and the lands, except From the board, which covers every die. Wires of the other die and pinned wires stay.</p>`;
    for (const [k, R] of Object.entries(M.REGIMES)) {
      const r = app.regimes[k];
      if (!r) { h += `<div class="regime off"><header><b>${R.label}</b>${info('info:regime:' + k, R.label)}<span class="tag na" data-tip="tag:noRead">nothing to read</span></header><p>${R.what}</p></div>`; continue; }
      h += `<div class="regime ${S.regime === k ? 'on' : ''}" data-regime="${k}" role="button" tabindex="0"><header><b>${R.label}</b>${info('info:regime:' + k, R.label)}${S.regime === k ? '<span class="tag ok" data-tip="tag:inUse">in use</span>' : ''}</header><p>${R.what}</p>${metricCells(r.m, S.die, k === 'board')}`;
      if (k === 'number') h += `<label class="field" style="margin-top:6px"><span>Offset</span><input type="number" step="1" data-bind="numberOffset" value="${S.numberOffset}"></label>`;
      h += `</div>`;
    }
    h += `<div class="regime ${S.regime === 'manual' ? 'on' : ''}" data-regime="manual" role="button" tabindex="0"><header><b>By hand</b>${info('info:regime:manual', 'By hand')}${S.regime === 'manual' ? '<span class="tag ok" data-tip="tag:inUse">in use</span>' : ''}</header><p>Clear the generated wires and add your own with the Wire tool (W). Hand-placed wires and ends you drag are pinned, and survive changing regime.</p></div>`;
    return h;
  }
  function renderChecks() {
    if (!app.checks) return `<p class="lead">Checks run once there are wires.</p>`;
    let h = `<p class="lead">Limits come from the DRC rules, each labelled by how solid its source is, because no bonding house has given us any. A placeholder only ever warns. Click a row to mark its wires.</p>
      <div class="tools"><button class="btn small" data-act="openDrc">DRC rules…</button></div>`;
    for (const c of app.checks.list) {
      const label = { ok: 'pass', warn: 'look', fail: 'problem', info: 'info', na: 'not checked', off: 'off' }[c.status] + (c.notChecked ? `, ${c.notChecked} not checked` : '');
      // A row with a rule shows the rule's value as a shortcut, and its tier, so a warning from a placeholder doesn't read as an established violation.
      const g = c.rule ? DRC.get(S, c.rule) : null;
      const limit = g ? (c.status === 'off' ? '' : `<span class="limit">limit <input type="number" data-bind="drc.value" data-rule="${g.id}" value="${g.value}" step="any"> ${esc(g.unit)}</span>`)
        : c.limitKey ? `<span class="limit">limit <input type="number" data-bind="limit.${c.limitKey}" value="${S.limits[c.limitKey]}" step="any"> ${c.unit}</span>` : '';
      const tier = g ? tierTag(g.tier) : '';
      h += `<div class="check ${app.flagId === c.id ? 'on' : ''}" data-check="${c.id}"><header><b data-tip="check">${esc(c.label)}</b>${tier}<span class="tag ${c.status}" data-tip="status">${label}</span></header>
        <span class="val" data-tip="check:value">${esc(c.value)}</span>${limit}
        <small>${esc(c.detail ? c.detail.replace(/\.?$/, '. ') : '')}Source: ${esc(c.source)}${g ? `, ${esc(DRC.TIERS[g.tier].label.toLowerCase())}${g.changed ? `; your value, default ${g.def} ${esc(g.unit)}` : ''}` : ''}.</small></div>`;
    }
    if (!S.limits.moldUm) h += `<div class="check"><header><b data-tip="rule:globTop">Glob top height</b><span class="tag na" data-tip="status">off</span></header><span class="limit" style="margin-left:0">top at <input type="number" data-bind="limit.moldUm" value="0" step="any"> µm, 0 for none</span></div>`;
    return h;
  }

  /* ---- DRC rules panel: every rule, its value and switch, and the tier and source of its default. It sits apart from placement. ---- */
  const tierTag = t => `<span class="tier ${esc(t)}" data-tip="tier">${esc(DRC.TIERS[t].label)}</span>`;
  function renderDrc() {
    const body = $('drcBody');
    if (!body) return;
    const byRule = new Map(((app.checks && app.checks.list) || []).filter(c => c.rule).map(c => [c.rule, c]));
    const counts = {};
    for (const r of DRC.TABLE) counts[r.tier] = (counts[r.tier] || 0) + 1;
    let h = `<header class="drchead"><h2 id="drcTitle">DRC rules</h2>${info('info:drcLevels', 'how rules are applied')}<div class="grow"></div>
        <button class="btn small" data-act="drcReset">Reset to defaults</button>
        <button class="btn small" data-act="drcExport">Export JSON</button>
        <button class="btn small" data-act="drcImport">Import JSON</button>
        <button class="btn small ghost" data-act="closeDrc">Close</button></header>
      <p class="lead">Optional, and saved with the session. Change a value to try yours, switch a rule off, or load someone else's file. Each default says how solid its source is: ${Object.keys(DRC.TIERS).map(t => `${tierTag(t)} ${counts[t] || 0}`).join(' ')}. A placeholder only ever warns. Every number is drawn and sourced in <a href="../docs/wire_bond_design_rules.svg" target="_blank" rel="noopener" data-tip="drc:sheet">the spec sheet</a>, and explained for newcomers in <a href="../docs/primer/wire-bonding-primer.html#rules" target="_blank" rel="noopener" data-tip="drc:primer">the primer</a>.</p>`;
    let group = null;
    for (const r of DRC.TABLE) {
      const g = DRC.get(S, r.id), c = byRule.get(r.id);
      if (r.group !== group) { group = r.group; h += `<h3>${esc(group)}</h3>`; }
      const status = r.enforce === 'no' ? `<span class="tag na" data-tip="tag:notEnforced">not enforced yet</span>`
        : !g.on ? '<span class="tag off" data-tip="status">off</span>'
        : c ? `<span class="tag ${c.status}" data-tip="status">${{ ok: 'pass', warn: 'look', fail: 'problem', info: 'info', na: 'not checked', off: 'off' }[c.status]}</span>` : '<span class="tag na" data-tip="tag:nothingToCheck">nothing to check</span>';
      const src = r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener" data-tip="drc:source">${esc(r.source)}</a>` : esc(r.source);
      h += `<div class="drcrule ${g.on ? '' : 'off'}" data-drc="${r.id}">
        <span class="key" data-tip="drc:key">${esc(r.key)}</span>
        <div class="main"><div class="top"><b>${esc(r.name)}</b>${tierTag(g.tier)}${status}</div>
          <div class="meaning">${esc(r.meaning)}</div>
          <div class="meta">${r.enforce === 'no' ? `Not enforced yet: ${esc(r.why)}` : `Applies to: ${esc(r.affects)}${r.enforce === 'specified' ? ' Not checked on wires left to the bonder.' : ''}`}</div>
          <div class="meta">Default ${esc(r.value)} ${esc(r.unit)}, ${esc(DRC.TIERS[r.tier].label.toLowerCase())}: ${esc(r.condition)} Source: ${src}.${g.fromFile ? ` <b>Your file: ${esc(g.source)}.</b>` : g.changed ? ' <b>Changed here.</b>' : ''}</div></div>
        <div class="ctl"><input type="number" step="any" data-bind="drc.value" data-rule="${r.id}" value="${esc(g.value)}" aria-label="${esc(r.name)}"><span class="unit">${esc(r.unit)}</span>
          <label data-tip="bind:drc.on"><input type="checkbox" data-bind="drc.on" data-rule="${r.id}" ${g.on ? 'checked' : ''}> on</label></div></div>`;
    }
    body.innerHTML = h;
  }
  function afterRules() { afterEdit(); renderDrc(); }
  function renderWires() {
    if (!S.wires.length) return `<p class="lead">No wires yet.</p>`;
    let h = `<div class="tools"><button class="btn small" data-act="reassign">Reassign types by rule</button><button class="btn small" data-act="unpinAll">Unpin all</button></div><table class="wires" tabindex="0" aria-multiselectable="true" data-tip="wires:table"><thead><tr><th data-tip="col:num">#</th><th data-tip="col:pad">Pad</th><th data-tip="col:to">${manyDies() ? 'To' : 'Land'}</th><th data-tip="col:net">Net</th><th data-tip="col:type">Type</th><th data-tip="col:mm">mm</th></tr></thead><tbody>`;
    S.wires.forEach((w, i) => {
      const e = M.wireEnds(S, w);
      if (!e) return;
      const net = e.pad.net || M.farNet(e) || '', ends = M.wireLabels(S, e);
      // The pinned dot and the ≈ explain themselves on hover; the text stays as it was.
      const len = fxLen(w, e.len).replace(/^≈/, '<span data-tip="wires:estimate">≈</span>');
      h += `<tr data-wire="${i}"><td>${i + 1}${w.pinned ? ' <span data-tip="wires:pinned">●</span>' : ''}</td><td>${esc(ends.from)}</td><td>${esc(ends.to)}</td><td class="net"${net ? ' data-tip="wires:net"' : ''}>${esc(net)}</td><td><select data-bind="wireType" data-i="${i}">${typeOptions(w.type, true)}</select></td><td>${len}</td></tr>`;
    });
    const open = S.wires.some(w => M.isBonderChoiceWire(S, w)) ? `<p class="note">Generic: chosen to leave the wire and loop to the bonder. Undefined: nobody has said. ≈ is the straight distance from pad to land, as an estimate.</p>` : '';
    return h + `</tbody></table><p class="note">● pinned: placed or edited by hand, so it survives changing regime.</p><p class="note">Ctrl+click a row to add or remove it, Shift+click for a range, Ctrl+A for all, then change them together on the right.</p>${open}`;
  }
  function loopSvg(t) {
    const spans = S.wires.map(w => { const e = M.wireEnds(S, w); return e ? e.len * 1000 : 0; }).filter(Boolean).sort((a, b) => a - b);
    const span = spans.length ? spans[spans.length >> 1] : 1500, zTop = M.dieTop(S, slot());
    if (!M.parseMoves(t.moves, span)) return `<svg viewBox="0 0 300 64" aria-hidden="true" data-tip="type:loop"><text x="150" y="36" text-anchor="middle" fill="#ff6b6b" font-size="11">Can't read these moves</text></svg>`;
    const rev = t.dir === 'reverse', curve = M.loopCurve(t, span, rev ? zTop : -zTop).map(p => [rev ? span - p[0] : p[0], p[1] + (rev ? 0 : zTop)]);
    const maxZ = Math.max(zTop, ...curve.map(p => p[1])) * 1.1, sx = 280 / span, sz = 54 / maxZ;
    const x = v => 10 + v * sx, z = v => 60 - v * sz;
    const dieEnd = Math.min(span * 0.08, 150);
    return `<svg viewBox="0 0 300 64" preserveAspectRatio="none" role="img" aria-label="Loop shape of ${esc(t.name)}" data-tip="type:loop"><rect x="0" y="${z(zTop)}" width="${x(dieEnd)}" height="${60 - z(zTop)}" fill="#2b3a37"/><line x1="0" x2="300" y1="60" y2="60" stroke="#4e7971"/><polyline fill="none" stroke="${esc(t.colour || '#e8b84a')}" stroke-width="1.6" vector-effect="non-scaling-stroke" points="${curve.map(p => fx(x(p[0]), 1) + ',' + fx(z(p[1]), 1)).join(' ')}"/></svg>`;
  }
  function renderTypes() {
    let h = `<p class="lead">A wire type works like a pad type: a family and a few sizes, with custom moves as the escape hatch. One type fits any span. Below it, rules pick a type from a net name.</p>
      <p class="note" id="defaultNote">New wires get <b>${esc(M.typeLabel(S.defaultType))}</b>${S.typeRules.some(r => r.match) ? ', unless a rule below matches' : ''}. Change it under Rules.</p>
      <div class="tools"><button class="btn small" data-act="addType">Add a type</button><button class="btn small" data-act="reassign">Reassign wires by rule</button></div>`;
    S.types.forEach((t, i) => {
      const used = S.wires.filter(w => w.type === t.name).length;
      const defaultTag = t.name === S.defaultType ? '<span class="tag info" data-tip="tag:default">default</span> ' : '';
      if (M.isBonderChoice(t)) {
        const gen = M.isGenericType(t);
        const say = gen ? 'A decision: this pad goes to this land, and the person at the machine picks the wire and loop. Drawn solid along a plain arc that stands in for any loop. Lengths are estimates.'
          : 'Nobody has said anything about this wire beyond its pad and land, as on a board whose wires name no type. Drawn dashed along the same stand-in arc as Generic. Lengths are estimates.';
        h += `<div class="type" data-type="${i}" data-tip="${gen ? 'type:generic' : 'type:undefined'}"><div class="head"><span style="width:16px;height:0;border-top:2px ${gen ? 'solid' : 'dashed'} ${esc(t.colour)}" aria-hidden="true"></span><b>${esc(M.typeLabel(t.name))}</b><small>${defaultTag}<span data-tip="type:used">${used} wires</span></small></div>
          <p class="note">${say}</p></div>`;
        return;
      }
      h += `<div class="type" data-type="${i}"><div class="head"><input type="color" data-bind="type.colour" data-i="${i}" value="${colourHex(t.colour || '#e8b84a')}" aria-label="Colour"><input type="text" data-bind="type.name" data-i="${i}" value="${esc(t.name)}" aria-label="Name"><small>${defaultTag}<span data-tip="type:used">${used} wires</span> <button class="x" data-act="delType" data-i="${i}" aria-label="Delete">×</button></small></div>
        ${loopSvg(t)}
        <div class="grid">
          <label class="span2">Family<select data-bind="type.family" data-i="${i}">${Object.entries(M.FAMILIES).map(([k, f]) => `<option value="${k}" ${t.family === k ? 'selected' : ''}>${f.label}</option>`).join('')}</select></label>
          <label>Wire, µm<input type="number" data-bind="type.d" data-i="${i}" value="${t.d}" min="1" step="1"></label>
          <label>Metal<select data-bind="type.material" data-i="${i}">${['Au', 'Al', 'Cu', 'Ag'].map(m => `<option ${t.material === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
          <label class="span2">Bond<select data-bind="type.style" data-i="${i}">${['ball-wedge', 'wedge-wedge'].map(m => `<option ${t.style === m ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
          <label class="span2">First bond ${info('info:firstBond', 'First bond')}<select data-bind="type.dir" data-i="${i}"><option value="forward" ${t.dir === 'forward' ? 'selected' : ''}>on the die</option><option value="reverse" ${t.dir === 'reverse' ? 'selected' : ''}>on the land</option></select></label>
          ${t.family && t.family !== 'custom' ? `<label class="span2">Loop height, µm<input type="range" min="40" max="600" step="5" data-live="type.h" data-i="${i}" value="${t.h || 200}"></label><label class="span2">Top run, %<input type="range" min="0" max="60" step="1" data-live="type.p" data-i="${i}" value="${t.p === undefined ? 15 : t.p}"></label>` : ''}
          <label class="span4">Moves<input type="text" class="moves" data-bind="type.moves" data-i="${i}" value="${esc(t.moves)}"></label>
        </div></div>`;
    });
    h += `<h4 style="margin:12px 0 2px;color:var(--ink-high);font-size:13px">Rules</h4><p class="note" style="margin-top:0">First match wins. Patterns are regular expressions on the net name.</p>`;
    S.typeRules.forEach((r, i) => {
      h += `<div class="rule"><input type="text" data-bind="rule.match" data-i="${i}" value="${esc(r.match)}" aria-label="Net pattern"><select data-bind="rule.type" data-i="${i}">${typeOptions(r.type)}</select><button class="x" data-act="delRule" data-i="${i}" aria-label="Delete rule">×</button></div>`;
    });
    h += `<div class="rule"><input type="text" value="anything else" disabled aria-label="Default" data-tip="rule:else"><select data-bind="defaultType">${typeOptions(S.defaultType)}</select><button class="x" data-act="addRule" aria-label="Add rule">+</button></div>`;
    return h;
  }

  /* ---- inspector and loop ---- */
  // Several wires at once: each control sets every selected wire, and shows "mixed" where they differ.
  function renderBulk(el, ws) {
    const n = ws.length, types = new Set(ws.map(w => w.type)), one = types.size === 1 ? ws[0].type : null;
    const pinned = ws.filter(w => w.pinned).length, moved = ws.filter(w => w.padOff || w.landOff || w.toPadOff).length;
    el.innerHTML = `<h4>${n} wires selected</h4>
      <label class="field"><span>Type</span><select data-bind="selType">${one === null ? `<option value="" selected disabled>Mixed: ${types.size} types</option>` : ''}${typeOptions(one)}</select></label>
      <label class="bulkpin" data-tip="bind:bulkPin"><input type="checkbox" data-bind="bulkPin" ${pinned === n ? 'checked' : ''}> Pinned${pinned && pinned < n ? ` <small>mixed, ${pinned} of ${n}</small>` : ''}</label>
      <div class="acts" style="margin-top:7px"><button class="btn small" data-act="delWire">Delete ${n}</button>${moved ? `<button class="btn small" data-act="resetEnds">Reset ends${moved < n ? ` (${moved})` : ''}</button>` : ''}</div>
      <p class="note">Changes apply to every selected wire. Ctrl+click adds or removes one, Shift+click a range, Esc clears.</p>`;
    el.querySelector('[data-bind=bulkPin]').indeterminate = pinned > 0 && pinned < n;
  }
  const MARK_SHAPE = { cross: 'Plus', dot: 'Dot', square: 'Rectangle', mark: 'Shape' };
  function renderInspector() {
    const el = $('inspector');
    syncSel();
    const w = app.selWire, sel = app.sel;
    if (app.selWires.size > 1) { renderBulk(el, [...app.selWires]); return; }
    if (w) {
      const e = M.wireEnds(S, w);
      if (!e) { el.innerHTML = ''; return; }
      const a = M.padAngle(S, e), agree = M.endsAgree(e), ends = M.wireLabels(S, e);
      el.innerHTML = `<h4>Wire W${String(S.wires.indexOf(w) + 1).padStart(2, '0')}${w.pinned ? ' <span class="tag info" data-tip="tag:pinned">pinned</span>' : ''}</h4>
        <dl><dt data-tip="insp:from">From</dt><dd>${esc(ends.fromWords)} ${esc(e.pad.net || '')}</dd><dt data-tip="insp:to">To</dt><dd>${esc(ends.toWords)} ${esc(M.farNet(e) || '')}</dd><dt data-tip="insp:length">Length</dt><dd>${fxLen(w, e.len)} mm</dd><dt data-tip="insp:angle">Angle</dt><dd>${fx(a, 1)}° off normal</dd><dt data-tip="insp:nets">Nets</dt><dd>${agree === null ? 'not comparable' : agree ? 'agree' : 'disagree'}</dd></dl>
        <label class="field"><span>Type</span><select data-bind="selType">${typeOptions(w.type)}</select></label>
        <div class="acts" style="margin-top:7px"><button class="btn small" data-act="delWire">Delete</button>${w.padOff || w.landOff || w.toPadOff ? '<button class="btn small" data-act="resetEnds">Reset ends</button>' : ''}<button class="btn small" data-act="togglePin">${w.pinned ? 'Unpin' : 'Pin'}</button></div>
        <p class="note">Drag the white squares to move an end.</p>`;
      return;
    }
    if (sel && sel[0] === 'p') {
      const p = selectedPad();
      if (p) {
        const n = M.wiresOnPad(S, S.active, p.num).length;
        el.innerHTML = `<h4>${manyDies() ? esc(S.active) + ' pad' : 'Die pad'} ${esc(p.num)}</h4><dl><dt data-tip="insp:padSize">Size</dt><dd>${fx(p.w * 1000, 1)} × ${fx(p.h * 1000, 1)} µm</dd><dt data-tip="insp:edge">Edge</dt><dd>${{ B: 'bottom', R: 'right', T: 'top', L: 'left' }[p.side]}</dd><dt data-tip="insp:padWires">Wires</dt><dd>${n}</dd></dl>
          <label class="field"><span>Net</span><input type="text" data-bind="padNet" value="${esc(p.net || '')}" placeholder="none"></label>
          <div class="acts" style="margin-top:7px">${S.die.source === 'gds' ? '<button class="btn small" data-act="makeFirst">Make this pad 1</button>' : ''}<button class="btn small" data-act="removePad">Not a pad</button></div>`;
        return;
      }
    }
    if (sel && sel[0] === 'l') {
      const l = S.landBy.get(sel.slice(1));
      if (l) {
        const n = S.wires.filter(x => x.land === l.id).length;
        el.innerHTML = `<h4>Land ${esc(l.id)}</h4><dl><dt data-tip="insp:landNet">Net</dt><dd>${esc(l.net || 'none')}</dd><dt data-tip="insp:landSize">Size</dt><dd>${fx(l.w)} × ${fx(l.h)} mm</dd><dt data-tip="insp:footprint">Footprint</dt><dd>${esc(l.ref)}</dd><dt data-tip="insp:landWires">Wires</dt><dd>${n}</dd></dl>
          <div class="acts"><button class="btn small" data-act="skipLand">Not a land</button></div>`;
        return;
      }
    }
    if (sel && sel[0] === 'f') {
      const m = S.marks.find(x => x.id === sel.slice(1));
      if (m) {
        const roles = [['align', 'Align'], ['orient', 'Orient'], ['off', 'Not a fiducial']];
        el.innerHTML = `<h4>Copper mark ${esc(m.id)}${m.role !== 'off' ? ` <span class="tag ok" data-tip="tag:fid">${m.role}</span>` : ''}</h4>
          <dl><dt data-tip="insp:markShape">Shape</dt><dd>${MARK_SHAPE[m.shape]}, ${fx(m.w * 1000, 0)} × ${fx(m.h * 1000, 0)} µm</dd><dt data-tip="insp:markAt">Centre</dt><dd>${fx(m.cx, 3)}, ${fx(m.cy, 3)} mm</dd><dt data-tip="insp:markFrom">From</dt><dd>${{ copper: 'F.Cu shape', 'fiducial pad': 'KiCad fiducial pad', pad: 'Unnumbered pad' }[m.from]} in ${esc(m.ref)}</dd></dl>
          <div class="seg" style="margin-top:7px">${roles.map(([r, t]) => `<button data-act="fidRole" data-role="${r}" class="${m.role === r ? 'on' : ''}">${t}</button>`).join('')}</div>
          <p class="note">${m.role === m.auto ? 'As its shape suggests.' : `Your pick. Its shape suggests ${m.auto === 'off' ? 'not using it' : m.auto}.`} A fiducial goes in the .wb.svg as board copper, for the bonder to find the board by.</p>
          ${m.role === 'off' ? '' : `<h5 style="margin:10px 0 0">Datum ${info('info:datum', 'datums')}</h5><div class="seg" style="margin-top:5px">${[['', 'None'], ['B', 'B'], ['C', 'C']].map(([k, t]) => `<button data-act="fidDatum" data-k="${k}" class="${(m.datum || '') === k ? 'on' : ''}">${t}</button>`).join('')}</div>
          <p class="note">${S.fidDatum ? 'Your pick.' : 'B and C start on the two align marks farthest apart.'}${M.anyTol(S) ? '' : ' Used once a die has a position tolerance.'}</p>`}`;
        return;
      }
    }
    el.innerHTML = `<h4>Nothing selected</h4><p class="note" style="margin-top:0">Click a pad, a land, a copper mark or a wire. With the Wire tool, click a pad and then a land${manyDies() ? ', or a pad on another die,' : ''} to add one.</p>`;
  }
  // The pad in app.sel, which is always on the selected die: picking a pad selects its die.
  function selectedPad() {
    const sel = app.sel;
    if (!sel || sel[0] !== 'p') return null;
    const k = sel.indexOf('\t');
    return sel.slice(1, k) === S.active ? S.padBy.get(sel.slice(k + 1)) : null;
  }
  function currentLoopWire() {
    if (app.selWire && M.wireEnds(S, app.selWire)) return app.selWire;
    let best = null, d = -1;
    for (const w of S.wires) { const e = M.wireEnds(S, w); if (e && e.len > d) { d = e.len; best = w; } }
    return best;
  }
  function renderLoop() {
    const w = currentLoopWire();
    V.drawLoop($('loop'), S, w, w && M.wireEnds(S, w));
  }
  function renderShow() {
    const sub = S.substrate;
    let h = `<h5>In the plan</h5>` + [['art', 'Die artwork'], ['labels', 'Numbers on pads and lands'], ['wires', 'Wires'], ['board', 'Board']].map(([k, t]) => `<label data-tip="bind:show:${k}"><input type="checkbox" data-bind="show" data-k="${k}" ${plan.show[k] ? 'checked' : ''}> ${t}</label>`).join('');
    if (sub && sub.layerNames.length) h += `<h5>Board layers</h5>` + sub.layerNames.map(n => `<label data-tip="bind:layerVis"><input type="checkbox" data-bind="layerVis" data-k="${esc(n)}" ${plan.vis[n] !== false ? 'checked' : ''}> ${esc(n === '*' ? 'Vias' : n)}</label>`).join('');
    $('showMenu').innerHTML = h;
  }
  function renderEmpty() {
    const none = !S.substrate && !placedDies().length;
    $('empty').hidden = !none;
    if (!none) return;
    if ($('empty').childElementCount) return;   // it doesn't change, and rebuilding it would drop a hover or focus
    const groups = Object.entries(EXAMPLE_GROUPS).map(([g, [name, about]]) => `<div class="exgroup"><h3>${esc(name)}<small>${esc(about)}</small></h3>
      <div class="excards">${EXAMPLES.filter(e => e.group === g).map(exampleCard).join('')}</div></div>`).join('');
    $('empty').innerHTML = `<div class="welcome">
      <div class="hero">
        <img class="herologo" src="brand/wirebond-logo.svg" alt="${esc(BRAND.name)}" width="256" height="64">
        <h1>Wire bond layout for KiCad</h1>
        <p class="lede">Place a bare die on the board it bonds to, lay out every wire, check them against bonding design rules, and send the assembly back to KiCad with 3D wires and a bond diagram. It all runs in this browser, and your files stay on your computer.</p>
        <div class="row"><button class="btn primary big" data-act="pick" data-role="">Choose files</button><a class="btn ghost big" href="../docs/primer/wire-bonding-primer.html" target="_blank" rel="noopener" data-tip="top:primer">New to wire bonding? Read the primer</a></div>
        <small class="droptip">Or drop a .gds, .kicad_pcb, .kicad_mod or .wb.svg anywhere on the page. Each part works on its own, and a .wb.svg opens whole, ready to edit.</small>
      </div>
      <div class="flow">
        <div><b><i>1</i>Substrate</b><span>A KiCad footprint, or a whole board and the footprint in it. Its project and schematic come along too.</span><span class="ext">.kicad_mod .kicad_pcb</span></div>
        <div><b><i>2</i>Die</b><span>A GDS gives the outline, pads, net names and artwork. A footprint works before the layout is done.</span><span class="ext">.gds .gds.gz .kicad_mod</span></div>
        <div><b><i>3</i>Wire and check</b><span>Pair pads with lands by number, net, geometry or the board's own wires, then edit by hand. Every wire is checked against sourced rules.</span><span class="ext">plan · 3D · loop profile</span></div>
        <div><b><i>4</i>Export</b><span>Your board with the die and wires added, or a bondlist and a true-scale .wb.svg diagram that any browser opens.</span><span class="ext">.kicad_pcb .kicad_mod .csv .wb.svg</span></div>
      </div>
      <h2>Open an example</h2>
      ${groups}
      <footer class="status"><b>Early release.</b> The <a class="link" href="${REPO_URL}/blob/main/SPEC.md" target="_blank" rel="noopener">wirebond.svg format</a> is a v0.2 draft, and no layout from this app has been bonded yet. Rule limits are for comparing layouts, not for sign-off.
        <span class="repolinks"><a class="link" href="${REPO_URL}" target="_blank" rel="noopener">The project on GitHub</a> · <a class="link" href="${REPO_URL}/tree/main/examples" target="_blank" rel="noopener">Example files</a> · <a class="link" href="${REPO_URL}/issues" target="_blank" rel="noopener">Report a problem</a></span>
        <span class="madewith" data-tip="brand:credit"><img src="brand/wirebond-icon.svg" alt="" width="22" height="22"><span>${esc(BRAND.app)} is part of <a class="link" href="${REPO_URL}" target="_blank" rel="noopener">${esc(BRAND.name)}</a>, by ${esc(BRAND.author)}. ${esc(BRAND.license)} licence.</span></span></footer>
    </div>`;
  }
  function renderAll() {
    computeRegimes();
    renderLeft(); renderRight(); renderInspector(); renderLoop(); renderShow(); renderEmpty();
    $('exportBtn').disabled = !placedDies().length;
    plan.draw(); tilt.draw();
  }

  /* ---- events from the plan view ---- */
  app.hideTip = () => { $('tip').hidden = true; };
  app.showTip = (h, x, y) => {
    const tip = $('tip');
    let t = '';
    if (h && h.kind === 'pad') t = `<b>${manyDies() ? esc(h.slot.id) + ' pad' : 'Pad'} ${esc(h.pad.num)}</b> ${esc(h.pad.net || '')}<small>${fx(h.pad.w * 1000, 0)} × ${fx(h.pad.h * 1000, 0)} µm, ${M.wiresOnPad(S, h.slot.id, h.pad.num).length} wires</small>`;
    else if (h && h.kind === 'land') t = `<b>Land ${esc(h.land.id)}</b> ${esc(h.land.net || '')}<small>${fx(h.land.w)} × ${fx(h.land.h)} mm</small>`;
    else if (h && h.kind === 'mark') { const m = h.mark; t = `<b>${esc(m.id)}</b> ${m.role === 'off' ? 'copper mark' : m.role + ' fiducial'}<small>${MARK_SHAPE[m.shape]}, ${fx(m.w * 1000, 0)} × ${fx(m.h * 1000, 0)} µm. Click to choose how it's used.</small>`; }
    else if (h && h.kind === 'wire') { const e = M.wireEnds(S, h.w), ends = M.wireLabels(S, e); t = `<b>W${String(S.wires.indexOf(h.w) + 1).padStart(2, '0')}</b> ${esc(M.typeLabel(h.w.type))}<small>${esc(ends.fromWords)} to ${esc(ends.toWords)}, ${fxLen(h.w, e.len)} mm</small>`; }
    if (!t) { tip.hidden = true; return; }
    tip.innerHTML = t; tip.hidden = false;
    tip.style.left = Math.min(x + 14, W.innerWidth - 310) + 'px'; tip.style.top = y + 14 + 'px';
  };
  app.status = (x, y) => { $('coord').textContent = `${fx(x, 3)}, ${fx(y, 3)} mm`; };
  let liveFrame = null;
  app.onGeometry = live => {
    plan.draw(); tilt.draw(); renderLoop();
    if (live) {
      if (liveFrame) return;
      liveFrame = requestAnimationFrame(() => { liveFrame = null; if (app.tab === 'checks') renderRight(); renderInspector(); });
    } else { computeRegimes(); renderLeft(); renderRight(); renderInspector(); save(); }
  };
  app.onClick = (h, ev) => {
    // Ctrl+click on a wire, in either view, adds it to the selection or takes it out, as in the Wires list. A plain click selects it alone.
    if (ev && (ev.ctrlKey || ev.metaKey) && h && h.kind === 'wire') {
      toggleWire(h.w); app.sel = null; selChanged();
      if (app.mode === '3d') revealWire();
      return;
    }
    if (plan.tool === 'wire' && app.mode === 'plan') {
      if (!h || (h.kind !== 'pad' && h.kind !== 'land')) { plan.rubber = null; plan.draw(); return; }
      const R = plan.rubber;
      // A pad to a land, or a pad to a pad on another die. Which end is clicked first says nothing about which is bonded first.
      const toLand = R && R.kind !== h.kind, toPad = R && h.kind === 'pad' && R.kind === 'pad' && R.slot !== h.slot;
      if (toLand || toPad) {
        let w;
        if (toPad) w = M.mkDieWire(S, R.slot.id, R.pad, h.slot.id, h.pad, { pinned: true });
        else {
          const from = h.kind === 'pad' ? h : R, land = h.kind === 'land' ? h.land : R.land;
          w = { die: from.slot.id, pad: from.pad.num, land: land.id, type: M.typeFor(S, from.pad.net || land.net), pinned: true };
        }
        S.wires.push(w);
        plan.rubber = null;
        app.selWire = w; app.sel = null;
        computeRegimes(); renderRight(); renderInspector(); renderLoop(); plan.draw(); save();
        return;
      }
      const at = h.kind === 'pad' ? M.dieToBoard(h.slot.place, h.pad.x, h.pad.y) : [h.land.x, h.land.y];
      plan.rubber = { kind: h.kind, pad: h.pad, land: h.land, slot: h.slot, at };
      plan.draw();
      return;
    }
    app.selWire = null; app.sel = null;
    // Picking a pad or a die's body selects that die, so the panels can act on it. With one die, that changes nothing.
    if (h && h.slot && h.slot.id !== S.active) selectDie(h.slot.id);
    if (h && h.kind === 'wire') app.selWire = h.w;
    else if (h && h.kind === 'pad') app.sel = 'p' + M.padKey(h.slot.id, h.pad.num);
    else if (h && h.kind === 'land') app.sel = 'l' + h.land.id;
    else if (h && h.kind === 'mark') app.sel = 'f' + h.mark.id;
    renderInspector(); renderLoop(); plan.draw(); tilt.draw();
    if (app.mode === '3d') revealWire(); else markPanel();
  };
  /* ---- selecting several wires, the way a desktop list does ---- */
  function selChanged() { renderInspector(); renderLoop(); plan.draw(); tilt.draw(); markPanel(); }
  function toggleWire(w) {
    const set = new Set(app.selWires);
    if (set.has(w)) set.delete(w); else set.add(w);
    setSel(set, set.has(w) ? w : primaryWire, w);
  }
  // The wires in the order the Wires table shows them, or in list order when it isn't showing.
  function listedWires() {
    const rows = app.tab === 'wires' ? [...$('tabBody').querySelectorAll('tr[data-wire]')] : [];
    return rows.length ? rows.map(r => S.wires[+r.dataset.wire]) : S.wires.filter(w => M.wireEnds(S, w));
  }
  // A click on a row: plain selects it alone, Ctrl toggles it, Shift selects from the anchor to it, and Ctrl+Shift adds that range.
  function pickRow(w, ev) {
    const ctrl = ev.ctrlKey || ev.metaKey, rows = listedWires();
    if (ev.shiftKey && app.anchor && rows.includes(app.anchor)) {
      const a = rows.indexOf(app.anchor), b = rows.indexOf(w);
      const set = ctrl ? new Set(app.selWires) : new Set();
      for (const x of rows.slice(Math.min(a, b), Math.max(a, b) + 1)) set.add(x);
      setSel(set, w);
    } else if (ctrl) toggleWire(w);
    else app.selWire = w;
    app.sel = null;
  }
  // Up and Down move through the list, and with Shift stretch the range from the anchor.
  function stepRow(dir, shift) {
    const rows = listedWires();
    if (!rows.length) return;
    const at = rows.indexOf(app.selWire), next = rows[at < 0 ? (dir > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, at + dir))];
    if (shift && app.anchor && rows.includes(app.anchor)) pickRow(next, { shiftKey: true });
    else app.selWire = next;
    app.sel = null;
    selChanged();
    const tr = $('tabBody').querySelector(`tr[data-wire="${S.wires.indexOf(next)}"]`);
    if (tr) tr.scrollIntoView({ block: 'nearest' });
  }
  function selectAllWires() { const rows = listedWires(); setSel(new Set(rows), app.selWire || rows[0], app.anchor || rows[0]); app.sel = null; selChanged(); }
  function selectDie(id) {
    if (id === S.active || !M.dieById(S, id)) return;
    S.active = id;
    app.sel = null;
    computeRegimes(); renderLeft(); renderRight(); renderInspector(); plan.draw(); tilt.draw(); save();
  }
  app.selectDie = selectDie;
  // Change the selected die's placement. Whatever sits on it goes with it.
  app.setPlace = changes => {
    const was = Object.assign({}, S.place);
    Object.assign(S.place, changes);
    carryStack(slot(), was);
  };

  /* ---- actions ---- */
  function rotateDie(deg) {
    const [cx, cy] = M.dieToBoard(S.place, ...M.dieCentre(S.die));
    const rot = ((deg % 360) + 360) % 360, [ax, ay] = K.rot(...M.dieCentre(S.die), rot);
    app.setPlace({ rot, x: cx - ax, y: cy - ay });
  }
  function download(name, content, type) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: type || 'text/plain' });
    const url = URL.createObjectURL(blob), a = $('dl');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function manifest(slotD) {
    const d = slotD.die, P = slotD.place;
    const stack = manyDies() ? { id: slotD.id, sits_on: M.dieSupport(S, slotD) ? P.on : P.on === 'custom' ? 'custom' : 'board', bottom_um: M.dieBottom(S, slotD) } : {};
    return JSON.stringify(Object.assign({ made_with: BRAND.credit, name: d.name, source: d.source, file: d.fileName, w_mm: d.x1 - d.x0, h_mm: d.y1 - d.y0, thickness_um_assumed: P.thick, attach_um_assumed: P.attach }, stack, { pad_layer: d.info.padLayer || null, pin1: d.info.cornerSource ? { corner: d.info.corner, source: d.info.cornerSource, direction: d.info.dir } : null, pads: d.pads.map(p => ({ num: p.num, net: p.net, side: p.side, x_mm: +p.x.toFixed(6), y_mm: +p.y.toFixed(6), w_um: +(p.w * 1000).toFixed(3), h_um: +(p.h * 1000).toFixed(3) })) }), null, 1);
  }
  // The note in every zip this app writes: what it is, and where it came from.
  function zipReadme(what) {
    return [`${what}`, '', `${BRAND.credit}`, `${BRAND.app} lays out wire bonds for KiCad, in the browser: ${BRAND.site}`,
      `The ${BRAND.name} format, the Python tools and the source: ${BRAND.url}`, `(c) ${BRAND.author}, ${BRAND.license} licence.`, ''].join('\r\n');
  }
  // A file name for each die: its own name, unless two die share one.
  function dieFileNames() {
    const dies = placedDies(), names = new Map();
    const count = n => dies.filter(d => X.safe(d.die.name) === n).length;
    for (const d of dies) { const n = X.safe(d.die.name); names.set(d, count(n) > 1 ? `${n}_${X.safe(d.id)}` : n); }
    return names;
  }
  /* The die footprints on their own, for a footprint library. With the 3D model, each carries its die as a STEP
     embedded in it, built from the thickness and attach under Placement, so KiCad shows it with nothing beside it. */
  function footprints(with3d) {
    const dies = placedDies(), names = dieFileNames();
    const fp = d => X.dieFootprintFile(d.die, { name: names.get(d), step: with3d ? X.dieStep(d.die, d.place.thick, d.place.attach, names.get(d), d.art3d) : undefined });
    const model = with3d ? ' and its 3D model embedded' : '';
    if (dies.length === 1) {
      const name = names.get(dies[0]);
      download(name + '.kicad_mod', fp(dies[0]));
      toast(`Wrote ${name}.kicad_mod, with ${dies[0].die.pads.length} numbered pads${model}. Add it to a footprint library.` + (with3d ? ' Thickness in the 3D model is assumed.' : ''));
      return;
    }
    const files = {};
    for (const d of dies) files[`wbsvg_die.pretty/${names.get(d)}.kicad_mod`] = fp(d);
    files['README.txt'] = zipReadme(`${dies.length} die footprints${model}, as a KiCad footprint library: add wbsvg_die.pretty in KiCad's Footprint Libraries.`);
    download(with3d ? 'wbsvg_die_footprints_3d.zip' : 'wbsvg_die_footprints.zip', X.zip(files));
    toast(`Wrote ${dies.length} die footprints${model} in wbsvg_die.pretty. Add it as a footprint library.`);
  }
  const exporters = {
    fp() { footprints(false); },
    fp3d() { footprints(true); },
    kit() {
      const dies = placedDies(), names = dieFileNames(), lib = 'wbsvg_die.pretty', files = {};
      for (const d of dies) {
        const name = names.get(d);
        const step = X.dieStep(d.die, d.place.thick, d.place.attach, name, d.art3d);
        files[`${lib}/${name}.kicad_mod`] = X.dieFootprintFile(d.die, { step, name: dies.length > 1 ? name : undefined });
        files[`${name}.kicad_sym`] = X.symbolFile(d.die);
        files[`${name}.step`] = step;
        files[`${name}.die.json`] = manifest(d);
      }
      files['README.txt'] = zipReadme('A die kit for KiCad: each die\'s footprint in wbsvg_die.pretty with its 3D model embedded, its schematic symbol, the same 3D model as a loose STEP, and a JSON manifest of its pads.');
      download((dies.length > 1 ? 'wbsvg_die' : names.get(dies[0])) + '_kit.zip', X.zip(files));
      toast(dies.length > 1 ? `Wrote the die kit for ${dies.length} die. Thickness in the 3D models is assumed.` : `Wrote the die kit for ${names.get(dies[0])}. Thickness in the 3D model is assumed.`);
    },
    board() {
      if (!S.substrate) { toast('Load a substrate first. A board needs something to sit on.', 'err'); return; }
      const r = X.assemble(S);
      const base = X.safe(S.substrate.fileName.replace(/(\.wb)?\.[^.]+$/i, '')) + '_bonded';
      const files = {};
      // The STEP is in the board already. The loose copy is for mechanical CAD.
      for (const [k, v] of Object.entries(r.files)) files[k === 'assembly.kicad_pcb' ? base + '.kicad_pcb' : k === 'bond.step' ? base.replace(/_bonded$/, '_bond') + '.step' : k] = v;
      if (S.sidecars.pro) files[base + '.kicad_pro'] = S.sidecars.pro;
      if (S.sidecars.sch) files[base + '.kicad_sch'] = S.sidecars.sch;
      files['README.txt'] = zipReadme(`${base}.kicad_pcb is your board with the die, one footprint per bond wire and the wire type library added, and one STEP of the die and wires embedded in it. Open it in KiCad 10. The loose .step is the same model, for mechanical CAD.`);
      download(base + '.zip', X.zip(files));
      toast(`Wrote ${base}.zip: ${r.rows.length} wires on ${r.layer}. Unzip it and open the .kicad_pcb.`);
      if (S.substrate.kind === 'board' && !S.sidecars.pro) toast('No .kicad_pro was loaded, so KiCad will apply its default design rules to this copy.', 'warn');
      for (const n of r.notes) toast(n, 'warn');
    },
    bond() {
      const dies = placedDies();
      download((dies.length > 1 ? 'wbsvg_die' : X.safe(dies[0].die.name)) + '.bondlist.csv', X.bondlist(S), 'text/csv');
      toast('Wrote the bondlist.');
    },
    svg() {
      const name = svgName();
      download(name, X.wbSvg(S), 'image/svg+xml');
      toast(`Wrote ${name}. Open it in a browser and hover a wire, pad or land.`);
    },
  };
  function svgName() {
    const dies = placedDies();
    return (S.substrate ? X.safe(S.substrate.fileName.replace(/(\.wb)?\.[^.]+$/i, '')) : dies.length > 1 ? 'wbsvg_die' : X.safe(dies[0].die.name)) + '.wb.svg';
  }

  /* ---- Diagram view: the .wb.svg the export would write, as a drawing, as code or both, kept up to date as you work ----
     The drawing goes in a shadow root, so its <style> can't reach the app and its <title>s still hover as they do in a browser.
     Copy and Download use the same text, so what's shown is what's written. It's only built while the view is showing. */
  const diag = { text: '', svg: null, aspect: 1, base: 0, zoom: 1, pane: 'picture', needFit: true, codeFor: null, timer: 0 };
  const shows = (p, what) => p === 'both' || p === what;
  // The code view shortens embedded images, so a die's artwork doesn't bury the rest. Copy and Download keep them whole.
  const shortData = s => s.replace(/(data:[\w/+.-]+;base64,)([A-Za-z0-9+/=]{120,})/g, (m, head, b) => `${head}${b.slice(0, 48)}…[${Math.max(1, Math.round(b.length * 0.75 / 1024))} KB image, shortened in this view]`);
  function hiAttrs(raw) {
    let out = '', last = 0;
    for (const a of raw.matchAll(/([\w:.-]+)=("[^"]*"|'[^']*')/g)) {
      out += esc(raw.slice(last, a.index)) + `<span class="${a[1].startsWith('wb:') ? 'sx-wb' : 'sx-a'}">${esc(a[1])}</span>=<span class="sx-v">${esc(a[2])}</span>`;
      last = a.index + a[0].length;
    }
    return out + esc(raw.slice(last));
  }
  // Colours tags, attributes and values; wb: attributes, the data, stand out from the drawing's own.
  const hiSvg = src => src.replace(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/g, m => {
    if (m[0] !== '<') return esc(m);
    if (m.startsWith('<!--')) return `<span class="sx-c">${esc(m)}</span>`;
    const r = m.match(/^(<[/?]?)([^\s>/?]+)([\s\S]*?)(\/?\??>)$/);
    return r ? `<span class="sx-t">${esc(r[1] + r[2])}</span>${hiAttrs(r[3])}<span class="sx-t">${esc(r[4])}</span>` : `<span class="sx-t">${esc(m)}</span>`;
  });
  function sizeSvg() {
    const s = diag.svg;
    if (!s) return;
    const w = diag.base * diag.zoom;
    s.style.width = w + 'px'; s.style.height = w / diag.aspect + 'px';
  }
  function fitSvg() {
    const box = $('diagPicture');
    if (!diag.svg || !box.clientWidth) { diag.needFit = true; return; }
    diag.base = Math.max(60, Math.min(box.clientWidth - 2, (box.clientHeight - 2) * diag.aspect));
    diag.zoom = 1; diag.needFit = false;
    sizeSvg(); box.scrollTo(0, 0);
  }
  // Zoom by f about a point in the box, keeping that point under the pointer.
  function zoomSvg(f, cx, cy) {
    const box = $('diagPicture'), z0 = diag.zoom;
    if (!diag.svg) return;
    if (cx === undefined) { cx = box.clientWidth / 2; cy = box.clientHeight / 2; }
    diag.zoom = Math.min(60, Math.max(0.25, z0 * f));
    const k = diag.zoom / z0, x = box.scrollLeft + cx, y = box.scrollTop + cy;
    sizeSvg();
    box.scrollLeft = x * k - cx; box.scrollTop = y * k - cy;
  }
  // A new drawing keeps the zoom and scroll you had. Unzoomed, it refits, since a turned die or a new wire can change the crop.
  function showSvgPicture(text) {
    const box = $('diagPicture'), host = box.shadowRoot || box.attachShadow({ mode: 'open' });
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml'), bad = doc.querySelector('parsererror');
    const keep = [box.scrollLeft, box.scrollTop];
    diag.svg = null;
    if (bad) { host.innerHTML = `<p style="font:13px sans-serif;color:#a00;padding:16px">This SVG doesn't parse: ${esc(bad.textContent)}</p>`; return; }
    const svg = document.importNode(doc.documentElement, true);
    const vb = svg.viewBox.baseVal;
    diag.aspect = vb && vb.width && vb.height ? vb.width / vb.height : 1;
    svg.style.cssText = 'display:block;margin:0 auto;user-select:none';
    host.replaceChildren(svg);
    diag.svg = svg;
    if (diag.needFit || diag.zoom === 1) fitSvg();
    else { sizeSvg(); box.scrollTo(keep[0], keep[1]); }
  }
  function showSvgCode() {
    if (!shows(diag.pane, 'code') || diag.codeFor === diag.text) return;
    $('diagCode').innerHTML = hiSvg(shortData(diag.text));
    diag.codeFor = diag.text;
  }
  const diagShowing = () => app.mode === 'diagram';
  function queueDiagram() {
    if (!diagShowing()) return;
    clearTimeout(diag.timer);
    diag.timer = setTimeout(updateDiagram, 250);
  }
  function diagMessage(words) {
    const m = $('diagMsg');
    m.hidden = !words; m.textContent = words || '';
  }
  function updateDiagram() {
    clearTimeout(diag.timer);
    if (!diagShowing()) return;
    if (!placedDies().length) {
      diag.text = ''; diag.svg = null; diag.codeFor = null; diag.needFit = true;
      if ($('diagPicture').shadowRoot) $('diagPicture').shadowRoot.replaceChildren();
      $('diagCode').textContent = ''; $('diagMeta').textContent = '';
      diagMessage('Load a die to see its bond diagram. It follows every change you make, and is the file Bond diagram (.wb.svg) writes.');
      return;
    }
    let text;
    try { text = X.wbSvg(S); } catch (e) { console.error(e); diagMessage(`The diagram can't be drawn from this state yet: ${e.message}`); return; }
    diagMessage(null);
    if (text === diag.text) return;
    diag.text = text;
    showSvgPicture(text);
    showSvgCode();
    const kb = new Blob([text]).size / 1024, now = new Date();
    $('diagMeta').textContent = `${svgName()} · ${text.split('\n').length} lines · ${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB · updated ${now.toLocaleTimeString()}`;
  }
  function setDiagPane(p) {
    diag.pane = p;
    document.querySelectorAll('#diagTools [data-act=diagPane]').forEach(b => b.classList.toggle('on', b.dataset.tab === p));
    document.querySelectorAll('#diagTools [data-show]').forEach(e => { e.hidden = !shows(p, e.dataset.show); });
    $('diagBox').classList.toggle('both', p === 'both');
    $('diagPicture').hidden = !shows(p, 'picture');
    $('diagCode').hidden = !shows(p, 'code');
    showSvgCode();
    // The picture's box changed size: refit, keeping any zoom.
    if (shows(p, 'picture') && diag.svg) { const z = diag.zoom, was = diag.needFit; fitSvg(); if (!was) { diag.zoom = z; sizeSvg(); } }
  }
  function flashBtn(id, words) {
    const b = $(id);
    if (!b.dataset.words) b.dataset.words = b.textContent;
    b.textContent = words;
    clearTimeout(b._flash);
    b._flash = setTimeout(() => { b.textContent = b.dataset.words; }, 1400);
  }
  function bindDiagram() {
    const box = $('diagPicture');
    box.addEventListener('wheel', ev => {
      if (!diag.svg) return;
      ev.preventDefault();
      const r = box.getBoundingClientRect();
      zoomSvg(ev.deltaY < 0 ? 1.2 : 1 / 1.2, ev.clientX - r.left, ev.clientY - r.top);
    }, { passive: false });
    let drag = null;
    box.addEventListener('pointerdown', ev => {
      if (ev.button !== 0) return;
      drag = { x: ev.clientX, y: ev.clientY, sl: box.scrollLeft, st: box.scrollTop };
      box.setPointerCapture(ev.pointerId); box.classList.add('drag');
    });
    box.addEventListener('pointermove', ev => {
      if (!drag) return;
      box.scrollLeft = drag.sl - (ev.clientX - drag.x); box.scrollTop = drag.st - (ev.clientY - drag.y);
    });
    const end = () => { drag = null; box.classList.remove('drag'); };
    box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
    $('diagWrap').addEventListener('change', ev => $('diagCode').classList.toggle('wrap', ev.target.checked));
    W.addEventListener('resize', () => {
      if (!diagShowing() || !diag.svg) return;
      const z = diag.zoom; fitSvg(); diag.zoom = z; sizeSvg();
    });
    // Nearly every change ends in a plan redraw, so that is what keeps the diagram current. It waits for a pause, and is
    // only built while showing.
    const draw = plan.draw.bind(plan);
    plan.draw = () => { draw(); queueDiagram(); };
  }
  const actions = {
    menu(el) { const m = $(el.dataset.menu), was = m.hidden; closeMenus(); m.hidden = !was; },
    sample: guarded(async el => { closeMenus(); await loadSample(el.dataset.sample); }),
    export(el) {
      closeMenus();
      if (!placedDies().length) { toast('Load a die first.', 'err'); return; }
      try { exporters[el.dataset.what](); } catch (e) { console.error(e); toast(e.message, 'err'); }
    },
    reset() { reset(); },
    pick(el) {
      const input = $('pickAny');
      input.dataset.role = el.dataset.role || '';
      input.accept = { substrate: '.kicad_pcb,.kicad_pro,.kicad_sch,.kicad_mod', 'die-gds': '.gds,.gds2,.gdsii,.gz', die: '.kicad_mod' }[el.dataset.role] || '.kicad_pcb,.kicad_pro,.kicad_sch,.kicad_mod,.gds,.gds2,.gdsii,.gz,.svg';
      input.value = '';
      input.click();
    },
    mode(el) {
      if (el.closest('#toolbar')) {
        app.mode = el.dataset.mode;
        document.querySelectorAll('#toolbar [data-act=mode]').forEach(b => b.classList.toggle('on', b === el));
        $('planBox').hidden = app.mode !== 'plan';
        $('tiltBox').hidden = app.mode !== '3d';
        $('diagBox').hidden = $('diagTools').hidden = app.mode !== 'diagram';
        // Hidden in 3D, keeping its place; taken out in the diagram view, so its own tools fit on the row.
        $('tools').style.visibility = app.mode === 'plan' ? '' : 'hidden';
        $('tools').hidden = app.mode === 'diagram';
        $('coord').hidden = app.mode !== 'plan';
        if (app.mode === '3d') { tilt.resize(); if (!tilt.fitted) { tilt.fit(); tilt.fitted = true; } }
        else if (app.mode === 'diagram') { setDiagPane(diag.pane); updateDiagram(); }
        else plan.resize();
      }
    },
    dieMode(el) { S.dieMode = el.dataset.mode; renderLeft(); },
    // A new die starts empty, selected, waiting for a file, and by hand: wires for it are the person's call.
    addDie() {
      const d = newSlot(nextDieId(), 'manual');
      S.dies.push(d);
      S.active = d.id;
      app.sel = null; app.preview = null;
      if (plan.rubber) { plan.rubber = null; plan.draw(); }
      renderAll(); save();
    },
    selectDie(el) { selectDie(el.dataset.id); },
    removeDie(el) {
      const d = M.dieById(S, el.dataset.id);
      if (!d) return;
      if (d.artToken) d.artToken.cancelled = true;
      // Whatever sat on it comes down to what it sat on, and says so.
      const under = M.dieSupport(S, d), moved = S.dies.filter(o => M.dieSupport(S, o) === d);
      for (const o of moved) o.place.on = under ? under.id : 'board';
      S.wires = S.wires.filter(w => !M.wireTouchesDie(S, w, d.id));
      S.dies = S.dies.filter(o => o !== d);
      if (!S.dies.length) S.dies = [newSlot('D1')];
      if (S.active === d.id) S.active = S.dies[S.dies.length - 1].id;
      app.sel = null; app.preview = null; app.flagged = null; app.flagId = null;
      syncSel();
      if (plan.rubber && plan.rubber.slot === d) plan.rubber = null;
      refreshLands();
      renderAll(); plan.fit(); save();
      toast(`Removed ${d.id} and its wires.` + (moved.length ? ` ${moved.map(o => o.id).join(', ')} now on ${under ? under.id : 'the board'}.` : ''));
    },
    tool(el) { setTool(el.dataset.tool); },
    rotate() { if (!S.die) return; rotateDie(S.place.rot + 90); app.onGeometry(false); },
    fit() { app.mode === 'plan' ? plan.fit() : app.mode === '3d' ? tilt.fit() : fitSvg(); },
    tab(el) { app.tab = el.dataset.tab; renderRight(); const m = markPanel(); if (m) m.scrollIntoView({ block: 'nearest' }); },
    tolCheck: guarded(tolCheck),
    autoPlace() {
      if (!S.die) return;
      const was = Object.assign({}, S.place), me = slot();
      M.autoPlace(S);
      carryStack(me, was);
      app.onGeometry(false); plan.fit();
    },
    swapRoles: stepped(async () => {
      const sub = S.substrate, die = S.die;
      const newDie = K.parseFootprintFile(sub.text).fps[0];
      if (!die.sourceText) { toast('Drop the two footprints again to swap them.', 'warn'); return; }
      loadSubstrateText(die.sourceText, die.fileName);
      await useFootprintDie(newDie, sub.fileName, { text: sub.text });
    }),
    art3dAuto() { S.art3d = Object.assign({}, S.art3d, { base: '', accent: '' }); renderLeft(); save(); },
    unskipLands() { S.landSkip = []; refreshLands(); renderAll(); save(); },
    unremovePads: stepped(async () => { S.gdsOpts.removed = []; if (await ensureGds()) { await rebuildGds(); finishDie(); } }),
    clearFirst: stepped(async () => { S.gdsOpts.firstKey = null; if (await ensureGds()) { await rebuildGds(); finishDie(); } }),
    makeFirst: stepped(async () => { const p = selectedPad(); if (!p) return; S.gdsOpts.firstKey = p.key; if (await ensureGds()) { await rebuildGds(); app.sel = null; finishDie(); } }),
    removePad: stepped(async () => {
      const p = selectedPad();
      if (!p) return;
      app.sel = null;
      if (S.die.source === 'gds') { S.gdsOpts.removed.push(p.key); if (await ensureGds()) { await rebuildGds(); finishDie(); } }
      else { S.dieRemoved.push(p.key); applyNetOverrides(S.die); finishDie(); }
    }),
    // How the selected copper mark is used. Picking what its shape suggests drops the pick, so it follows the shape again.
    fidRole(el) {
      const m = S.marks.find(x => app.sel === 'f' + x.id), r = el.dataset.role;
      if (!m || !/^(align|orient|off)$/.test(r)) return;
      if (r === m.auto) delete S.fidRole[m.id]; else S.fidRole[m.id] = r;
      applyMarkRoles(); renderLeft(); renderRight(); renderInspector(); plan.draw(); save();
    },
    // A datum letter for the selected mark. A letter another mark had moves here; from then on the letters are as picked.
    fidDatum(el) {
      const m = S.marks.find(x => app.sel === 'f' + x.id), k = el.dataset.k;
      if (!m || !/^[BC]?$/.test(k)) return;
      const cur = Object.fromEntries(S.marks.filter(x => x.datum).map(x => [x.datum, x.id]));
      for (const [q, id] of Object.entries(cur)) if (id === m.id) delete cur[q];
      if (k) cur[k] = m.id;
      S.fidDatum = cur;
      applyMarkRoles(); renderLeft(); renderRight(); renderInspector(); plan.draw(); save();
    },
    skipLand() { const l = S.landBy.get(app.sel.slice(1)); if (!l) return; S.landSkip.push(l.id); app.sel = null; refreshLands(); pruneWires(); renderAll(); save(); },
    // Every selected wire. There's no undo, so deleting more than one asks first.
    // Every selected wire, at once. Undo brings them back, selected.
    delWire() {
      const gone = app.selWires;
      S.wires = S.wires.filter(w => !gone.has(w)); app.selWire = null; afterEdit();
    },
    resetEnds() { for (const w of app.selWires) { delete w.padOff; delete w.landOff; delete w.toPadOff; } afterEdit(); },
    togglePin() { app.selWire.pinned = !app.selWire.pinned; afterEdit(); },
    reassign() { for (const w of S.wires) if (!w.pinned) { const e = M.wireEnds(S, w); if (e) w.type = M.typeFor(S, e.pad.net || M.farNet(e)); } afterEdit(); },
    unpinAll() { for (const w of S.wires) w.pinned = false; afterEdit(); },
    addType() { let k = 1; while (S.types.some(t => t.name === 'TYPE' + k)) k++; S.types.push({ name: 'TYPE' + k, family: 'trapezoid', style: 'ball-wedge', material: 'Au', d: 25, dir: 'forward', moves: '200/0 0/15%', h: 200, p: 15, interp: 'spline', colour: '#8ad6fa' }); renderRight(); save(); },
    // Wires of a deleted type take the default, and if that was the default, Generic becomes it.
    delType(el) { const t = S.types[+el.dataset.i]; if (M.isBonderChoice(t)) return; S.types.splice(+el.dataset.i, 1); if (S.defaultType === t.name || !S.types.some(o => o.name === S.defaultType)) S.defaultType = M.GENERIC; for (const w of S.wires) if (w.type === t.name) w.type = S.defaultType; afterEdit(); },
    delRule(el) { S.typeRules.splice(+el.dataset.i, 1); renderRight(); save(); },
    // DRC rules panel.
    openDrc() {
      closeMenus();
      const d = $('drc');
      if (!d.dataset.ready) {
        d.dataset.ready = '1';
        // Keys typed here are for the panel, not the plan's shortcuts. A click on the backdrop closes it.
        d.addEventListener('keydown', ev => ev.stopPropagation());
        d.addEventListener('click', ev => { if (ev.target === d) d.close(); });
        $('pickRules').addEventListener('change', async ev => {
          const f = ev.target.files[0];
          if (!f) return;
          try {
            const r = DRC.importJson(S, await f.text());
            afterRules();
            toast(`Loaded ${r.count} rules from ${f.name}.` + (r.unknown.length ? ` Left out ${r.unknown.length} this app doesn't know: ${r.unknown.slice(0, 4).join(', ')}.` : ''));
          } catch (e) { toast(`${f.name} isn't a rule set this app can read: ${e.message}`, 'err'); }
        });
      }
      renderDrc();
      if (!d.open) d.showModal();
    },
    closeDrc() { $('drc').close(); },
    // Diagram view.
    diagPane(el) { setDiagPane(el.dataset.tab); },
    diagZoom(el) { zoomSvg(el.dataset.what === 'in' ? 1.5 : 1 / 1.5); },
    async diagCopy() {
      updateDiagram();
      if (!diag.text) return;
      try { await navigator.clipboard.writeText(diag.text); }
      catch (e) {
        // No clipboard API (some file:// setups): copy through a hidden textarea.
        const t = document.createElement('textarea');
        t.value = diag.text; t.style.cssText = 'position:fixed;opacity:0';
        document.body.append(t); t.select(); document.execCommand('copy'); t.remove();
      }
      flashBtn('diagCopyBtn', 'Copied');
    },
    diagDownload() {
      updateDiagram();
      if (!diag.text) return;
      download(svgName(), diag.text, 'image/svg+xml'); flashBtn('diagDlBtn', 'Downloaded');
    },
    drcReset() {
      const changed = DRC.TABLE.some(r => { const g = DRC.get(S, r.id); return g.changed || g.on !== (r.on !== false) || g.fromFile; });
      if (changed && !W.confirm('Put every DRC rule back to its default?')) return;
      S.rules = DRC.defaults(); afterRules(); toast('DRC rules are back to their defaults.');
    },
    drcExport() { download('wbsvg_drc_rules.json', DRC.exportJson(S), 'application/json'); toast('Wrote wbsvg_drc_rules.json.'); },
    drcImport() { const i = $('pickRules'); i.value = ''; i.click(); },
    addRule() { S.typeRules.push({ match: '', type: S.types[0].name }); renderRight(); save(); },
    undo() { undo(); },
    redo() { redo(); },
  };
  function afterEdit() { computeRegimes(); renderRight(); renderInspector(); renderLoop(); plan.draw(); tilt.draw(); save(); }
  function finishDie() {
    indexDie(); pruneWires();
    if (S.regime !== 'manual') applyRegime(S.regime);
    computeRegimes(); renderAll(); save();
  }
  function closeMenus() { document.querySelectorAll('.menu').forEach(m => { m.hidden = true; }); }
  function setTool(t) {
    plan.tool = t; plan.rubber = null;
    document.querySelectorAll('#tools button').forEach(b => b.classList.toggle('on', b.dataset.tool === t));
    plan.draw();
  }

  /* ---- input bindings ---- */
  const needsGds = async fn => { if (await ensureGds()) await fn(); };
  const gdsBind = (key, value) => oneStep(async () => {
    S.gdsOpts[key] = value;
    await needsGds(async () => {
      if (key === 'cell') { await selectCell(value); S.die.fileName = gds.file ? gds.file.name : S.die.fileName; afterSources('die'); guarded(renderArt)(); return; }
      if (key === 'minUm' || key === 'maxUm') gds.cands = await G.padCandidates(gds.lib, gds.top, buildOptions(), ctlBusy('Looking for pads'));
      if (key === 'artPx') { await renderArt(true); renderLeft(); return; }
      if (key === 'corner' || key === 'dir') S.gdsOpts.firstKey = null;
      await rebuildGds();
      finishDie();
    });
  });
  const binds = {
    maxLand(v) { S.maxLand = +v; refreshLands(); pruneWires(); if (S.die && !S.die.placed) M.autoPlace(S); renderAll(); plan.fit(); save(); },
    substrateFp(v) { S.substrate.selected = +v; S.landSkip = []; refreshLands(); for (const d of placedDies()) d.die.placed = false; placeDies(); regenWires(); renderAll(); plan.fit(); save(); },
    dieFromBoard: stepped(async v => { if (v === '') return; const i = +v; await useFootprintDie(S.substrate.board.fps[i], S.substrate.fileName, { boardIndex: i }); }),
    numberOffset(v) { S.numberOffset = parseInt(v, 10) || 0; if (S.regime === 'number') applyRegime('number'); computeRegimes(); renderAll(); save(); },
    'place.x'(v) { app.setPlace({ x: +v }); app.onGeometry(false); },
    'place.y'(v) { app.setPlace({ y: +v }); app.onGeometry(false); },
    'place.rot'(v) { rotateDie(+v); app.onGeometry(false); },
    'place.thick'(v) { S.place.thick = Math.max(0, +v); app.onGeometry(false); },
    'place.tol'(v) { S.place.tol = Math.max(0, +v || 0); app.onGeometry(false); },
    'place.attach'(v) { S.place.attach = Math.max(0, +v); app.onGeometry(false); },
    'place.on'(v) {
      const me = slot(), P = S.place;
      // Switching to a custom height starts from where the die is now.
      if (v === 'custom') P.customUm = M.dieBottom(S, me);
      P.on = v;
      // Going on top of a die it isn't over at all: move it there. Anywhere else it already is over that die stays as it is.
      const sup = M.dieSupport(S, me);
      if (sup && !M.outlinesOverlap(me, sup)) {
        const [cx, cy] = M.dieToBoard(sup.place, ...M.dieCentre(sup.die)), [ax, ay] = K.rot(...M.dieCentre(S.die), P.rot);
        app.setPlace({ x: cx - ax, y: cy - ay });
        toast(`Moved ${me.id} to the middle of ${sup.id}. Drag it anywhere.`);
      }
      S.placeNote = null;
      app.onGeometry(false);
    },
    'art3d.on'(v, el) { S.art3d = Object.assign({}, S.art3d, { on: el.checked }); renderLeft(); save(); },
    'art3d.base'(v) { S.art3d = Object.assign({}, S.art3d, { base: v }); renderLeft(); save(); },
    'art3d.accent'(v) { S.art3d = Object.assign({}, S.art3d, { accent: v }); renderLeft(); save(); },
    'place.customUm'(v) { S.place.customUm = Math.max(0, +v); app.onGeometry(false); },
    'bond.mode'(v) { S.bond.mode = v; renderLeft(); app.onGeometry(false); },
    'gds.cell': guarded(v => gdsBind('cell', v)),
    'gds.padLayer': guarded(v => gdsBind('padLayer', v)),
    'gds.corner': guarded(v => gdsBind('corner', v)),
    'gds.dir': guarded(v => gdsBind('dir', v)),
    'gds.minUm': guarded(v => gdsBind('minUm', +v)),
    'gds.maxUm': guarded(v => gdsBind('maxUm', +v)),
    'gds.peripheralOnly': guarded((v, el) => gdsBind('peripheralOnly', el.checked)),
    'gds.markText': guarded(v => gdsBind('markText', v)),
    'gds.artPx': guarded(v => gdsBind('artPx', +v)),
    layerOn: stepped(async (v, el) => { S.layers[+el.dataset.k].on = el.checked; await needsGds(() => renderArt(true)); renderLeft(); }),
    layerColour: stepped(async (v, el) => { S.layers[+el.dataset.k].colour = v; await needsGds(() => renderArt(true)); }),
    show(v, el) { plan.show[el.dataset.k] = el.checked; plan.draw(); tilt.draw(); },
    layerVis(v, el) { plan.vis[el.dataset.k] = el.checked; plan.draw(); tilt.draw(); },
    wireType(v, el) { S.wires[+el.dataset.i].type = v; afterEdit(); },
    // Sets every selected wire, then recomputes once. Like a single change, it doesn't pin them.
    selType(v) { if (v && app.selWires.size) { for (const w of app.selWires) w.type = v; afterEdit(); } },
    bulkPin(v) { for (const w of app.selWires) w.pinned = v; afterEdit(); },
    padNet(v) {
      const p = selectedPad();
      if (!p) return;
      S.netOverride[p.key] = v.trim();
      p.net = v.trim() || null;
      computeRegimes(); renderLeft(); renderRight(); renderInspector(); save();
    },
    defaultType(v) { S.defaultType = v; renderRight(); save(); },
    // DRC rule values, from the panel or the shortcuts in Checks. An empty or unreadable number leaves the rule as it was.
    'drc.value'(v, el) { const n = parseFloat(v); if (v === '' || !Number.isFinite(n)) { renderDrc(); renderRight(); return; } S.rules[el.dataset.rule].value = n; afterRules(); },
    'drc.on'(v, el) { S.rules[el.dataset.rule].on = !!v; afterRules(); },
    ...Object.fromEntries(Object.keys(DRC.LIMIT_KEYS).map(k => ['limit.' + k, v => { S.limits[k] = v; afterRules(); }])),
    'rule.match'(v, el) { S.typeRules[+el.dataset.i].match = v; save(); },
    'rule.type'(v, el) { S.typeRules[+el.dataset.i].type = v; save(); },
    'type.colour'(v, el) { S.types[+el.dataset.i].colour = v; afterEdit(); },
    'type.name'(v, el) {
      const t = S.types[+el.dataset.i], name = v.trim();
      if (M.isBonderChoice(t)) { renderRight(); return; }
      if (!name || M.RESERVED_NAME.test(name) || S.types.some(o => o !== t && o.name === name)) { toast('A type needs a name of its own.', 'warn'); renderRight(); return; }
      for (const w of S.wires) if (w.type === t.name) w.type = name;
      for (const r of S.typeRules) if (r.type === t.name) r.type = name;
      if (S.defaultType === t.name) S.defaultType = name;
      t.name = name; afterEdit();
    },
    'type.family'(v, el) {
      const t = S.types[+el.dataset.i];
      t.family = v;
      if (v !== 'custom') { t.h = t.h || 200; t.p = t.p === undefined ? 15 : t.p; t.moves = M.FAMILIES[v].make(t.h, t.p); t.interp = v === 'jedec4' ? 'polyline' : 'spline'; }
      afterEdit();
    },
    'type.d'(v, el) { S.types[+el.dataset.i].d = Math.max(1, +v); afterEdit(); },
    'type.material'(v, el) { S.types[+el.dataset.i].material = v; afterEdit(); },
    'type.style'(v, el) { S.types[+el.dataset.i].style = v; afterEdit(); },
    'type.dir'(v, el) { S.types[+el.dataset.i].dir = v; afterEdit(); },
    'type.moves'(v, el) {
      const t = S.types[+el.dataset.i];
      if (!M.parseMoves(v, 1000)) { el.classList.add('bad-input'); toast('Moves are steps like 200/0 30/12%: rise over run, starting at the first bond.', 'warn'); return; }
      t.moves = v.trim(); t.family = 'custom'; afterEdit();
    },
  };
  function liveBind(el) {
    const key = el.dataset.live;
    if (key === 'bond.mm') { S.bond.mm = +el.value; const o = $('bondOut'); if (o) o.textContent = fx(S.bond.mm); app.onGeometry(true); }
    else if (key === 'type.h' || key === 'type.p') {
      const t = S.types[+el.dataset.i];
      t[key === 'type.h' ? 'h' : 'p'] = +el.value;
      t.moves = M.FAMILIES[t.family].make(t.h || 200, t.p === undefined ? 15 : t.p);
      const card = el.closest('.type'), fresh = document.createElement('div');
      fresh.innerHTML = loopSvg(t);
      card.querySelector('svg').replaceWith(fresh.firstChild);
      card.querySelector('.moves').value = t.moves;
      plan.draw(); tilt.draw(); renderLoop();
    }
  }

  /* ---- wiring up ---- */
  function bindDom() {
    document.addEventListener('click', ev => {
      const a = ev.target.closest('[data-act]');
      if (a) { const f = actions[a.dataset.act]; if (f) f(a); return; }
      const rg = ev.target.closest('[data-regime]');
      if (rg && !ev.target.closest('input')) { applyRegime(rg.dataset.regime); app.preview = null; renderAll(); save(); return; }
      const ck = ev.target.closest('[data-check]');
      if (ck && !ev.target.closest('input')) {
        const c = app.checks.list.find(x => x.id === ck.dataset.check);
        if (app.flagId === c.id) { app.flagId = null; app.flagged = null; } else { app.flagId = c.id; app.flagged = new Set(c.wires); }
        renderRight(); plan.draw();
        return;
      }
      const tr = ev.target.closest('tr[data-wire]');
      if (tr && !ev.target.closest('select')) {
        pickRow(S.wires[+tr.dataset.wire], ev);
        selChanged();
        tr.closest('table').focus({ preventScroll: true });
        return;
      }
      if (!ev.target.closest('.menu')) closeMenus();
    });
    // Before anything acts on a key or a press, note what's selected: if it turns out to be an edit, undoing it selects this again.
    for (const t of ['pointerdown', 'keydown']) document.addEventListener(t, () => { if (hist.at >= 0) hist.selBefore = selNow(); }, true);
    document.addEventListener('keydown', ev => {
      const k = ev.key.toLowerCase(), tag = ev.target.tagName;
      // Ctrl+Z undoes, and Ctrl+Y or Ctrl+Shift+Z redoes. In a text or number field they're the field's own, for its typing.
      const typing = tag === 'TEXTAREA' || (tag === 'INPUT' && !/^(checkbox|radio|range|color|button|file)$/.test(ev.target.type));
      if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && (k === 'z' || k === 'y') && !typing) {
        ev.preventDefault();
        if (k === 'y' || ev.shiftKey) redo(); else undo();
        return;
      }
      if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag)) { if (ev.key === 'Enter') ev.target.blur(); return; }
      if (k === ' ') { plan.spaceDown = true; ev.preventDefault(); return; }
      if (ev.target.dataset && ev.target.dataset.regime && k === 'enter') { ev.target.click(); return; }
      // In the Wires list: Ctrl+A selects every wire, and the arrows move, with Shift to stretch. Text fields returned above, so they keep Ctrl+A.
      const inList = ev.target.closest && ev.target.closest('table.wires');
      if (inList && (ev.ctrlKey || ev.metaKey) && k === 'a') { ev.preventDefault(); selectAllWires(); return; }
      if (inList && (k === 'arrowdown' || k === 'arrowup')) { ev.preventDefault(); stepRow(k === 'arrowdown' ? 1 : -1, ev.shiftKey); return; }
      if (k === 'v') setTool('select');
      else if (k === 'w') setTool('wire');
      else if (k === 'm') setTool('move');
      else if (k === 'f') actions.fit();
      else if (k === 'r') actions.rotate();
      else if (k === 'escape') { plan.rubber = null; app.selWire = null; app.sel = null; closeMenus(); renderInspector(); renderLoop(); plan.draw(); tilt.draw(); markPanel(); }
      else if (k === 'delete' || k === 'backspace') { if (app.selWire) actions.delWire(); }
    });
    document.addEventListener('keyup', ev => { if (ev.key === ' ') plan.spaceDown = false; });
    const handleChange = ev => {
      const el = ev.target, key = el.dataset.bind;
      if (!key || !binds[key]) return;
      binds[key](el.type === 'checkbox' ? el.checked : el.value, el);
    };
    document.addEventListener('change', handleChange);
    document.addEventListener('input', ev => { if (ev.target.dataset.live) liveBind(ev.target); });
    document.addEventListener('change', ev => { if (ev.target.dataset.live) { computeRegimes(); renderLeft(); renderRight(); save(); } });
    $('tabBody').addEventListener('mouseover', ev => {
      const r = ev.target.closest('[data-regime]');
      const next = r && app.regimes[r.dataset.regime] && S.regime !== r.dataset.regime ? app.regimes[r.dataset.regime].wires : null;
      if (next !== app.preview) { app.preview = next; plan.draw(); }
    });
    // A modified click on a row selects rows, not text.
    $('tabBody').addEventListener('mousedown', ev => {
      const row = ev.target.closest('tr[data-wire]');
      if (!row || ev.target.closest('select') || !(ev.shiftKey || ev.ctrlKey || ev.metaKey)) return;
      ev.preventDefault();
      row.closest('table').focus({ preventScroll: true });
    });
    $('tabBody').addEventListener('mouseleave', () => { if (app.preview) { app.preview = null; plan.draw(); } });
    $('pickAny').addEventListener('change', ev => {
      const role = ev.target.dataset.role;
      const files = [...ev.target.files];
      if (files.length) loadFiles(files, role === 'substrate' ? 'substrate' : role === 'die' ? 'die' : undefined);
    });
    // drops
    let depth = 0;
    W.addEventListener('dragenter', ev => { ev.preventDefault(); depth++; $('dropHint').hidden = false; });
    W.addEventListener('dragleave', ev => { depth = Math.max(0, depth - 1); if (!depth) $('dropHint').hidden = true; });
    W.addEventListener('dragover', ev => ev.preventDefault());
    W.addEventListener('drop', ev => {
      ev.preventDefault(); depth = 0; $('dropHint').hidden = true;
      const files = [...ev.dataTransfer.files];
      if (!files.length) return;
      const zone = ev.target.closest && ev.target.closest('[data-drop]');
      const role = zone ? zone.dataset.drop : null;
      loadFiles(files, role === 'substrate' ? 'substrate' : role === 'die' ? 'die' : undefined);
    });
    $('zExag').addEventListener('input', ev => { tilt.zExag = +ev.target.value; $('zExagOut').textContent = ev.target.value + '×'; tilt.draw(); });
    W.addEventListener('resize', renderLoop);
  }

  // A word in the console for anyone who opens it, as every file this app writes says where it came from.
  function hello() {
    const icon = 'data:image/svg+xml,' + encodeURIComponent(BRAND.icon);
    console.log(`%c %c${BRAND.app}%c  part of ${BRAND.name}
${BRAND.url}`,
      `background:url("${icon}") no-repeat center/contain;padding:14px 16px;margin-right:6px`,
      'color:#068770;font:600 15px "IBM Plex Sans",system-ui,sans-serif', 'color:#d93aa7;font:13px "IBM Plex Mono",monospace');
  }
  async function boot() {
    hello();
    plan = new V.PlanView($('plan'), app);
    tilt = new V.TiltView($('tilt'), app);
    app.plan = plan; app.tilt = tilt;
    // The welcome covers the stage and the bottom panel, and leaves the toolbar, which wraps on a narrow window, usable.
    new ResizeObserver(() => $('centre').style.setProperty('--toolbar-h', $('toolbar').offsetHeight + 'px')).observe($('toolbar'));
    renderExampleMenu();
    bindDom();
    bindDiagram();
    const had = await restore();
    clearHistory();
    renderAll();
    if (had) { plan.fit(); toast('Picked up where you left off. Start over clears it.'); }
    app.ready = true;
  }
  app.gds = gds;
  app.refresh = renderAll;
  app.saveNow = saveNow;
  app.tolCheckWhy = tolCheckWhy;
  app.loadFiles = loadFiles;
  boot();
})(window);
