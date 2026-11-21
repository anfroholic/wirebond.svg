# wafer.space examples

The wafer.space logo die, [89Mods/ws-logo-die](https://github.com/89Mods/ws-logo-die): the [gf180mcu project template](https://github.com/wafer-space/gf180mcu-project-template) in the 1x1 slot with a big wafer.space logo in its core. It's this repo's main example: 3.932 × 5.122 mm with 74 bond pads, on the padring of the run-2 1x1 COB board from [chip-on-board-wire-bonded-pcbs](https://github.com/wafer-space/chip-on-board-wire-bonded-pcbs). [EuroSynth](https://github.com/anfroholic/eurosynth), a synth chip on the template's pad ring in the 1x0p5 slot, 3.932 × 2.531 mm with 72 pads, is here too, with its art. The Wire Bond Bench opens all of them from its welcome screen, and `../make_example.py` builds `../example.wb.svg` from the 1x1 files.

| File | What it is |
|---|---|
| `waferspace_1x1_die.gds` | The logo die, 1.7 MB (290 kB gzipped): the outline, the Pad layer (37/0), each pad's net label (81/10), and Metal1 to Metal5 of the IO ring, seal ring, QR code, small logo and big logo, so the app draws them as they are. See below for how it's put together. The core logic, a CPU and a VGA screensaver, is left out, so it isn't fit for tape-out |
| `waferspace_1x1_die.kicad_mod` | The logo die as a plain footprint: one copper pad per bond pad, numbered from clk counterclockwise, with its label as the pin function |
| `waferspace_default_padring_v0.2.kicad_mod` | The 1x1 padring the die bonds to, lifted out of the COB board and turned the way the board places it. Land n is meant for pad n |
| `cob/1x1-mezzanine.*` | The run-2 1x1 COB board, with its project, schematic and design rules. Its 3D models and footprint libraries aren't copied |
| `eurosynth_1x0p5_die.gds` | EuroSynth, 3.2 MB (650 kB gzipped), out of its 136 MB taped-out GDS: the outline, pads and labels, the IO ring, seal ring and ID cells in Metal1 to Metal5, its art (the EuroSynth logo, the music notes and the credits) on Metal5, and its core in Metal4 and Metal5 only: the power ring, straps and the top routing of its five synth engines. See below |
| `waferspace_1x0p5_padring_v0.1.kicad_mod` | The 1x0p5 padring |

## How the logo die is put together

ws-logo-die has no finished GDS in its repo, only its parts, so `make_waferspace.py` puts it together:

- **Pad ring and seal ring:** from the template's padring-only build. ws-logo-die keeps the template's 74 pads where they are, so these line up. Its supply pads are `gf180mcu_ws_io` cells rather than the template's `gf180mcu_fd_io` ones, which look nearly the same.
- **Corner cells and big logo:** from ws-logo-die. Its `librelane/config.yaml` places the QR code (`gf180mcu_ws_ip__id`) bottom left, the small logo (`gf180mcu_ws_ip__logo`) top right and `big_logo`, 2.55 mm square, at (700, 1305) µm. The template's SRAMs and ID cells are left out.
- **big_logo:** 125,815 squares of 3.4 µm per layer in the original, 48 MB. Every layer has the same squares, so they're merged once into a few outlines and copied onto each metal.

## How EuroSynth is cut down

EuroSynth's own GDS is a full build: five synth engines as hard macros, about 67,000 standard cells, and fill. Kept whole it's 136 MB. `make_waferspace.py --eurosynth` reads `final_chip/gds/chip_top.gds.gz`, the taped-out version with the art, and keeps:

- **Pad ring, seal ring and ID cells:** in Metal1 to Metal5, as for the logo die. Its pads are where the template's 1x0p5 pads are, with the same signal names. Its supply pads are labelled `VDD` and `VSS`, not `DVDD` and `DVSS`.
- **Art:** `eurosynth_logo`, `eurosynth_art` and `eurosynth_notes`. Each is drawn the same on every metal, about 90,000 points a layer, so only Metal5 is kept.
- **Core:** Metal4 and Metal5 only, in the top cell and in each engine, merged into one cell per engine. That's the power ring, the straps and the top routing, enough to show where each engine sits. Standard cells, vias, fill and the lower metal are left out.

## The padring

The 1x1 padring is v0.2 from the board, not v0.1 from `scratch/footprints`, because v0.1 numbers lands 57 and 58 the wrong way round, which crosses their wires.

`SOURCES.md` records the commit each file came from and how each die was built. Every repo is Apache-2.0.

## Rebuilding

With the template, chip-on-board-wire-bonded-pcbs, [ws-logo-die](https://github.com/89Mods/ws-logo-die) and [eurosynth](https://github.com/anfroholic/eurosynth) checked out next to this one, build the template for the 1x1 slot. EuroSynth's GDS is in its repo already. The pad ring alone is enough, since that's all the die keeps from it:

```sh
# in gf180mcu-project-template, in the LibreLane environment
make librelane-padring SLOT=1x1
```

Then, from this repo:

```sh
pip install gdstk lxml ezdxf
python examples/waferspace/make_waferspace.py --gds path/to/1x1/chip_top.gds --eurosynth
python examples/make_example.py
python examples/make_kicad.py
python app/make_samples.py
```

A slot left out keeps the files it has: the 1x1 die without `--gds`, EuroSynth without `--eurosynth`.

---

<sub><img src="../../app/brand/wirebond-icon.svg" alt="" width="16" height="16"> Part of [wirebond.svg](https://github.com/anfroholic/wirebond.svg), a viewable wire bond exchange format, and its browser app Wire Bond Bench. (c) Andrew Wingate, MIT licence.</sub>
