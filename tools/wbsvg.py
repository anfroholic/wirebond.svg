# /// script
# requires-python = ">=3.10"
# dependencies = ["lxml"]
# ///
"""wbsvg: read a .wb.svg as data.

A .wb.svg is a picture of a wire bonded assembly, and the same file is data: every element a tool reads carries a
wb:kind and its other wb: attributes. This module reads those into plain Python objects you can query, tabulate and
export. Reading needs only the standard library; check() also uses wbsvg.drc, which needs lxml.

wirebond is another name for this package: `import wirebond` and the wirebond command are the same code.

    import wbsvg
    a = wbsvg.load("board.wb.svg")

    a.wires                          # every wire, in bond order, with its loop worked out in 3D
    a.wire("W01").length             # wire length in um, along its loop
    a.pad("U1.12").net               # pads are named <die>.<pad>
    a.net("VSS").wires               # everything on a net
    a.query("wire", profile="PWR20") # match on any wb: attribute, as the file spells it
    a.bondlist()                     # rows for a bonder: die-centred, y up, z up, um
    a.table("profiles")              # each loop profile, how many wires use it, their spans and heights
    a.check()                        # consistency checks on any file, and drc.py's design rules where it can

Or from a shell:

    wbsvg info board.wb.svg
    wbsvg bondlist board.wb.svg -o board.bondlist.csv
    wbsvg table board.wb.svg nets
    wbsvg query board.wb.svg wire net=VSS
    wbsvg check board.wb.svg
    wbsvg place board.wb.svg                  # how far the die can move or turn before a check fails
    wbsvg export board.wb.svg out             # out.bondlist.csv, out.fiducials.csv, out.dxf (needs ezdxf)

Lengths are um, as in the file. Board coordinates are the file's: x right, y down, from the board's top-left corner.
Pad coordinates are the die's own (GDS, y up). z is up from the top of the board.

Part of wirebond.svg: https://github.com/anfroholic/wirebond.svg. (c) Andrew Wingate, MIT licence.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import os
import re
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field, fields, is_dataclass
from typing import Any, Iterable

__version__ = "0.2.0"
__url__ = "https://github.com/anfroholic/wirebond.svg"   # wirebond.svg: the format, the spec and these tools
__all__ = ["load", "loads", "Assembly", "Die", "Pad", "Land", "Wire", "Profile", "Layer", "Fiducial", "Part",
           "Tolerance", "Board", "Item", "Net", "Report", "Matrix", "WirebondError", "main"]

SVG = "http://www.w3.org/2000/svg"
WB = "urn:wbsvg:0.2"
SHAPES = ("rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "g")


class WirebondError(ValueError):
    """The file isn't a .wb.svg, or says something this module can't read."""


# ---- seal ---------------------------------------------------------------------------------------------------------
# Two SHA-256 digests on the root say whether a file was changed after it was written: wb:data-sha256 covers what a
# reader reads, wb:drawing-sha256 everything drawn. SPEC.md, Seal, has the canonical form. The same as drc.py's
# seal_digests() and app/js/seal.js, and must stay so. Not a signature: anyone can work them out again.

_SEAL = ("data-sha256", "drawing-sha256")
_XLINK = "http://www.w3.org/1999/xlink"
SEAL_SAYS = {"none": ("note", "seal: none, so a change made after the file was written can't be found"),
             "drawing changed": ("warn", "seal: the drawing was changed after the file was written, but its data wasn't: "
                                         "labels, hover text or colours may not match the data"),
             "data changed": ("error", "seal: the data was changed after the file was written, by hand or in another program: "
                                       "wb:data-sha256 doesn't match it")}


def _ws(s):
    return re.sub(r"[ \t\n\r]+", " ", s or "").strip(" ")


def seal_digests(root):
    """(data, drawing) for a parsed .wb.svg's root element. A seal it already carries is left out."""
    data, draw = [], []

    def line(depth, k, at, txt):
        return json.dumps([depth, k, [x for a in sorted(at) for x in (a, at[a])], txt], ensure_ascii=False, separators=(",", ":"))

    def walk(e, depth, in_data):
        if not isinstance(e.tag, str) or not e.tag.startswith(f"{{{SVG}}}"):
            return
        k = e.tag.split("}", 1)[1]
        if k == "metadata" or (k == "defs" and not any(isinstance(c.tag, str) for c in e)):
            return   # provenance, and the empty defs editors add
        at = {}
        for a, v in e.attrib.items():
            if a.startswith("{"):
                ns, l = a[1:].split("}", 1)
                if ns == WB:
                    if depth == 0 and l in _SEAL:
                        continue
                    a = "wb:" + l
                elif ns == _XLINK and l == "href":
                    a = "href"
                else:
                    continue
            elif a == "id":
                continue
            at[a] = _ws(v)
        txt = _ws((e.text or "") + "".join(c.tail or "" for c in e))
        draw.append(line(depth, k, at, txt))
        in_data = in_data or "wb:kind" in at
        if depth == 0:
            data.append(line(0, k, {a: v for a, v in at.items() if a.startswith("wb:")}, ""))
        elif in_data and k not in ("title", "desc"):
            data.append(line(depth, k, {a: v for a, v in at.items() if a not in ("class", "style")}, txt))
        for c in e:
            walk(c, depth + 1, in_data)

    walk(root, 0, False)
    return tuple(hashlib.sha256("\n".join(L).encode("utf-8")).hexdigest() for L in (data, draw))


def seal_check(root):
    """What a root element's seal says: "none", "intact", "drawing changed" or "data changed"."""
    d, g = root.get(f"{{{WB}}}{_SEAL[0]}"), root.get(f"{{{WB}}}{_SEAL[1]}")
    if not d and not g:
        return "none"
    D, G = seal_digests(root)
    return "data changed" if d != D else "drawing changed" if g != G else "intact"


# ---- geometry -----------------------------------------------------------------------------------------------------

class Matrix(tuple):
    """An SVG transform matrix(a b c d e f): x' = a x + c y + e, y' = b x + d y + f."""
    __slots__ = ()

    def __new__(cls, a=1.0, b=0.0, c=0.0, d=1.0, e=0.0, f=0.0):
        return super().__new__(cls, (a, b, c, d, e, f))

    def __matmul__(self, o):
        a, b, c, d, e, f = self
        A, B, C, D, E, F = o
        return Matrix(a * A + c * B, b * A + d * B, a * C + c * D, b * C + d * D, a * E + c * F + e, b * E + d * F + f)

    def apply(self, x, y):
        a, b, c, d, e, f = self
        return (a * x + c * y + e, b * x + d * y + f)

    def inverse(self):
        a, b, c, d, e, f = self
        det = a * d - b * c
        return Matrix(d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det)

    @property
    def rotation(self):
        """How far the local x axis is turned, in degrees counter-clockwise seen from above (board y up)."""
        r = -math.degrees(math.atan2(self[1], self[0]))
        r = round(r, 9) % 360
        return r - 360 if r > 180 else r


_TF = re.compile(r"(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)")


def parse_transform(s):
    """An SVG transform attribute as one Matrix."""
    M = Matrix()
    for name, args in _TF.findall(s or ""):
        v = [float(x) for x in re.split(r"[\s,]+", args.strip()) if x]
        if name == "matrix":
            T = Matrix(*v)
        elif name == "translate":
            T = Matrix(1, 0, 0, 1, v[0], v[1] if len(v) > 1 else 0)
        elif name == "scale":
            T = Matrix(v[0], 0, 0, v[1] if len(v) > 1 else v[0], 0, 0)
        elif name == "rotate":
            r = math.radians(v[0])
            T = Matrix(math.cos(r), math.sin(r), -math.sin(r), math.cos(r), 0, 0)
            if len(v) == 3:
                T = Matrix(1, 0, 0, 1, v[1], v[2]) @ T @ Matrix(1, 0, 0, 1, -v[1], -v[2])
        elif name == "skewX":
            T = Matrix(1, 0, math.tan(math.radians(v[0])), 1, 0, 0)
        else:
            T = Matrix(1, math.tan(math.radians(v[0])), 0, 1, 0, 0)
        M = M @ T
    return M


_PATH_ARGS = dict(M=2, L=2, H=1, V=1, C=6, S=4, Q=4, T=2, A=7, Z=0)


def path_points(d):
    """The points a path's data passes through or is pulled toward, enough for a bounding box. Straight-segment paths,
    which is all the spec allows for a fiducial, give exactly their corners."""
    toks = re.findall(r"[A-Za-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?", d or "")
    out, i, x, y, sx, sy, cmd = [], 0, 0.0, 0.0, 0.0, 0.0, "M"
    while i < len(toks):
        if toks[i].isalpha():
            cmd = toks[i]
            i += 1
        C, rel = cmd.upper(), cmd.islower()
        if C == "Z":
            x, y = sx, sy
            continue
        n = _PATH_ARGS.get(C)
        if n is None or i + n > len(toks):
            break
        v = [float(t) for t in toks[i:i + n]]
        i += n
        if C == "H":
            x = x + v[0] if rel else v[0]
        elif C == "V":
            y = y + v[0] if rel else v[0]
        elif C == "A":
            x, y = (x + v[5], y + v[6]) if rel else (v[5], v[6])
        else:
            pts = [(v[k], v[k + 1]) for k in range(0, n, 2)]
            for px, py in pts[:-1]:   # control points
                out.append((x + px, y + py) if rel else (px, py))
            x, y = (x + pts[-1][0], y + pts[-1][1]) if rel else pts[-1]
        out.append((x, y))
        if C == "M":
            sx, sy = x, y
            cmd = "l" if rel else "L"
    return out


def loop_points(moves, span, dz=0.0):
    """A loop's control points (x along the wire, z up) from its first bond: each vertical/horizontal step of moves,
    with % meaning a share of the span, then straight to the second bond at (span, dz). The same as drc.loop()."""
    pts, x, z = [(0.0, 0.0)], 0.0, 0.0
    for m in (moves or "").split():
        v, h = m.split("/")
        z += float(v)
        x += float(h[:-1]) / 100 * span if h.endswith("%") else float(h)
        pts.append((x, z))
    pts.append((float(span), float(dz)))
    return pts


def _n(v, places=3):
    """A number as the file writes it: at most `places` decimals, no trailing zeros, no -0."""
    if v is None:
        return ""
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        s = f"{v:.{places}f}".rstrip("0").rstrip(".")
        return "0" if s in ("-0", "") else s
    return v


# ---- what's in a file ---------------------------------------------------------------------------------------------

class _Base:
    """What every element read from the file has: its wb: attributes as written, and its hover title."""
    kind = ""

    def get(self, key, default=None):
        """A wb: attribute as the file spells it, such as get("to-kind")."""
        return self.attrs.get(key, default)

    def to_dict(self):
        return _plain(self)


def _field(**kw):
    return field(default=None, repr=False, compare=False, **kw)


@dataclass(kw_only=True, repr=True)
class Board(_Base):
    """The board outline, the extent of its Edge.Cuts, in board coordinates."""
    kind = "outline"
    name: str | None
    x: float
    y: float
    w: float
    h: float
    attrs: dict = field(default_factory=dict, repr=False)
    title: str = field(default="", repr=False)


@dataclass(kw_only=True)
class Pad(_Base):
    """A die pad opening. x, y, w, h are the die's own coordinates (GDS, y up); cx, cy its centre on the board."""
    kind = "pad"
    die: str
    name: str
    net: str | None
    x: float
    y: float
    w: float
    h: float
    cx: float
    cy: float
    attrs: dict = field(default_factory=dict, repr=False)
    title: str = field(default="", repr=False)
    _m: Matrix = _field()

    @property
    def ref(self):
        """How a wire names this pad: <die>.<pad>."""
        return f"{self.die}.{self.name}"

    def contains(self, x, y, slack=1e-6):
        """Whether board point x, y is on this pad."""
        u, v = self._m.inverse().apply(x, y)
        return self.x - slack <= u <= self.x + self.w + slack and self.y - slack <= v <= self.y + self.h + slack


@dataclass(kw_only=True)
class Land(_Base):
    """A bond finger or down-bond target on the board. x, y, w, h as drawn; cx, cy its centre on the board."""
    kind = "land"
    name: str
    net: str | None
    finish: str | None
    x: float
    y: float
    w: float
    h: float
    cx: float
    cy: float
    rotation: float = 0.0
    attrs: dict = field(default_factory=dict, repr=False)
    title: str = field(default="", repr=False)
    _m: Matrix = _field()

    contains = Pad.contains


@dataclass(kw_only=True)
class Die(_Base):
    """A die, placed on the board. x, y is where its origin (the outline's lower-left corner) sits on the board, and
    rotation is counter-clockwise seen from above. Heights come from the section view, when it has this die."""
    kind = "die"
    name: str
    gds_cell: str | None
    pad_layer: str | None
    w: float
    h: float
    x: float
    y: float
    rotation: float
    cx: float
    cy: float
    pads: list = field(default_factory=list, repr=False)
    z_bottom: float | None = None
    thickness: float | None = None
    attach: float | None = None
    attrs: dict = field(default_factory=dict, repr=False)
    title: str = field(default="", repr=False)
    _m: Matrix = _field()

    @property
    def z_top(self):
        return None if self.thickness is None else self.z_bottom + self.thickness

    def to_board(self, x, y):
        """A point in the die's own coordinates (GDS, y up), on the board."""
        return self._m.apply(x, y)

    def from_board(self, x, y):
        """A board point in the die's own coordinates."""
        return self._m.inverse().apply(x, y)

    def corners(self):
        """The outline's corners on the board, from the die's origin round."""
        return [self.to_board(x, y) for x, y in ((0, 0), (self.w, 0), (self.w, self.h), (0, self.h))]


@dataclass(kw_only=True)
class Profile(_Base):
    """A loop shape. moves are vertical/horizontal steps from the first bond; a % step is a share of the span.
    A profile with choice ("generic" or "undefined") has no wire size or loop."""
    kind = "profile"
    name: str
    material: str | None = None
    diameter: float | None = None
    style: str | None = None
    dir: str | None = None
    moves: str = ""
    interp: str | None = None
    ref_span: float | None = None
    choice: str | None = None
    attrs: dict = field(default_factory=dict, repr=False)
    title: str = field(default="", repr=False)

    def steps(self, span):
        """The moves at this span as (rise, run) pairs in um, % resolved."""
        P = loop_points(self.moves, span)[:-1]
        return [(round(b[1] - a[1], 6), round(b[0] - a[0], 6)) for a, b in zip(P, P[1:])]

    def points(self, span, dz=0.0):
        """The loop's control points (along, up) for a wire of this plan span whose second bond is dz above its first."""
        return loop_points(self.moves, span, dz)


@dataclass(kw_only=True)
class Wire(_Base):
    """A wire. x1, y1 is the first bond and x2, y2 the second, on the board. z1, z2 are their heights, and span,
    length, loop_height (above the first bond) and loop_top (above the board) are worked out from its profile and the
    section view; they're None where the file doesn't say enough."""
    kind = "wire"
    name: str
    seq: int | None
    tier: int
    net: str | None
    from_: str
    to: str
    to_kind: str
    profile: str | None
    diameter: float | None
    x1: float
    y1: float
    x2: float
    y2: float
    z1: float | None = None
    z2: float | None = None
    span: float = 0.0
    length: float | None = None
    loop_height: float | None = None
    loop_top: float | None = None
    attrs: dict = field(default_factory=dict, repr=False)
    title: str = field(default="", repr=False)
    _loop: list = _field()

    @property
    def from_die(self):
        return self.from_.split(".", 1)[0]

    @property
    def from_pad(self):
        return self.from_.split(".", 1)[-1]

    def loop3d(self):
        """The loop's control points on the board: (x, y, z), board x and y with z up, first bond to second.
        None when its profile or heights aren't known."""
        if self._loop is None:
            return None
        ux, uy = ((self.x2 - self.x1) / self.span, (self.y2 - self.y1) / self.span) if self.span else (0.0, 0.0)
        return [(self.x1 + ux * s, self.y1 + uy * s, self.z1 + z) for s, z in self._loop]


@dataclass(kw_only=True)
class Layer(_Base):
    """A layer of the section view. z is its bottom above the top of the board, thickness its height."""
    kind = "layer"
    name: str
    role: str | None
    material: str | None
    z: float
    thickness: float
    x: float
    w: float
    datum: str | None = None
    attrs: dict = field(default_factory=dict, repr=False)
    title: str = field(default="", repr=False)

    @property
    def top(self):
        return self.z + self.thickness


@dataclass(kw_only=True)
class Fiducial(_Base):
    """A fiducial: a board mark, or an eye point in a die. frame is "board" or the die's name; fx, fy is its reference
    point (the centre of its bounding box) in that frame, and x, y the same point on the board."""
    kind = "fiducial"
    name: str
    frame: str
    role: str
    datum: str | None
    shape: str
    bbox: tuple
    fx: float
    fy: float
    x: float
    y: float
    in_board_view: bool = False
    attrs: dict = field(default_factory=dict, repr=False)
    title: str = field(default="", repr=False)


@dataclass(kw_only=True)
class Part(_Base):
    """A front-side component in the board view, by its courtyard, in board coordinates."""
    kind = "part"
    name: str
    value: str | None
    height: float | None
    x: float
    y: float
    w: float
    h: float
    attrs: dict = field(default_factory=dict, repr=False)
    title: str = field(default="", repr=False)


@dataclass(kw_only=True)
class Tolerance(_Base):
    """A die placement tolerance: position, diameter tol in um, combined zone, to the datums."""
    kind = "tolerance"
    applies_to: str | None
    char: str | None
    tol: float | None
    modifier: str | None
    datums: list
    attrs: dict = field(default_factory=dict, repr=False)
    title: str = field(default="", repr=False)


@dataclass(kw_only=True)
class Item(_Base):
    """Any element with a wb:kind, as written: its kind, name, SVG tag and wb: attributes."""
    kind: str
    name: str | None
    tag: str
    attrs: dict = field(default_factory=dict)
    title: str = ""


@dataclass
class Net:
    """Everything on one net, by name: pad refs, land names and wire names."""
    name: str
    pads: list = field(default_factory=list)
    lands: list = field(default_factory=list)
    wires: list = field(default_factory=list)

    def to_dict(self):
        return _plain(self)


@dataclass
class Report:
    """What check() found. ok is True with no errors. full says whether drc.py's design rules ran as well."""
    errors: list = field(default_factory=list)
    warnings: list = field(default_factory=list)
    notes: list = field(default_factory=list)
    metrics: dict = field(default_factory=dict)
    full: bool = False

    @property
    def ok(self):
        return not self.errors

    def __str__(self):
        lines = [f"NOTE {x}" for x in self.notes] + [f"WARN {x}" for x in self.warnings] + [f"ERROR {x}" for x in self.errors]
        return "\n".join(lines + [f"{len(self.errors)} error(s)"])

    def to_dict(self):
        return _plain(self) | {"ok": self.ok}


def _plain(o):
    """Dataclasses, lists and dicts as plain JSON-able data, leaving out private fields."""
    if is_dataclass(o) and not isinstance(o, type):
        d = {f.name.rstrip("_"): _plain(getattr(o, f.name)) for f in fields(o) if not f.name.startswith("_")}
        for k in ("ref", "z_top", "top"):
            if hasattr(type(o), k):
                d[k] = getattr(o, k)
        return d
    if isinstance(o, dict):
        return {k: _plain(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_plain(v) for v in o]
    return o


# ---- reading ------------------------------------------------------------------------------------------------------

def load(source):
    """Read a .wb.svg from a path or an open file."""
    if hasattr(source, "read"):
        return loads(source.read())
    with open(os.fspath(source), "rb") as f:
        a = loads(f.read())
    a.path = os.fspath(source)
    return a


def loads(text):
    """Read a .wb.svg from its text (str or bytes)."""
    return Assembly(text.encode("utf-8") if isinstance(text, str) else bytes(text))


class Assembly:
    """One .wb.svg, read. Lists hold what the file has; lookups find one thing by name."""

    def __init__(self, data: bytes):
        self.path = None
        self._data = data
        try:
            root = ET.fromstring(data)
        except ET.ParseError as e:
            raise WirebondError(f"not well-formed XML: {e}") from None
        if root.tag != f"{{{SVG}}}svg":
            raise WirebondError("not an SVG file")
        self._root = root
        self.seal = seal_check(root)   # "none", "intact", "drawing changed" or "data changed"
        self._ns = next((k[1:].split("}")[0] for k in root.attrib if k.startswith("{urn:wbsvg:")), WB)
        self._parent = {c: p for p in root.iter() for c in p}
        all_kinds = [e for e in root.iter() if self._a(e, "kind")]
        if not all_kinds and not any(k.startswith("{urn:wbsvg:") for k in root.attrib):
            raise WirebondError("not a wirebond.svg: no wb: attributes in namespace urn:wbsvg:*")
        self.items = [Item(kind=self._a(e, "kind"), name=self._a(e, "name"), tag=_local(e), attrs=self._attrs(e), title=_title(e))
                      for e in all_kinds]
        K = lambda k: [e for e in all_kinds if self._a(e, "kind") == k]

        A = lambda k: self._a(root, k)
        self.version, self.units, self.design, self.rev = A("version"), A("units") or "um", A("design"), A("rev")
        self.rules = {k.split("}")[1][5:].replace("-", "_"): _num(v) for k, v in root.attrib.items()
                      if k.startswith(f"{{{self._ns}}}rule-")}

        # the section view: heights
        self.stack = []
        for e in K("layer"):
            y, h = _f(e, "y"), _f(e, "height")
            self.stack.append(Layer(name=self._a(e, "name"), role=self._a(e, "role"), material=self._a(e, "material"), z=-(y + h),
                                    thickness=h, x=_f(e, "x"), w=_f(e, "width"), datum=self._a(e, "datum"), **self._meta(e)))
        sub = next((l for l in self.stack if l.role == "substrate"), None)
        self.board_top = sub.top if sub else 0.0

        # the board
        outs = [e for e in K("outline") if not self._up(e, "die")]
        outs.sort(key=lambda e: self._up(e, "board") is not None)   # the bond diagram's own before the board view's
        self.board = None
        if outs:
            e = outs[0]
            x0, y0, x1, y1 = self._box(e, self._ctm(self._parent[e]))
            self.board = Board(name=self._a(e, "name"), x=x0, y=y0, w=x1 - x0, h=y1 - y0, **self._meta(e))

        # dies and their pads
        self.dies = []
        die_layers = [l for l in self.stack if l.role == "die"]
        att_layers = [l for l in self.stack if l.role == "attach"]
        dgroups = K("die")
        for g in dgroups:
            name = self._a(g, "name")
            M = self._ctm(g)
            o = next((c for c in g if self._a(c, "kind") == "outline"), None)
            w, h = (_f(o, "width"), _f(o, "height")) if o is not None else (0.0, 0.0)
            lay = next((l for l in die_layers if l.name == name), None) or (die_layers[0] if len(dgroups) == 1 and len(die_layers) == 1 else None)
            att = next((l for l in att_layers if l.name == f"{name} attach"), None) or (att_layers[0] if len(dgroups) == 1 and len(att_layers) == 1 else None)
            d = Die(name=name, gds_cell=self._a(g, "gds-cell"), pad_layer=self._a(g, "pad-layer"), w=w, h=h, x=M[4], y=M[5],
                    rotation=M.rotation, cx=0.0, cy=0.0, z_bottom=lay.z if lay else None, thickness=lay.thickness if lay else None,
                    attach=att.thickness if att else None, _m=M, **self._meta(g))
            d.cx, d.cy = d.to_board(w / 2, h / 2)
            for e in g.iter():
                if self._a(e, "kind") == "pad":
                    Mp = self._ctm(e)
                    x, y, pw, ph = _f(e, "x"), _f(e, "y"), _f(e, "width"), _f(e, "height")
                    cx, cy = Mp.apply(x + pw / 2, y + ph / 2)
                    d.pads.append(Pad(die=name, name=self._a(e, "name"), net=self._a(e, "net"), x=x, y=y, w=pw, h=ph, cx=cx, cy=cy, _m=Mp, **self._meta(e)))
            self.dies.append(d)
        self.pads = [p for d in self.dies for p in d.pads]

        self.lands = []
        for e in K("land"):
            M = self._ctm(e)
            x, y, w, h = _f(e, "x"), _f(e, "y"), _f(e, "width"), _f(e, "height")
            cx, cy = M.apply(x + w / 2, y + h / 2)
            self.lands.append(Land(name=self._a(e, "name"), net=self._a(e, "net"), finish=self._a(e, "finish"), x=x, y=y, w=w, h=h,
                                   cx=cx, cy=cy, rotation=M.rotation, _m=M, **self._meta(e)))

        self.profiles = []
        for e in K("profile"):
            pl = next((c for c in e if _local(c) == "polyline"), None)
            choice = self._a(e, "choice")
            self.profiles.append(Profile(
                name=self._a(e, "name"), material=self._a(e, "material"),
                diameter=_num(pl.get("stroke-width")) if pl is not None and pl.get("stroke-width") and not choice else None,
                style=self._a(e, "style"), dir=self._a(e, "dir"), moves=self._a(e, "moves") or "", interp=self._a(e, "interp"),
                ref_span=_num(self._a(e, "ref-span")), choice=choice, **self._meta(e)))

        self.fiducials = []
        for e in K("fiducial"):
            dg = self._up(e, "die")
            frame_m = self._ctm(self._parent[e], upto=dg)
            x0, y0, x1, y1 = self._box(e, frame_m)
            fx, fy = (x0 + x1) / 2, (y0 + y1) / 2
            x, y = self._ctm(dg).apply(fx, fy) if dg is not None else (fx, fy)
            self.fiducials.append(Fiducial(name=self._a(e, "name"), frame=self._a(dg, "name") if dg is not None else "board",
                                           role=self._a(e, "role") or "align", datum=self._a(e, "datum"), shape=_local(e),
                                           bbox=(x0, y0, x1, y1), fx=fx, fy=fy, x=x, y=y, in_board_view=self._up(e, "board") is not None,
                                           **self._meta(e)))

        self.parts = []
        for e in K("part"):
            x0, y0, x1, y1 = self._box(e, self._ctm(self._parent[e]))
            t = _title(e)
            m = re.match(r"^[^:]+: ([^,]+)", t)
            self.parts.append(Part(name=self._a(e, "name"), value=m[1] if m else None, height=_num(self._a(e, "height")),
                                   x=x0, y=y0, w=x1 - x0, h=y1 - y0, **self._meta(e)))

        self.tolerances = [Tolerance(applies_to=self._a(e, "applies-to"), char=self._a(e, "char"), tol=_num(self._a(e, "tol")),
                                     modifier=self._a(e, "modifier"), datums=(self._a(e, "datums") or "").split(), **self._meta(e))
                           for e in K("tolerance")]

        # wires, with their loops in 3D
        self._pads = {p.ref: p for p in self.pads}
        self._lands = {l.name: l for l in self.lands}
        self._dies = {d.name: d for d in self.dies}
        self._profiles = {p.name: p for p in self.profiles}
        self.wires = []
        for i, e in enumerate(K("wire")):
            M = self._ctm(e)
            x1, y1 = M.apply(_f(e, "x1"), _f(e, "y1"))
            x2, y2 = M.apply(_f(e, "x2"), _f(e, "y2"))
            to = self._a(e, "to") or ""
            to_kind = self._a(e, "to-kind") or ("die" if to in self._pads and to not in self._lands else "land")
            seq = self._a(e, "seq")
            w = Wire(name=self._a(e, "name"), seq=int(float(seq)) if seq else None, tier=int(float(self._a(e, "tier") or 1)),
                     net=self._a(e, "net"), from_=self._a(e, "from") or "", to=to, to_kind=to_kind, profile=self._a(e, "profile"),
                     diameter=_num(e.get("stroke-width")), x1=x1, y1=y1, x2=x2, y2=y2, span=math.dist((x1, y1), (x2, y2)), **self._meta(e))
            fd = self._dies.get(w.from_die)
            w.z1 = fd.z_top if fd else None
            w.z2 = self.board_top if to_kind == "land" else (self._dies[to.split(".")[0]].z_top if to.split(".")[0] in self._dies else None)
            pr = self._profiles.get(w.profile)
            if pr and not pr.choice and w.z1 is not None and w.z2 is not None:
                w._loop = pr.points(w.span, w.z2 - w.z1)
                w.length = sum(math.dist(a, b) for a, b in zip(w._loop, w._loop[1:]))
                w.loop_height = max(z for _, z in w._loop)
                w.loop_top = w.z1 + w.loop_height
            w._order = i
            self.wires.append(w)
        self.wires.sort(key=lambda w: (w.seq is None, w.seq if w.seq is not None else 0, w._order))
        self._wires = {w.name: w for w in self.wires}

    # -- helpers on the XML
    def _a(self, e, k):
        return e.get(f"{{{self._ns}}}{k}") if e is not None else None

    def _attrs(self, e):
        p = f"{{{self._ns}}}"
        return {k[len(p):]: v for k, v in e.attrib.items() if k.startswith(p)}

    def _meta(self, e):
        return dict(attrs=self._attrs(e), title=_title(e))

    def _up(self, e, kind):
        """The nearest ancestor of e with this wb:kind."""
        p = self._parent.get(e)
        while p is not None and self._a(p, "kind") != kind:
            p = self._parent.get(p)
        return p

    def _ctm(self, e, upto=None):
        """e's own coordinates to board coordinates (or to upto's coordinates). A board view group's transform only
        places the drawing on the sheet, so it's skipped: inside it, coordinates are already the board's."""
        chain = []
        while e is not None and e is not upto:
            chain.append(e)
            e = self._parent.get(e)
        M = Matrix()
        for x in reversed(chain):
            if x.get("transform") and self._a(x, "kind") != "board":
                M = M @ parse_transform(x.get("transform"))
        return M

    def _box(self, e, M):
        """Bounding box of e's drawn geometry under M (which maps e's parent's coordinates), stroke ignored."""
        M = M @ parse_transform(e.get("transform"))
        t, F = _local(e), lambda k: _f(e, k)
        if t == "rect":
            P = [(F("x"), F("y")), (F("x") + F("width"), F("y")), (F("x"), F("y") + F("height")), (F("x") + F("width"), F("y") + F("height"))]
        elif t in ("circle", "ellipse"):
            rx, ry = (F("r"), F("r")) if t == "circle" else (F("rx"), F("ry"))
            P = [(F("cx") + sx * rx, F("cy") + sy * ry) for sx in (-1, 1) for sy in (-1, 1)]
        elif t == "line":
            P = [(F("x1"), F("y1")), (F("x2"), F("y2"))]
        elif t in ("polyline", "polygon"):
            v = [float(x) for x in re.split(r"[\s,]+", (e.get("points") or "").strip()) if x]
            P = list(zip(v[::2], v[1::2]))
        elif t == "path":
            P = path_points(e.get("d"))
        elif t == "g":
            B = [self._box(c, M) for c in e if _local(c) in SHAPES]
            B = [b for b in B if b]
            return (min(b[0] for b in B), min(b[1] for b in B), max(b[2] for b in B), max(b[3] for b in B)) if B else None
        else:
            return None
        if not P:
            return None
        P = [M.apply(x, y) for x, y in P]
        return (min(p[0] for p in P), min(p[1] for p in P), max(p[0] for p in P), max(p[1] for p in P))

    # -- lookups
    def die(self, name=None) -> Die:
        """A die by name; with no name, the only (or first) die."""
        if name is None:
            if not self.dies:
                raise KeyError("this file has no die")
            return self.dies[0]
        return self._dies[name]

    def pad(self, ref) -> Pad:
        """A pad by <die>.<pad>, as wires name them, such as "U1.12"."""
        return self._pads[ref]

    def land(self, name) -> Land:
        return self._lands[name]

    def wire(self, name) -> Wire:
        return self._wires[name]

    def profile(self, name) -> Profile:
        return self._profiles[name]

    def layer(self, name) -> Layer:
        return next(l for l in self.stack if l.name == name)

    def target(self, wire):
        """What a wire's second bond lands on: a Land, or a Pad for a die-to-die wire."""
        w = wire if isinstance(wire, Wire) else self.wire(wire)
        return self._pads.get(w.to) if w.to_kind == "die" else self._lands.get(w.to)

    def source(self, wire):
        """The pad a wire's first bond is on."""
        w = wire if isinstance(wire, Wire) else self.wire(wire)
        return self._pads.get(w.from_)

    # -- nets and connections
    def nets(self) -> dict:
        """Every net named in the file, by name: its pads, lands and wires."""
        out = {}
        for kind, things, key in (("pads", self.pads, "ref"), ("lands", self.lands, "name"), ("wires", self.wires, "name")):
            for t in things:
                if t.net:
                    getattr(out.setdefault(t.net, Net(t.net)), kind).append(getattr(t, key))
        return dict(sorted(out.items()))

    def net(self, name) -> Net:
        return self.nets()[name]

    def wires_on(self, ref):
        """The wires bonded to a pad ("U1.12") or land ("L12"), at either end."""
        return [w for w in self.wires if ref in (w.from_, w.to)]

    def unbonded_pads(self):
        """Pads no wire bonds to, at either end."""
        used = {w.from_ for w in self.wires} | {w.to for w in self.wires if w.to_kind == "die"}
        return [p for p in self.pads if p.ref not in used]

    def unused_lands(self):
        used = {w.to for w in self.wires if w.to_kind == "land"}
        return [l for l in self.lands if l.name not in used]

    def wire_usage(self):
        """Wire used, by material and diameter: count and total length in um, along each loop."""
        out = {}
        for w in self.wires:
            p = self._profiles.get(w.profile)
            k = (p.material if p else None, w.diameter)
            u = out.setdefault(k, dict(material=k[0], diameter=k[1], wires=0, length=0.0, unknown=0))
            u["wires"] += 1
            if w.length is None:
                u["unknown"] += 1
            else:
                u["length"] += w.length
        return list(out.values())

    # -- the generic query
    def query(self, kind=None, **where):
        """Elements of a kind whose attributes match. Keys are wb: attributes as the file spells them, with _ for -
        (to_kind for wb:to-kind, from_ for wb:from), or else the object's own fields (die for a pad, length for a
        wire). A value matches as text, or pass a list of choices, a compiled regex, or a function of the value.

            a.query("wire", net="VSS")
            a.query("wire", profile=["PWR20", "GND20"], length=lambda v: v and v > 2000)
            a.query("pad", die="D2", net=re.compile(r"DQ\\d+"))
            a.query("land", finish="ENIG")

        Known kinds come back as their classes (Wire, Pad, ...); any other, or kind=None, as Items."""
        typed = dict(die=self.dies, pad=self.pads, land=self.lands, wire=self.wires, profile=self.profiles, layer=self.stack,
                     fiducial=self.fiducials, part=self.parts, tolerance=self.tolerances)
        pool = typed[kind] if kind in typed else [i for i in self.items if kind is None or i.kind == kind]
        return [o for o in pool if all(_match(o, k, v) for k, v in where.items())]

    # -- tables
    TABLES = ("bondlist", "wires", "pads", "lands", "nets", "profiles", "dies", "layers", "fiducials", "parts")

    def bondlist(self, origin="die", die=None, units="um", wires=None):
        """One row per wire in bond order, in a frame for a bonder: x right, y up, z up from the top of the board.

        origin: "die", the centre of die (default the first die), as drc.py export writes; "board", the board
        outline's lower-left corner; or an (x, y) point in board coordinates. units: "um" or "mm"."""
        if isinstance(origin, (tuple, list)):
            ox, oy = origin
        elif origin == "board":
            if not self.board:
                raise WirebondError("this file has no board outline; use origin=\"die\" or a point")
            ox, oy = self.board.x, self.board.y + self.board.h
        elif origin == "die":
            ox, oy = self.die(die).cx, self.die(die).cy
        else:
            raise ValueError(f"origin {origin!r}: use \"die\", \"board\" or an (x, y) point")
        k, u = (0.001, "mm") if units == "mm" else (1.0, "um")
        S = lambda v: None if v is None else round(v * k, 6 if u == "mm" else 3)
        rows = []
        for w in (wires if wires is not None else self.wires):
            p = self._profiles.get(w.profile)
            rows.append({"seq": w.seq, "tier": w.tier, "wire": w.name, "net": w.net, "from": w.from_, "to": w.to,
                         f"x1_{u}": S(w.x1 - ox), f"y1_{u}": S(oy - w.y1), f"z1_{u}": S(w.z1),
                         f"x2_{u}": S(w.x2 - ox), f"y2_{u}": S(oy - w.y2), f"z2_{u}": S(w.z2),
                         "profile": w.profile, "to_kind": w.to_kind, "material": p.material if p else None,
                         f"diameter_{u}": S(w.diameter), f"span_{u}": S(w.span), f"length_{u}": S(w.length),
                         f"loop_height_{u}": S(w.loop_height)})
        return rows

    def table(self, name, **kw):
        """A list of flat rows (dicts), ready for csv, JSON or pandas: pandas.DataFrame(a.table("wires")).
        name is one of Assembly.TABLES; keyword arguments go to bondlist()."""
        if name == "bondlist":
            return self.bondlist(**kw)
        R = lambda v: None if v is None else round(v, 3)
        if name == "wires":
            return [dict(name=w.name, seq=w.seq, tier=w.tier, net=w.net, **{"from": w.from_}, to=w.to, to_kind=w.to_kind, profile=w.profile,
                         diameter=w.diameter, x1=R(w.x1), y1=R(w.y1), z1=R(w.z1), x2=R(w.x2), y2=R(w.y2), z2=R(w.z2), span=R(w.span),
                         length=R(w.length), loop_height=R(w.loop_height), loop_top=R(w.loop_top)) for w in self.wires]
        if name == "pads":
            n = {}
            for w in self.wires:
                for r in (w.from_, w.to):
                    n[r] = n.get(r, 0) + 1
            return [dict(ref=p.ref, die=p.die, name=p.name, net=p.net, x=p.x, y=p.y, w=p.w, h=p.h, cx=R(p.cx), cy=R(p.cy), wires=n.get(p.ref, 0))
                    for p in self.pads]
        if name == "lands":
            return [dict(name=l.name, net=l.net, finish=l.finish, cx=R(l.cx), cy=R(l.cy), w=l.w, h=l.h, rotation=R(l.rotation),
                         wires=len(self.wires_on(l.name))) for l in self.lands]
        if name == "nets":
            return [dict(net=n.name, pads=" ".join(n.pads), lands=" ".join(n.lands), wires=" ".join(n.wires)) for n in self.nets().values()]
        if name == "profiles":
            out = []
            for p in self.profiles:
                ws = [w for w in self.wires if w.profile == p.name]
                L = [w for w in ws if w.length is not None]
                out.append(dict(name=p.name, choice=p.choice, material=p.material, diameter=p.diameter, style=p.style, dir=p.dir,
                                interp=p.interp, moves=p.moves, ref_span=p.ref_span, wires=len(ws),
                                span_min=R(min((w.span for w in ws), default=None)), span_max=R(max((w.span for w in ws), default=None)),
                                loop_height_max=R(max((w.loop_height for w in L), default=None)),
                                length_total=R(sum(w.length for w in L)) if L else None))
            return out
        if name == "dies":
            return [dict(name=d.name, gds_cell=d.gds_cell, pad_layer=d.pad_layer, w=d.w, h=d.h, x=R(d.x), y=R(d.y), rotation=R(d.rotation),
                         cx=R(d.cx), cy=R(d.cy), pads=len(d.pads), z_bottom=d.z_bottom, thickness=d.thickness, z_top=d.z_top, attach=d.attach)
                    for d in self.dies]
        if name == "layers":
            return [dict(name=l.name, role=l.role, material=l.material, z=l.z, thickness=l.thickness, top=l.top, x=l.x, w=l.w, datum=l.datum)
                    for l in self.stack]
        if name == "fiducials":
            return [dict(name=f.name, frame=f.frame, role=f.role, datum=f.datum, shape=f.shape, fx=R(f.fx), fy=R(f.fy), x=R(f.x), y=R(f.y),
                         in_board_view=f.in_board_view) for f in self.fiducials]
        if name == "parts":
            return [dict(name=p.name, value=p.value, height=p.height, x=p.x, y=p.y, w=p.w, h=p.h) for p in self.parts]
        raise ValueError(f"no table {name!r}; there are {', '.join(self.TABLES)}")

    def to_dict(self):
        """Everything read, as plain data."""
        return dict(design=self.design, rev=self.rev, version=self.version, units=self.units, rules=self.rules,
                    board=_plain(self.board), board_top=self.board_top, dies=_plain(self.dies), lands=_plain(self.lands),
                    wires=_plain(self.wires), profiles=_plain(self.profiles), stack=_plain(self.stack), fiducials=_plain(self.fiducials),
                    parts=_plain(self.parts), tolerances=_plain(self.tolerances))

    def to_json(self, **kw):
        return json.dumps(self.to_dict(), **({"indent": 1} | kw))

    # -- checking
    def check(self, rules=True) -> Report:
        """Check the file. These run on any file: names are unique, every wire's ends name a pad, land and profile that
        exist, each bond lies on what it names, nets agree where named, and stroke-width is the profile's diameter.
        With rules=True and a file drc.py reads (one die, not turned, wires to lands), drc.py's design rules run too:
        loop clearances, wire gap, glob top, fiducials and placement tolerance. Those need lxml."""
        r = Report()
        level, say = SEAL_SAYS.get(self.seal, (None, None))
        if say:
            {"error": r.errors, "warn": r.warnings, "note": r.notes}[level].append(say)
        r.metrics["seal"] = self.seal
        for what, names in (("die", [d.name for d in self.dies]), ("pad", [p.ref for p in self.pads]), ("land", [l.name for l in self.lands]),
                            ("wire", [w.name for w in self.wires]), ("profile", [p.name for p in self.profiles])):
            seen = set()
            for n in names:
                if n in seen:
                    r.errors.append(f"two {what}s named {n}")
                seen.add(n)
        seqs = [w.seq for w in self.wires if w.seq is not None]
        if len(seqs) != len(set(seqs)):
            r.warnings.append("two or more wires share a wb:seq, so the bond order is ambiguous")
        refs_ok = True
        for w in self.wires:
            if w.from_ not in self._pads:
                r.errors.append(f"{w.name}: wb:from {w.from_!r} is not a pad"); refs_ok = False
            if self.target(w) is None:
                r.errors.append(f"{w.name}: wb:to {w.to!r} is not a {'pad' if w.to_kind == 'die' else 'land'}"); refs_ok = False
            if w.profile not in self._profiles:
                r.errors.append(f"{w.name}: wb:profile {w.profile!r} is not a profile"); refs_ok = False
        full = False
        if rules and refs_ok and not r.errors:
            full = self._drc_check(r)
        if not full and refs_ok:
            renamed = []
            for w in self.wires:
                p, t, pr = self.source(w), self.target(w), self._profiles[w.profile]
                if not p.contains(w.x1, w.y1):
                    r.errors.append(f"{w.name}: first bond off pad {w.from_}")
                if not t.contains(w.x2, w.y2):
                    r.errors.append(f"{w.name}: second bond off {'pad' if w.to_kind == 'die' else 'land'} {w.to}")
                if w.to_kind == "die":   # each die names its nets in its own GDS, so the two ends may differ; the wire joins them
                    if p.net and t.net and p.net != t.net:
                        renamed.append(f"{w.name} {p.net}={t.net}")
                    if w.net and w.net not in (p.net, t.net) and p.net and t.net:
                        r.errors.append(f"{w.name}: net {w.net} is neither end's ({p.net}, {t.net})")
                elif len({x for x in (w.net, p.net, t.net) if x}) > 1:
                    r.errors.append(f"{w.name}: net mismatch")
                if not pr.choice and pr.diameter is not None and w.diameter is not None and abs(w.diameter - pr.diameter) > 1e-6:
                    r.errors.append(f"{w.name}: stroke-width != profile diameter")
            if renamed:
                r.notes.append(f"{len(renamed)} die-to-die wire(s) join nets named differently on each die: " + ", ".join(renamed))
            r.metrics.update(wires=len(self.wires), pads=len(self.pads), lands=len(self.lands))
        r.full = full
        return r

    def _drc_check(self, r):
        if len(self.dies) != 1 or abs(self.dies[0].rotation) > 1e-9 or any(w.to_kind != "land" for w in self.wires):
            r.notes.append("design rules not run: drc.py reads one die, not turned, with wires to lands; consistency checks ran")
            return False
        try:
            drc = _drc()
        except ImportError as e:
            r.notes.append(f"design rules not run: drc.py couldn't be imported ({e}); consistency checks ran")
            return False
        try:
            m = drc.rd(io.BytesIO(self._data))
            m.pop("seal", None)   # check() has reported it already
            res, errs = drc.check(m)
        except Exception as e:   # drc.py stops on what it can't read; say so, and fall back
            r.notes.append(f"design rules not run: drc.py stopped ({type(e).__name__}: {e}); consistency checks ran")
            return False
        r.errors += errs
        r.warnings += res.pop("warn", [])
        r.notes += res.pop("note", [])
        r.metrics.update(res)
        return True

    # -- summary
    def summary(self):
        """A few lines saying what's in the file."""
        L = [f"{self.design or '(no design name)'}{' rev ' + self.rev if self.rev else ''}  (wirebond.svg {self.version or '?'})"]
        if self.board:
            L.append(f"board {self.board.name or ''} {_n(self.board.w)} x {_n(self.board.h)} um".replace("  ", " "))
        for d in self.dies:
            z = f", top {_n(d.z_top)} um above the board" if d.z_top is not None else ""
            L.append(f"die {d.name} ({d.gds_cell}) {_n(d.w)} x {_n(d.h)} um at {_n(d.cx)}, {_n(d.cy)}"
                     f"{', turned ' + _n(d.rotation) + ' deg' if d.rotation else ''}, {len(d.pads)} pads{z}")
        dd = sum(w.to_kind == "die" for w in self.wires)
        L.append(f"{len(self.lands)} lands, {len(self.wires)} wires ({len(self.wires) - dd} to lands, {dd} die to die), "
                 f"{len(self.profiles)} profiles, {len(self.nets())} nets")
        for u in self.wire_usage():
            L.append(f"wire {u['material'] or '?'} {_n(u['diameter'])} um: {u['wires']} wires, {_n(u['length'] / 1000, 2)} mm"
                     + (f" (+{u['unknown']} of unknown length)" if u["unknown"] else ""))
        if self.stack:
            L.append("stack: " + ", ".join(f"{l.name} {_n(l.thickness)} um" for l in self.stack))
        if self.fiducials:
            L.append(f"{len(self.fiducials)} fiducials: " + ", ".join(f"{f.name} ({f.frame}, {f.role})" for f in self.fiducials))
        for t in self.tolerances:
            L.append(f"placement tolerance on {t.applies_to}: {t.char} {_n(t.tol)} um {t.modifier} | {' | '.join(t.datums)}")
        if self.rules:
            L.append("rules: " + ", ".join(f"{k} {_n(v)} um" for k, v in self.rules.items()))
        L.append(f"seal: {self.seal}")
        return "\n".join(L)

    def __repr__(self):
        return f"<wbsvg.Assembly {self.design!r}: {len(self.dies)} die, {len(self.wires)} wires>"


def _local(e):
    return e.tag.rsplit("}", 1)[-1] if isinstance(e.tag, str) else ""


def _title(e):
    t = e.find(f"{{{SVG}}}title")
    return (t.text or "") if t is not None else ""


def _f(e, k, default=0.0):
    v = e.get(k)
    return float(v) if v not in (None, "") else default


def _num(v):
    if v in (None, ""):
        return None
    v = float(v)
    return int(v) if v.is_integer() else v


def _match(o, key, want):
    k = key.rstrip("_").replace("_", "-")
    if k in o.attrs:
        have = o.attrs[k]
    elif hasattr(o, key):
        have = getattr(o, key)
    elif hasattr(o, key + "_"):
        have = getattr(o, key + "_")
    else:
        have = None
    if callable(want) and not isinstance(want, re.Pattern):
        return bool(want(have))
    if isinstance(want, re.Pattern):
        return have is not None and want.fullmatch(str(have)) is not None
    if isinstance(want, (list, tuple, set, frozenset)):
        return any(_eq(have, x) for x in want)
    return _eq(have, want)


def _eq(have, want):
    if have == want:
        return True
    if have is None or want is None:
        return False
    try:
        return float(have) == float(want)
    except (TypeError, ValueError):
        return str(have) == str(want)


# ---- command line -------------------------------------------------------------------------------------------------

def _write(rows, fmt, out):
    if fmt == "json":
        out.write(json.dumps(rows, indent=1) + "\n")
        return
    if not rows:
        return
    c = csv.DictWriter(out, fieldnames=list(rows[0]), lineterminator="\n")
    c.writeheader()
    for r in rows:
        c.writerow({k: _n(v, 6) if isinstance(v, float) else v for k, v in r.items()})


def _drc():
    """The design rule checker, placer and exporter: wbsvg.drc, or drc.py beside this file when it runs on its own."""
    try:
        from . import drc   # installed as the wbsvg package
    except ImportError:
        import drc          # run as a single file, beside drc.py
    return drc


def _prog():
    """wbsvg, or wirebond when it was run by that name."""
    path = sys.argv[0] if sys.argv and sys.argv[0] else ""
    n = os.path.splitext(os.path.basename(path))[0]
    if n == "__main__":   # python -m wirebond: the package's folder says which name
        n = os.path.basename(os.path.dirname(path))
    return "wirebond" if n == "wirebond" else "wbsvg"


def main(argv=None):
    import argparse
    p = argparse.ArgumentParser(prog=_prog(), description="Read a .wb.svg as data", epilog=f"Part of wirebond.svg: {__url__}")
    p.add_argument("--version", action="version", version=f"wbsvg {__version__}, part of wirebond.svg: {__url__}")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("info", help="what's in the file"); s.add_argument("file")
    s = sub.add_parser("json", help="everything read, as JSON"); s.add_argument("file")
    s = sub.add_parser("bondlist", help="one row per wire, for a bonder")
    s.add_argument("file"); s.add_argument("-o", "--out", help="write here instead of to stdout")
    s.add_argument("--origin", default="die", help='"die" (its centre, the default), "board" (lower-left corner) or x,y in board um')
    s.add_argument("--die", help="the die whose centre is the origin (default the first)")
    s.add_argument("--units", choices=("um", "mm"), default="um"); s.add_argument("--format", choices=("csv", "json"), default="csv")
    s = sub.add_parser("table", help=f"a table: {', '.join(Assembly.TABLES)}")
    s.add_argument("file"); s.add_argument("name", choices=Assembly.TABLES); s.add_argument("-o", "--out")
    s.add_argument("--format", choices=("csv", "json"), default="csv")
    s = sub.add_parser("query", help="elements of a kind whose wb: attributes match, such as: query f.wb.svg wire net=VSS")
    s.add_argument("file"); s.add_argument("kind"); s.add_argument("where", nargs="*", help="key=value; a value can be a|b|c")
    s = sub.add_parser("check", help="consistency checks, and the design rules where drc can read the file")
    s.add_argument("file"); s.add_argument("--json", action="store_true")
    s = sub.add_parser("place", help="how far the die can move or turn before a check fails (one die, not turned)")
    s.add_argument("file"); s.add_argument("--dirs", type=int, default=72, help="directions to try (default 72)")
    s = sub.add_parser("export", help="BASE.bondlist.csv, BASE.fiducials.csv and the 3D wires as BASE.dxf (needs ezdxf)")
    s.add_argument("file"); s.add_argument("base")
    a = p.parse_args(argv)
    if a.cmd in ("place", "export"):   # drc's own reader: one die, not turned, wires to lands
        try:
            drc = _drc()
            m = drc.rd(a.file)
        except Exception as e:
            print(f"{p.prog}: {a.file}: {e}", file=sys.stderr)
            return 2
        if a.cmd == "place":
            print(json.dumps(drc.place_limit(m, a.dirs), indent=2))
        else:
            drc.export(m, a.base)
            print("wrote", a.base + ".bondlist.csv", a.base + ".dxf")
        return 0
    try:
        asm = load(a.file)
    except (OSError, WirebondError) as e:
        print(f"{p.prog}: {a.file}: {e}", file=sys.stderr)
        return 2

    def out_to(path):
        return open(path, "w", newline="", encoding="utf-8") if path else sys.stdout

    if a.cmd == "info":
        print(asm.summary())
    elif a.cmd == "json":
        print(asm.to_json())
    elif a.cmd in ("bondlist", "table"):
        if a.cmd == "bondlist":
            o = a.origin if a.origin in ("die", "board") else tuple(float(v) for v in a.origin.split(","))
            rows = asm.bondlist(origin=o, die=a.die, units=a.units)
        else:
            rows = asm.table(a.name)
        f = out_to(a.out)
        try:
            _write(rows, a.format, f)
        finally:
            if f is not sys.stdout:
                f.close()
    elif a.cmd == "query":
        where = {}
        for kv in a.where:
            k, _, v = kv.partition("=")
            where[k] = v.split("|") if "|" in v else v
        for o in asm.query(a.kind, **where):
            print(json.dumps(o.to_dict()))
    elif a.cmd == "check":
        r = asm.check()
        print(json.dumps(r.to_dict(), indent=1) if a.json else str(r))
        return 1 if r.errors else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
