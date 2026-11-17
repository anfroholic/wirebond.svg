/* Python in the browser, for the standalone page only. build.py copies this into dist/app/js/ and sets WBX_PY before
   it: { backend: 'pyodide', version, indexURL, src (wbx.py's text), ezdxf (a package name or wheel URL) }.
   The dev app never loads this; there, js/py.js asks serve.py instead.

   Nothing is fetched until the first run. Then Pyodide and lxml load once, which is enough for check and place;
   export also loads ezdxf, the first time it's asked for. run() matches serve.py's: wbx.main on the given files, in a
   folder of their own, and back come the exit code, what it printed and the files it wrote. */
(function (W) {
  const C = W.WBX_PY;
  let ready = null, ezdxf = null, job = 0;

  function script(src) {
    return new Promise((ok, bad) => {
      const s = document.createElement('script');
      s.src = src; s.onload = ok; s.onerror = () => bad(new Error(`Couldn't load ${src}. Python needs a connection the first time.`));
      document.head.appendChild(s);
    });
  }
  // The same as `python wbx.py <args>`: exit code, stdout and stderr, and an uncaught error printed as a traceback.
  const RUNNER = `
import io, os, contextlib, traceback, wbx
def _wbx_run(args, d):
    o, e, here = io.StringIO(), io.StringIO(), os.getcwd()
    os.chdir(d)
    try:
        with contextlib.redirect_stdout(o), contextlib.redirect_stderr(e):
            try: code = wbx.main(list(args)) or 0
            except SystemExit as x: code = x.code if isinstance(x.code, int) else (0 if x.code is None else 1)
            except Exception: traceback.print_exc(); code = 1
    finally: os.chdir(here)
    return code, o.getvalue(), e.getvalue()
`;
  async function boot(status) {
    status('Loading Python, the first time only');
    const base = new URL(C.indexURL, location.href).href;   // the CDN, or pyodide/ beside the page when vendored
    if (!W.loadPyodide) await script(base + 'pyodide.js');
    const py = await W.loadPyodide({ indexURL: base });
    status('Loading lxml');
    await py.loadPackage(['lxml']);
    py.FS.mkdirTree('/wbx');
    py.FS.writeFile('/wbx/wbx.py', C.src);
    py.runPython("import sys; sys.path.insert(0, '/wbx')");
    py.runPython(RUNNER);
    return py;
  }
  async function needEzdxf(py, status) {
    status('Loading ezdxf, the first time only');
    await py.loadPackage('micropip');
    const mp = py.pyimport('micropip');
    try { await mp.install(/\.whl$/.test(C.ezdxf) ? new URL(C.ezdxf, location.href).href : C.ezdxf); } finally { mp.destroy(); }
  }

  async function run(args, files, status) {
    const py = await (ready = ready || boot(status).catch(e => { ready = null; throw e; }));
    if (args[0] === 'export') await (ezdxf = ezdxf || needEzdxf(py, status).catch(e => { ezdxf = null; throw e; }));
    status('Running wbx.py ' + args[0]);
    const dir = `/job/${++job}`;
    py.FS.mkdirTree(dir);
    for (const [n, v] of Object.entries(files)) py.FS.writeFile(`${dir}/${n}`, v);
    const before = new Set(py.FS.readdir(dir));
    const fn = py.globals.get('_wbx_run'), pa = py.toPy(args), r = fn(pa, dir), [code, stdout, stderr] = r.toJs();
    r.destroy(); pa.destroy(); fn.destroy();
    const out = {};
    for (const n of py.FS.readdir(dir)) {
      const p = `${dir}/${n}`;
      if (n !== '.' && n !== '..' && !before.has(n) && py.FS.isFile(py.FS.stat(p).mode)) out[n] = py.FS.readFile(p);
    }
    for (const n of py.FS.readdir(dir)) if (n !== '.' && n !== '..') py.FS.unlink(`${dir}/${n}`);
    py.FS.rmdir(dir);
    return { code, stdout, stderr, files: out };
  }

  W.WBX = W.WBX || {};
  W.WBX.pyodide = { run };
})(window);
