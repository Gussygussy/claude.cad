# DWG Viewer

A browser-based viewer for AutoCAD **DWG** drawings. Everything runs locally in the browser — files are never uploaded.

## Features

- Opens DWG files from R13 up to AutoCAD 2018+ (`AC1012`–`AC1032`) via [LibreDWG](https://www.gnu.org/software/libredwg/) compiled to WebAssembly ([`@mlightcad/libredwg-web`](https://github.com/mlightcad/libredwg-web)), parsed in a Web Worker so the UI stays responsive
- Fast WebGL rendering of lines, polylines (incl. bulge arcs), circles, arcs, ellipses, splines, points, solids and solid hatches
- Block references (INSERT) with nested blocks, arrays, attributes and dimensions
- TEXT / MTEXT / ATTRIB labels with alignment, rotation and width factor
- True layer and entity colors (ACI + true color, ByLayer / ByBlock)
- Layer panel to toggle layers on/off
- Find text: search all labels and jump to a match
- Measure tool (distance, ΔX, ΔY, angle) and live cursor coordinates in drawing units
- Dark / light background, export the current view as PNG
- Pan (drag), zoom (wheel / pinch), double-click or `F` to fit

Keyboard: `F` fit · `M` measure · `T` toggle text · `Esc` exit measure.

## Running

It is a static site with no build step, but it must be served over HTTP (module workers don't run from `file://`):

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Any static host works (GitHub Pages, Netlify, etc.). The DWG engine (~11 MB WASM) and `earcut` are loaded from the jsDelivr CDN on first use, so an internet connection is required.

## Project layout

| File | Purpose |
| --- | --- |
| `index.html`, `css/style.css` | UI shell |
| `js/main.js` | File loading, side panel, toolbar, search |
| `js/dwg-worker.js` | Web Worker that parses DWG with LibreDWG (WASM) |
| `js/drawing.js` | Converts the DWG database into per-layer geometry and text |
| `js/viewer.js` | WebGL renderer + 2D overlay for text, measure and markers |
| `js/aci.js` | AutoCAD Color Index palette |

## Limitations

- 2D view only (Z is ignored); paper-space layouts are not shown — model space only
- Pattern hatches are drawn as their boundary outlines; linetypes and lineweights are drawn as continuous 1px lines
- SHX fonts are substituted with Arial
- DXF files aren't supported (the LibreDWG WASM build ships without the DXF reader)

## License note

LibreDWG and `@mlightcad/libredwg-web` are licensed under GPL-3.0.
