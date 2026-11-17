# tools

Python scripts for `.wb.svg` files. Each one is a single file: copy it anywhere and run it, or import it from your own code. Nothing here needs the rest of the repo.

| Script | What it does | Needs |
|---|---|---|
| [wbx.py](wbx.py) | Reads, checks and exports a `.wb.svg`: `check`, `place`, `export` | `lxml`; `ezdxf` for `export` |

Wire Bond Bench runs these same files. In the published page, they run in the browser.

## Running

With pip:

```sh
pip install lxml ezdxf
python tools/wbx.py check examples/example.wb.svg     # errors, warnings and notes; exits 1 on an error
python tools/wbx.py place examples/example.wb.svg     # how far the die can move or turn before a check fails
python tools/wbx.py export examples/example.wb.svg out   # out.bondlist.csv, out.fiducials.csv, out.dxf
```

Or with [uv](https://docs.astral.sh/uv/), which installs what the script's header lists, in a cache of its own:

```sh
uv run tools/wbx.py check examples/example.wb.svg
```

## Reading a .wb.svg from your own code

A `.wb.svg` is SVG, so any XML library reads it: the data is in the `wb:` attributes (namespace `urn:wbx:0.1`), described in [SPEC.md](../SPEC.md). Or put `wbx.py` beside your script and let it do the reading:

```python
import wbx

m = wbx.rd("board.wb.svg")
for w in sorted(m["wires"], key=lambda w: w["seq"]):
    print(w["name"], w["frm"], "->", w["to"], w["profile"], (w["x1"], w["y1"]), (w["x2"], w["y2"]))

res, errors = wbx.check(m)       # res holds the clearances; errors is a list of strings, empty if it passes
```

`rd()` returns a plain dict. Lengths are in µm.

| Key | Holds |
|---|---|
| `design`, `rev` | The file's design name and revision |
| `die` | `name`, `w`, `h`, and `tx`, `ty`: where the die's origin sits in the file |
| `pads` | Die pads: `name`, `net`, `x`, `y`, `w`, `h`, in the die's own frame, y up |
| `lands` | Board lands, the same fields, in file coordinates, y down |
| `wires` | `name`, `frm` and `to` (such as `U1.12` and `L12`), `net`, `profile`, `seq`, `tier`, and the bond points `x1`, `y1`, `x2`, `y2` in file coordinates |
| `prof` | Loop profiles: `name`, `material`, wire diameter `d`, `moves`, `style`, `dir`, `interp`, `refspan` |
| `stack` | The section view's layers: `name`, `role`, `material`, `z`, thickness `t` |
| `rules` | `gap` and `edge`, and `fid` if the file sets it |
| `board`, `fid`, `tol` | The board outline, the fiducials and the die placement tolerance, when the file has them |

A die pad at `(x, y)` is at `(tx + x, ty - y)` in file coordinates. `wbx.py` reads one die, not turned. Wire Bond Bench writes files with several die or a turned die, and `wbx.py` doesn't read those yet.

## Adding a script

So that each script stays usable on its own:

- **One file**, run as `python tools/<name>.py`. It takes files as arguments and never reaches into the rest of the repo.
- **Its dependencies go in a header** at the top, the [inline script metadata](https://packaging.python.org/en/latest/specifications/inline-script-metadata/) that `uv run` and `pipx run` read. Copy the one at the top of `wbx.py`.
- **It imports only** the standard library, what its header lists, and `wbx.py` from this folder. A script that imports `wbx` lists `lxml` in its own header too.
- **`main(argv)` returns the exit code**, and `if __name__ == "__main__": sys.exit(main())` calls it. That's how the app runs `wbx.py`, on your machine or in the browser.
- **Say in its docstring** what it does and how to run it, and add it to the table above.
