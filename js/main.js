import { Viewer } from './viewer.js';
import { buildDrawing } from './drawing.js';
import { rgbToCss } from './aci.js';
import { makeGeoref, looksLikeUtm } from './geo.js';
import { PROVIDERS } from './basemap.js';

const $ = (id) => document.getElementById(id);

const VERSIONS = {
  AC1012: 'R13', AC1014: 'R14', AC1015: 'AutoCAD 2000', AC1018: 'AutoCAD 2004',
  AC1021: 'AutoCAD 2007', AC1024: 'AutoCAD 2010', AC1027: 'AutoCAD 2013', AC1032: 'AutoCAD 2018+',
};
const UNITS = ['Unitless', 'Inches', 'Feet', 'Miles', 'Millimeters', 'Centimeters', 'Meters', 'Kilometers',
  'Microinches', 'Mils', 'Yards', 'Angstroms', 'Nanometers', 'Microns', 'Decimeters', 'Decameters',
  'Hectometers', 'Gigameters', 'Astronomical units', 'Light years', 'Parsecs'];

const viewer = new Viewer($('canvas-wrap'));
let drawing = null;
let worker = null;
let jobId = 0;

// --- Loading
function getWorker() {
  if (!worker) worker = new Worker(new URL('./dwg-worker.js', import.meta.url), { type: 'module' });
  return worker;
}

function parseInWorker(buffer, onStatus) {
  const id = ++jobId;
  const w = getWorker();
  return new Promise((resolve, reject) => {
    const handler = (e) => {
      if (e.data.id !== id) return;
      if (e.data.status) return onStatus(e.data.status);
      w.removeEventListener('message', handler);
      w.removeEventListener('error', onError);
      e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.db);
    };
    const onError = (e) => {
      w.removeEventListener('message', handler);
      worker = null;
      reject(new Error(e.message || 'The DWG engine failed to load. Check your internet connection.'));
    };
    w.addEventListener('message', handler);
    w.addEventListener('error', onError);
    w.postMessage({ id, buffer }, [buffer]);
  });
}

function setLoading(text) {
  $('loading').classList.toggle('hidden', !text);
  if (text) $('loading-text').textContent = text;
}

function showError(msg) {
  const el = $('error');
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}

async function openFile(file) {
  if (!file) return;
  showError('');
  if (!/\.dwg$/i.test(file.name)) {
    showError(`"${file.name}" is not a .dwg file.`);
    return;
  }
  const t0 = performance.now();
  try {
    setLoading('Reading file…');
    const buffer = await file.arrayBuffer();
    const magic = new TextDecoder().decode(new Uint8Array(buffer, 0, 6));
    if (!/^AC\d{4}$/.test(magic)) throw new Error('This does not look like a DWG file (missing AC10xx header).');
    const db = await parseInWorker(buffer, setLoading);
    setLoading('Building geometry…');
    await new Promise((r) => setTimeout(r, 0));
    drawing = buildDrawing(db);
    drawing.file = { name: file.name, size: file.size, version: magic, header: db.header };
    drawing.loadMs = performance.now() - t0;
    viewer.setDrawing(drawing);
    onDrawingLoaded();
  } catch (err) {
    console.error(err);
    showError(`Could not open "${file.name}": ${err.message}`);
  } finally {
    setLoading('');
  }
}

// --- UI population
function onDrawingLoaded() {
  $('dropzone').classList.add('hidden');
  $('file-name').textContent = drawing.file.name;
  document.title = `${drawing.file.name} — DWG Viewer`;
  for (const id of ['btn-extents', 'btn-measure', 'btn-text', 'btn-points', 'btn-png']) $(id).disabled = false;
  renderInfo();
  updateGeoref();
  renderLayers();
  runSearch();
}

function renderInfo() {
  const { file, stats, layers, origin, bounds, loadMs } = drawing;
  const h = file.header || {};
  const fmt = (n, d = 3) => n.toLocaleString(undefined, { maximumFractionDigits: d });
  const totalEntities = Object.values(stats).reduce((a, b) => a + b, 0);
  const top = Object.entries(stats).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${fmt(v, 0)}`).join(', ');
  const rows = [
    ['Version', `${VERSIONS[file.version] || 'Unknown'} (${file.version})`],
    ['File size', `${(file.size / 1048576).toFixed(2)} MB`],
    ['Units', UNITS[h.INSUNITS] ?? '—'],
    ['Layers', layers.length],
    ['Model entities', fmt(drawing.modelEntityCount, 0)],
    ['Expanded', fmt(totalEntities, 0)],
    ['Text labels', fmt(drawing.textCount, 0)],
    ['Width × height', `${fmt(bounds[2] - bounds[0])} × ${fmt(bounds[3] - bounds[1])}`],
    ['Min', `${fmt(bounds[0] + origin[0])}, ${fmt(bounds[1] + origin[1])}`],
    ['Max', `${fmt(bounds[2] + origin[0])}, ${fmt(bounds[3] + origin[1])}`],
    ['Loaded in', `${(loadMs / 1000).toFixed(2)} s`],
    ['Types', top],
  ];
  if (drawing.skipped) rows.push(['Not drawn', `${fmt(drawing.skipped, 0)} unsupported entities`]);
  const dl = $('info');
  dl.replaceChildren();
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = k;
    dd.textContent = v;
    dl.append(dt, dd);
  }
}

function renderLayers() {
  const ul = $('layers');
  ul.replaceChildren();
  const list = drawing.layers.filter((L) => L.lines.length || L.tris.length || L.points.length || L.texts.length);
  $('layer-count').textContent = `(${list.length})`;
  for (const L of list) {
    const li = document.createElement('li');
    li.classList.toggle('off', !L.visible);
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = L.visible;
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = rgbToCss(L.color);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = L.name;
    name.title = L.name;
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = L.count.toLocaleString();
    li.append(cb, sw, name, n);
    const set = (v) => {
      L.visible = v;
      cb.checked = v;
      li.classList.toggle('off', !v);
      viewer.requestRender();
    };
    li.addEventListener('click', (e) => {
      if (e.target !== cb) set(!L.visible);
      else set(cb.checked);
    });
    L._set = set;
    ul.append(li);
  }
}

$('layers-all').addEventListener('click', () => drawing?.layers.forEach((L) => L._set?.(true)));
$('layers-none').addEventListener('click', () => drawing?.layers.forEach((L) => L._set?.(false)));

// --- Georeference & basemap
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};
$('utm-zone').value = store.get('utmZone', '23');
$('utm-hemi').value = store.get('utmHemi', 'S');
$('map-opacity').value = store.get('mapOpacity', '1');
let basemapKey = '';

function updateGeoref() {
  const zone = Math.round(Number($('utm-zone').value));
  const south = $('utm-hemi').value === 'S';
  const status = $('geo-status');
  let georef = null;
  if (drawing) {
    const [ox, oy] = drawing.origin;
    if (!looksLikeUtm(ox, oy)) {
      status.textContent = 'These coordinates don\'t look like UTM, so the drawing can\'t be placed on the map.';
    } else if (!(zone >= 1 && zone <= 60)) {
      status.textContent = 'Enter a UTM zone between 1 and 60.';
    } else {
      georef = makeGeoref(drawing.origin, zone, south);
      const [lat, lon] = georef.toLatLon(0, 0);
      status.replaceChildren(
        `Center ${lat.toFixed(5)}, ${lon.toFixed(5)} · `,
        Object.assign(document.createElement('a'), {
          href: `https://www.openstreetmap.org/?mlat=${lat.toFixed(6)}&mlon=${lon.toFixed(6)}#map=16/${lat.toFixed(6)}/${lon.toFixed(6)}`,
          target: '_blank', rel: 'noopener', textContent: 'open in OpenStreetMap',
        }),
      );
    }
  }
  viewer.setGeoref(georef);
  for (const b of document.querySelectorAll('#basemap-buttons [data-basemap]')) {
    if (b.dataset.basemap) b.disabled = !georef;
  }
  setBasemap(georef ? basemapKey : '');
}

function setBasemap(key) {
  if (viewer.georef) basemapKey = key;
  const active = viewer.georef ? key : '';
  for (const b of document.querySelectorAll('#basemap-buttons [data-basemap]')) {
    b.classList.toggle('active', b.dataset.basemap === active);
  }
  viewer.setBasemap(active || null, $('map-opacity').value);
  const attr = $('attribution');
  const P = PROVIDERS[active];
  attr.classList.toggle('hidden', !P);
  if (P) {
    attr.textContent = P.attribution;
    attr.href = P.attributionUrl;
  }
}

document.querySelectorAll('#basemap-buttons [data-basemap]').forEach((b) =>
  b.addEventListener('click', () => setBasemap(b.dataset.basemap)));
for (const id of ['utm-zone', 'utm-hemi']) {
  $(id).addEventListener('change', () => {
    store.set('utmZone', $('utm-zone').value);
    store.set('utmHemi', $('utm-hemi').value);
    updateGeoref();
  });
}
$('map-opacity').addEventListener('input', () => {
  store.set('mapOpacity', $('map-opacity').value);
  viewer.setBasemap(viewer.basemap.provider, $('map-opacity').value);
});

// --- Text search
function runSearch() {
  const ul = $('results');
  ul.replaceChildren();
  const q = $('search').value.trim().toLowerCase();
  if (!drawing || !q) return;
  const hits = [];
  for (const L of drawing.layers) {
    for (const t of L.texts) if (t.text.toLowerCase().includes(q)) hits.push([t, L]);
  }
  const MAX = 200;
  for (const [t, L] of hits.slice(0, MAX)) {
    const li = document.createElement('li');
    const s = document.createElement('span');
    s.textContent = t.text.replace(/\n/g, ' ⏎ ');
    const l = document.createElement('span');
    l.className = 'layer';
    l.textContent = L.name;
    li.append(s, l);
    li.addEventListener('click', () => {
      if (!L.visible) L._set?.(true);
      viewer.focusOn(t.x, t.y, t.h);
    });
    ul.append(li);
  }
  if (!hits.length || hits.length > MAX) {
    const li = document.createElement('li');
    li.className = 'more';
    li.textContent = hits.length ? `${hits.length - MAX} more… refine your search` : 'No matches';
    ul.append(li);
  }
}
let searchTimer;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 150);
});

// --- Toolbar
$('file-input').addEventListener('change', (e) => {
  openFile(e.target.files[0]);
  e.target.value = '';
});
$('btn-extents').addEventListener('click', () => viewer.zoomExtents());

function toggleButton(id, value) {
  $(id).classList.toggle('active', value);
}
$('btn-measure').addEventListener('click', () => setMeasure(!viewer.measureMode));
function setMeasure(on) {
  viewer.setMeasureMode(on);
  toggleButton('btn-measure', on);
  $('measure-result').classList.add('hidden');
  $('status-msg').textContent = on ? 'Measure: click two points (Esc to exit)' : '';
}
$('btn-text').addEventListener('click', () => {
  viewer.showText = !viewer.showText;
  toggleButton('btn-text', viewer.showText);
  viewer.requestRender();
});
$('btn-points').addEventListener('click', () => {
  viewer.showPoints = !viewer.showPoints;
  toggleButton('btn-points', viewer.showPoints);
  viewer.requestRender();
});
$('btn-theme').addEventListener('click', () => {
  viewer.setLight(!viewer.light);
  $('canvas-wrap').style.background = viewer.light ? '#fff' : '';
});
$('btn-panel').addEventListener('click', () => {
  document.querySelector('.layout').classList.toggle('no-panel');
});
$('btn-png').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = viewer.toPNG();
  a.download = (drawing?.file.name || 'drawing').replace(/\.dwg$/i, '') + '.png';
  a.click();
});

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || !drawing) return;
  if (e.key === 'Escape' && viewer.measureMode) setMeasure(false);
  else if (e.key === 'f' || e.key === 'F') viewer.zoomExtents();
  else if (e.key === 'm' || e.key === 'M') setMeasure(!viewer.measureMode);
  else if (e.key === 't' || e.key === 'T') $('btn-text').click();
});

// --- Status bar
const fmtCoord = (v) => v.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
viewer.onCursor = ([x, y]) => {
  if (!drawing) return;
  let text = `X ${fmtCoord(x + drawing.origin[0])}   Y ${fmtCoord(y + drawing.origin[1])}`;
  if (viewer.georef) {
    const [lat, lon] = viewer.georef.toLatLon(x, y);
    text += `   ·   ${lat.toFixed(6)}, ${lon.toFixed(6)}`;
  }
  $('coords').textContent = text;
};
viewer.onMeasure = ({ a, b }) => {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
  const el = $('measure-result');
  el.textContent = `Distance ${fmtCoord(Math.hypot(dx, dy))}   ΔX ${fmtCoord(dx)}   ΔY ${fmtCoord(dy)}   Angle ${ang.toFixed(2)}°`;
  el.classList.remove('hidden');
};

// --- Drag & drop
const wrap = $('canvas-wrap');
const dz = $('dropzone');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  dz.classList.remove('hidden');
  dz.classList.add('dragover');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth > 0) return;
  dz.classList.remove('dragover');
  if (drawing) dz.classList.add('hidden');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  dz.classList.remove('dragover');
  if (drawing) dz.classList.add('hidden');
  openFile(e.dataTransfer.files[0]);
});

// Warm up the WASM engine in the background so the first open is faster.
wrap.addEventListener('pointerenter', () => getWorker(), { once: true });
