<p align="center">
  <a href="https://github.com/anfroholic/wirebond.svg">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="app/brand/wirebond-logo.svg">
      <img src="app/brand/wirebond-logo-light.svg" alt="wirebond.svg" width="360">
    </picture>
  </a>
</p>

# wirebond.svg specification, v0.2 draft

This describes what the prototype in `drc.py` writes and reads. Fields marked *proposed* are not implemented.

## File extension

A wirebond.svg file uses the extension `.wb.svg`, for example `example.wb.svg`. The `.svg` ending lets any browser or SVG viewer open it, and `.wb` marks it as a wirebond.svg file and not a plain SVG.

## Rules

1. If it isn't drawn, it isn't in the file. `<metadata>` may hold only non-essential provenance.
2. One SVG user unit is 1 µm. Coordinates keep at most three decimals (1 nm). Parsers read the decimal text.
3. Namespace: `xmlns:wb="urn:wbsvg:0.2"`.
4. Names go in `wb:name`, never in `id`.
5. No scripts. Transforms are limited to translate, rotate and `scale(1 -1)`, and a uniform `scale(k)` on the board view (draft).
6. Minifiers are forbidden.

## Coordinates

File coordinates are SVG (y down). With a board, they're measured from the board's top-left corner, the extent of its Edge.Cuts, so every number is a position on the board. With no board, such as a lone padring footprint, they're measured from the top-left corner of the drawing's crop.

The die group's transform flips Y, so pad coordinates inside it are native GDS numbers, measured from the die outline's lower-left corner:

```xml
<g transform="translate(1750 4250) scale(1 -1)" wb:kind="die" ...>
```

A turned die adds a rotation between the two: `translate(x y) rotate(a) scale(1 -1)`.

The section view is a group with `wb:kind="stack"`, where z up is negative local y.

The board view (draft) is a group with `wb:kind="board"`: the whole board again, drawn smaller beside the bond diagram. Its transform is `translate(x y) scale(k)` and only places the drawing on the sheet. Inside it, coordinates are the file's board coordinates, so a reader takes what's in it as it stands and ignores the transform.

## Root attributes

`wb:version`, `wb:units="um"`, `wb:design`, `wb:rev`, `wb:rule-wire-gap`, `wb:rule-edge-clear`; draft `wb:rule-fid-clear`, `wb:data-sha256`, `wb:drawing-sha256` (see Seal).

## Element kinds

| `wb:kind` | Element | Geometry carries | Attributes |
|---|---|---|---|
| `die` | `g` | Placement in `transform` | `name`, `gds-cell`, `pad-layer` |
| `outline` | `rect` | Die or substrate outline | `name` optional |
| `pad` | `rect` in die group | Opening, GDS coordinates | `name`, `net` |
| `land` | `rect` | Finger or down-bond target | `name`, `net`, `finish` |
| `wire` | `line` | Bond points; `stroke-width` is diameter | `name`, `from`, `to`, `profile`, `seq`, `tier`, `net`; draft `to-kind` |
| `stack` | `g` | Section view frame | none |
| `layer` | `rect` in stack | z is `-(y + height)`, thickness is `height` | `name`, `role`, `material`; draft `datum` (its top face) |
| `profile` | `g` with `polyline` | Control points at `ref-span` | `name`, `material`, `style`, `dir`, `moves`, `interp`, `ref-span`; draft `choice` |
| `board` (draft) | `g` | The board view; see Coordinates | none |
| `part` (draft) | `rect` in the board view | A front-side component, by its courtyard, or its pads when it has none | `name`, `height` in µm above the board when known |
| `fiducial` (draft) | `circle`, `rect`, `path` or `g`, on the board or in a die group | Shape; its reference point is the centre of its bounding box | `name`, `role`, `datum` |
| `tolerance` (draft) | `g` | A drawn ISO 1101 tolerance indicator and its leader | `applies-to`, `char`, `tol`, `modifier`, `datums` |

Values: `role` is `substrate`, `attach`, `die` or `mold`. `style` is `ball-wedge` or `wedge-wedge`. `dir` is `forward` or `reverse`. `interp` is `polyline` or `spline`.

`wb:from` names a pad as `<die>.<pad>`, and `wb:to` names a land. `from` is always the first bond.

Draft, written by the app: a wire between two die has `wb:to` = `<die>.<pad>` and `wb:to-kind="die"`. A profile with `wb:choice="generic"` (the bonder picks, on purpose) or `wb:choice="undefined"` (nobody has said) has no material, diameter or moves. Its wires are drawn 20 µm wide, which is not a wire size, and the diameter and loop checks skip them.

Groups or shapes without `wb:kind` are derived decoration and are ignored by parsers.

## Loop moves

`wb:moves` is a list of `vertical/horizontal` steps, starting at the first bond. A vertical part is µm. A horizontal part is µm, or a percentage of the wire's horizontal span when written with `%`. After the last step, the wire runs straight to the second bond.

`180/0 30/12% -20/35%` rises 180 µm, rises 30 µm over 12% of span, falls 20 µm over 35% of span, then goes straight to the second bond.

## Validity

A file is valid when:

- each wire's first bond lies inside its named pad, and its second bond inside its named land
- the wire, pad and land nets agree, where they're named: a land with no net doesn't disagree with its pad
- `stroke-width` equals the profile's diameter
- the highest loop point is under the `mold` layer top
- loop clearance at the die edge meets `wb:rule-edge-clear`
- plan-view spacing between wires from different pads meets `wb:rule-wire-gap`
- no land is under the die or its attach fillet, which is half the attach layer's extra width
- with a placement tolerance, the forms present agree, each datum is on an element, and every check above still passes with the die at the edges of its zone
- draft: each fiducial is inside its frame, and no land or wire comes within `wb:rule-fid-clear` of a board fiducial (F2, F3 below)
- draft: where the file is sealed, `wb:data-sha256` matches its data (see Seal)

The checker also gives warnings and notes, which don't make a file invalid.

## Reading a file back

The Wire Bond Bench opens a `.wb.svg` it wrote, or one `drc.py` wrote, and makes it the session, ready to change and export again. It reads by `wb:kind` only:

| From the file | Becomes |
|---|---|
| `land`s, by name `<ref>.<number>` | the substrate's lands, one footprint per reference |
| each `die` group, its `outline` and `pad`s | a die at the same place and angle, with its pads and nets |
| an image in a die group, as `drc.py` writes it, or in a group titled `<name> artwork` just before it, as the app writes it | that die's artwork |
| `layer`s in the stack | each die's thickness and attach, which die it sits on, the board's thickness and the glob top |
| `profile`s | wire types, alongside the bench's own, so a wire can be given another |
| `wire`s | the wires, each bonding where the file put it |
| `wb:rule-wire-gap`, `wb:rule-edge-clear` | those rules, on at the file's numbers; left out means off |
| board `fiducial`s named `<ref>.F<n>` in the bond diagram, and copper drawn with class `mark` | the substrate's copper marks, as filled copper in footprint `<ref>` in the order written, each with its role |
| the board view: `outline`, `fiducial`s, `part`s and the picture | the board, which the next export writes again |

Writing the result straight back gives the same file, apart from the last nanometre of the side view's loop drawings. Not kept yet: eye points inside a die, because the bench has nowhere to put them. A file from `drc.py` comes back with the bench's names, D1 for its die and `L.L1` for land L1, and its loop drawings at the bench's reference span. The board it rebuilds is a picture of the original, so its copper has no nets; for a board to fabricate, open the original `.kicad_pcb`.

## Fiducials (draft)

A fiducial is a feature with a known position that a machine's camera can find. It finds two or more, compares where they are with where the file says, and corrects every bond position by that difference. A wire bonder does this twice: once for the die, from two eye points in the die's own artwork, to correct the first bonds; and once for the board, to correct the second bonds. [docs/primer/fiducials.html](docs/primer/fiducials.html) explains the background.

```xml
<!-- board frame: SVG coordinates -->
<circle cx="800" cy="5200" r="250" class="cu" wb:kind="fiducial" wb:name="F1" wb:role="align" wb:datum="B"/>
<circle cx="1450" cy="4600" r="150" class="cu" wb:kind="fiducial" wb:name="P1" wb:role="orient"/>

<g transform="translate(1750 4250) scale(1 -1)" wb:kind="die" wb:name="U1" ...>
  <!-- die frame: GDS coordinates -->
  <g wb:kind="fiducial" wb:name="QR" wb:role="align">
    <rect x="30" y="30" width="42" height="42" class="mark"/>
    ...
  </g>
  <path d="M2470,2470 L2330,2470 L2470,2330 Z" class="mark" wb:kind="fiducial" wb:name="TRI" wb:role="align"/>
</g>
```

| Part | Rule |
|---|---|
| Kind | `wb:kind="fiducial"`, for board marks and die eye points alike. |
| Frame | Set by where it sits. Inside a `die` group it belongs to that die and uses GDS coordinates, like a pad, so it moves with the die. Anywhere else it's on the board. |
| Shape | A `circle`, a `rect`, a `path` of straight segments only (`M L H V Z`, either case), or a `g` of those. A group carries the `wb:` attributes; its children carry none. |
| Reference point | The centre of the shape's bounding box, stroke ignored. For a circle, its centre. Nothing else sets it, so the point is always what's drawn. |
| `wb:name` | Unique within its frame. |
| `wb:role` | `align`, the default: a machine may fit to it. `orient`: a mark for people, such as a pin 1 dot or "the die's QR goes here"; no tool fits to it. |
| `wb:datum` | Optional. The same fiducial can be a datum for the placement tolerance and an alignment point. |
| Not in the file | Mask clearance around the mark, global versus local, and anything on the back of the board. These are for pick and place, which reads Gerbers and position files, and KiCad already carries them. |

`wb:rule-fid-clear` on the root is the least distance, in µm, from a board fiducial to any land or wire. Its value is ours, with no source behind it; the example uses 150.

### Checks

| Key | Check | Level |
|---|---|---|
| F1 | The board and each die have at least two `align` fiducials. If not, the bonding house picks its own. | Warning |
| F2 | A die fiducial is inside its die outline. A board fiducial is inside the substrate outline and not under a die or its attach fillet. | Error |
| F3 | No land or wire, in plan view, comes within `wb:rule-fid-clear` of a board fiducial's bounding box, or touches it. | Error |
| F4 | For each frame, the two `align` fiducials farthest apart, their spacing, and the lever ratio: the distance from their midpoint to the farthest bond they carry, over their spacing. The die's carry first bonds and the board's second bonds. Times the bonder's find error, the ratio is roughly the error at that bond. There's no limit until a bonding house gives us a find error. | Reported |
| F5 | A die's pair has the same shape and size and sits point-symmetric about the die centre, so a die turned 180° looks the same to them. | Warning |
| F6 | A die fiducial overlaps a pad that gets a wire. Fine for the first find, but the ball hides it from inspection or a re-teach. | Note |

F5 compares shape type and bounding box size, not the drawn geometry, so it can miss pairs that look alike.

### In and out

- **Copper marks:** board fiducials should be on the copper layer, because that is the layer the lands are etched in, so a mark there is registered to the lands; bonder makers ask for this. The bench reads small filled shapes on F.Cu in the substrate footprint, and its KiCad fiducial pads and unnumbered copper pads, within 2 mm of the lands, as copper marks named `<ref>.F<n>` in file order. A plus starts as `align`; the rest start unused, and a mark can be set to `align`, `orient` or unused. A used mark is written in the bond diagram as a board `fiducial` with the drawn geometry (a `path`, or a `circle` for a round one), `class="cu fid"`, in board coordinates; an unused one is copper with `class="cu mark"` and no `wb:kind`. The substrate footprint is never changed: in a KiCad export the roles are fields `wb_fiducial_<ref>.F<n>` on `WBLIB`, each `align`, `orient` or `off`.
- **KiCad:** a board fiducial is a footprint with `wb_kind` `fiducial`, `wb_role` and any `wb_datum`, holding one unnumbered pad at the reference point. An `align` fiducial's pad has KiCad's fabrication property, `(property pad_prop_fiducial_glob)`, so it's marked as a fiducial in the Gerbers. The mask opening is widened by `wb:rule-fid-clear`. Only circles and rectangles map to a pad so far. Die fiducials stay with the GDS.
- **GDS:** there's no fiducial layer. The example puts its eye points in top metal (81/0), each named by a text label on 81/10. Real wafer.space dies have a QR code at bottom left and a different mark in the opposite corner, but no labels.
- **Out:** `drc.py export` writes `<base>.fiducials.csv` with frame, name, role, datum and the reference point in the bond list's die-centred, y-up coordinates. The bonding house can teach from it.

## Placement tolerance (draft)

[docs/primer/gdt.html](docs/primer/gdt.html) explains the GD&T behind this section, and lists the steps to take it out of draft.

Pad, land and die coordinates are nominal. This draft adds one number per die: how far its pads may sit from their nominal places on the board. It follows ISO GPS geometrical tolerancing (ISO 1101, with ISO 5459 for datums) and uses one control only, a **position tolerance with CZ** (combined zone) on the die's bonded pads, referenced to three datums:

- **A**, the top face of the substrate, marked with `wb:datum="A"` on its stack layer.
- **B** and **C**, two board fiducials, for example `<circle wb:kind="fiducial" wb:role="align" wb:datum="B">`: copper marks that the die attach and bond machines can also find.

Position ⌀50 CZ means the centre of each bonded pad lies in a circle 50 µm across, centred on its nominal place, and the circles move together, because the pads are one piece of silicon. That limits shift and turn together: the example's die still fits shifted 25 µm in any direction, or turned 0.50° about its centre, which moves its farthest bonded pad 25 µm.

The tolerance holds the pads, not the sawn edge. The pads are the source of truth, and dies may later be separated by less precise methods than sawing. The sawn edge carries no tolerance; the edge clearance check will need a saw allowance instead.

### In the file

One group per die. Its `wb:` attributes are the data, and what it draws is the same rule for people:

```xml
<g wb:kind="tolerance" wb:applies-to="U1" wb:char="position" wb:tol="50" wb:modifier="CZ" wb:datums="A B C">
  <title>Position, diameter 50 um, combined zone (CZ), datums A | B | C: ...</title>
  <rect/> <line/> ...                                    the boxes
  <circle/> <path/>                                      the position symbol
  <text>⌀50 CZ</text> <text>A</text> <text>B</text> <text>C</text>
  <text>74×</text>                                       how many pads it holds
  <line/> <path/>                                        the leader, with its arrow on a bonded pad
</g>
```

| Attribute | Required | Value |
|---|---|---|
| `wb:applies-to` | yes | The `wb:name` of one die. The tolerance holds every pad of that die that a wire's `wb:from` names, or all its pads if none do. |
| `wb:char` | yes | `position`. The only characteristic this draft has. |
| `wb:tol` | yes | The zone's diameter in µm, greater than 0. |
| `wb:modifier` | yes | `CZ`: the pads' zones move as one. |
| `wb:datums` | yes | One to three datum letters, primary first, separated by spaces. Each must be on a `wb:datum` somewhere in the file. |

A reader takes the rule from these attributes alone and ignores what the group draws. A writer draws the group's children from the same values, so the two can't disagree. Some things are drawn from the rule as decoration, with no `wb:kind`:

- A circle of diameter `wb:tol` round each bonded pad's centre (the zone, `class="zone"`).
- A datum flag beside each datum: a filled triangle on the feature and the letter in a box.

At most one `tolerance` group per die. The x, y and θ limits a bonder or placement machine might want are derived from it, not stored.

Decided, November 2026:

- The tolerance indicator is the single place the number lives. A drawn zone is decoration, and the attributes on the die group (`wb:place-tol`, `wb:datums`) of the first draft are dropped.
- ISO GPS terms, not ASME Y14.5. `wb:kind="tolerance"` for ISO's "tolerance indicator"; the first draft's `wb:kind="fcf"` was ASME's "feature control frame".
- Position with CZ on the bonded pads, not profile on the sawn edge, because the pads are what the tolerance holds.
- One tolerance per die, one control only. No other characteristics yet.
- x, y and θ limits are derived for exports, not stored.

### What the checker does with it

The checker assumes the bonder finds the die by vision, as automatic bonders do: first bonds follow the die, and second bonds follow the lands. It moves the die to ten places at the edge of its zone and runs every check again: eight shifts of half the diameter, 45° apart, and each way the turn about the die's centre that brings its farthest bonded pad's centre to the edge of its circle. `drc.py place` finds how far the die can actually go.

For the example:

| Bonder | Largest shift | Largest turn | First to fail |
|---|---|---|---|
| Finds the die | 1,370 µm | 17.2° | W01 and W02, the first two wires, come within the 60 µm wire gap |
| Doesn't, bonds where programmed | 4.0 µm | | W01's ball leaves its 60 µm pad |

A bonder that finds the die has a lot of room here. The padring's lands are 1 mm long and more than 1.6 mm from the die, so moving the die only bends the fan-out, until two neighbouring wires come too close. The 50 µm zone leaves 187 µm of edge clearance in the worst case, against a 40 µm rule. A bonder that doesn't has almost none: the checker draws a 20 µm wire's ball 1.3 diameters each way from its centre, which leaves 4 µm on a 60 µm pad. These limits come only from the checks above. The app's other rules, such as wire angle and length, aren't in `drc.py`, so they may be tighter. A bonder's vision capture range also isn't checked; nobody here has that number yet.

## Seal (draft)

A `.wb.svg` is meant to be opened in any SVG editor, so it can be changed by hand: a wire's `wb:from` edited, a pad moved, or a label retyped so the drawing no longer says what the data does. The seal shows whether that happened after the file was written. A writer puts two SHA-256 digests on the root, as the last thing it does:

```xml
<svg ... wb:data-sha256="aed7…4f5f" wb:drawing-sha256="9fc5…182d">
```

| Attribute | Covers | Changed means |
|---|---|---|
| `wb:data-sha256` | What a reader reads: the root's `wb:` attributes, and every element with a `wb:kind` and everything inside it, except `title` and `desc` and the `class` and `style` attributes | The data was changed. An error. |
| `wb:drawing-sha256` | Everything drawn: every SVG element, its attributes and its text, `title`, `desc` and `style` included | Only the drawing was changed: labels, hover text or colours may not match the data. A warning. |

Neither covers `<metadata>`, which holds only provenance (rule 1), anything outside the SVG namespace, `id` attributes or an empty `<defs>`. Those are what an editor such as Inkscape adds when it opens and saves a file unchanged, so a plain re-save keeps the seal. Whitespace, attribute order, quoting and line endings don't count either. A file with no seal is still valid; the checker notes that edits can't be found.

**Canonical form.** Walk the elements in document order, from the root at depth 0. Skip, with everything inside it, an element outside the SVG namespace, a `metadata`, and a `defs` with no child elements. Each element left gives one line, the JSON array `[depth, name, attrs, text]`:

- `name` is the element's local name.
- `attrs` is a flat list `[name, value, name, value, …]` sorted by name. Attributes in no namespace keep their name, except `id`, which is left out. Attributes in `urn:wbsvg:0.2` are named `wb:<local>`, and on the root the two seal attributes are left out. `xlink:href` is named `href`. All others are left out.
- `text` is the element's own text nodes, not its children's, joined.
- In every value and in the text, each run of space, tab, CR and LF becomes one space, and a leading or trailing space is dropped.
- JSON with no spaces between items, and characters outside ASCII written as they are, not as `\u` escapes.

The drawing lines are every element's line. The data lines are the root's line with only its `wb:` attributes and empty text, then the line of each element that has a `wb:kind` or is inside one, except `title` and `desc`, with `class` and `style` left out of its attributes. Each digest is the lowercase hex SHA-256 of its lines joined by LF, in UTF-8.

**Writing.** Work out both digests from the file as written, then add the two attributes at the end of the root's start tag, replacing any already there, and change nothing else. `drc.py` (`write` and `seal()`), the Wire Bond Bench (`app/js/seal.js`) and `wbsvg.py` do the same and give the same bytes.

**Not a signature.** Anyone with these rules can work the digests out again, so the seal catches a file edited and passed on in good faith, not one changed on purpose by someone who then reseals it. Opening a file in the bench and writing it again also seals it afresh, and the bench says on opening when a seal doesn't match. To show who wrote a file, the digests would need signing: proposed below.

## Proposed

- a signature over the seal, such as Ed25519 with the writer's key, so a reader can tell who wrote a file and that nobody resealed it since
- fiducial `match`, linking an `orient` mark to the die fiducial that points at it, for example `wb:match="U1.QR"` on a pin 1 dot
- wire `via` for stitch chains, and `security-bump`
- profile `min`, `max`, `vendor-name`, `certified-by`, and angle units in moves
- a check of `part` heights against the capillary and glob top
- die `stack-layer` for multi-die stacks
- tolerances on other values, such as die thickness and bondline, which move loop heights, and a `none` versus `unspecified` distinction, following open.cob.json
- mappings to the JEDEC 4-point and 5-point bond wire models

---

<sub><img src="app/brand/wirebond-icon.svg" alt="" width="16" height="16"> Part of [wirebond.svg](https://github.com/anfroholic/wirebond.svg), a viewable wire bond exchange format, and its browser app Wire Bond Bench. (c) Andrew Wingate, MIT licence.</sub>
