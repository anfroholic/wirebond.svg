/* Python for the app: one way in, two places it runs.

   WBX.py.run(args, files) runs `wbx.py <args>` on the files given ({name: text or Uint8Array}) and resolves to
   { code, stdout, stderr, files: {name: Uint8Array}, backend }. Both backends call wbx.main with the same arguments
   in a folder holding just those files, so they give the same answer.

   - local: in this repo, `python serve.py` serves the app and runs wbx.py on this machine. Found by asking /py/ping.
   - pyodide: only in the standalone page build.py writes. That build adds js/py-pyodide.js and sets WBX_PY, and Python
     is downloaded the first time it's used, never on load.

   On file:// with no server, Python isn't available, and the app says how to get it. */
(function (W) {
  W.WBX = W.WBX || {};
  const C = W.WBX_PY || {};
  const HOW = 'Needs Python. In the repo, run python serve.py and open http://localhost:8765/app/. The standalone page runs it in the browser.';
  let found = null;
  const state = { name: null, why: 'Looking for Python.', python: '' };

  function b64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
  function unb64(s) { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }

  // Which backend this page has. Asked once, and the answer kept.
  function backend() {
    if (found) return found;
    found = (async () => {
      if (C.backend === 'pyodide' && W.WBX.pyodide) Object.assign(state, { name: 'pyodide', why: '', python: 'Pyodide ' + (C.version || '') });
      else if (/^https?:$/.test(location.protocol)) {
        try {
          const r = await fetch(new URL('/py/ping', location.href), { cache: 'no-store' });
          const j = r.ok && /json/.test(r.headers.get('Content-Type') || '') ? await r.json() : null;
          if (j && j.backend === 'local') Object.assign(state, { name: 'local', why: '', python: 'Python ' + j.python + ' on this machine' });
          else Object.assign(state, { name: null, why: HOW });
        } catch (e) { Object.assign(state, { name: null, why: HOW }); }
      } else Object.assign(state, { name: null, why: HOW });
      return state;
    })();
    return found;
  }

  async function run(args, files, onStatus) {
    const b = await backend(), status = onStatus || (() => {});
    if (!b.name) throw new Error(b.why);
    if (b.name === 'pyodide') return Object.assign(await W.WBX.pyodide.run(args, files || {}, status), { backend: 'pyodide' });
    const body = {};
    for (const [n, v] of Object.entries(files || {})) body[n] = typeof v === 'string' ? v : { b64: b64(v) };
    status('Running wbx.py ' + args[0]);
    const r = await fetch(new URL('/py/run', location.href), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ args, files: body }) });
    const j = await r.json().catch(() => ({ error: `serve.py answered ${r.status}` }));
    if (!r.ok || j.error) throw new Error(j.error || `serve.py answered ${r.status}`);
    const out = {};
    for (const [n, v] of Object.entries(j.files || {})) out[n] = unb64(v);
    return { code: j.code, stdout: j.stdout, stderr: j.stderr, files: out, backend: 'local' };
  }

  /* wbx.py check on a .wb.svg's text. Its output is the result as JSON, then NOTE, WARN and ERROR lines, then a count.
     Resolves to { ok, res, notes, warns, errors, failed, raw }: failed is set when wbx.py stopped before checking. */
  async function check(text, onStatus) {
    const raw = await run(['check', 'in.wb.svg'], { 'in.wb.svg': text }, onStatus);
    const lines = raw.stdout.replace(/\r/g, '').split('\n'), end = lines.indexOf('}');
    let res = null;
    // Python's json writes Infinity and NaN, which JSON doesn't have: 1e999 reads back as Infinity.
    const json = lines.slice(0, end + 1).join('\n').replace(/([:\[,]\s*)(-?)Infinity\b/g, '$1$21e999').replace(/([:\[,]\s*)NaN\b/g, '$1null');
    if (lines[0] === '{' && end > 0) try { res = JSON.parse(json); } catch (e) { res = null; }
    const rest = end > 0 ? lines.slice(end + 1) : lines, pick = k => rest.filter(l => l.startsWith(k + ' ')).map(l => l.slice(k.length + 1));
    const errors = pick('ERROR');
    const failed = res ? '' : (raw.stderr.trim().split('\n').pop() || `wbx.py check stopped with code ${raw.code}`);
    return { ok: !!res && raw.code === 0 && !errors.length, res, notes: pick('NOTE'), warns: pick('WARN'), errors, failed, raw };
  }

  W.WBX.py = { backend, run, check, state, how: HOW };
})(window);
