// Turns a LibreDWG database into flat, GPU-friendly geometry grouped by layer:
// line segments, filled triangles, points and text labels.
import earcut from 'https://cdn.jsdelivr.net/npm/earcut@3.0.1/src/earcut.js';
import { ACI, rgbIntToArray } from './aci.js';

const TAU = Math.PI * 2;
const ARC_STEP = Math.PI / 32; // max angle per tessellated arc segment
const MAX_INSERT_DEPTH = 16;
const DEFAULT_COLOR = [255, 255, 255];

// --- 2D affine matrices: [a, b, c, d, e, f] => x' = a*x + c*y + e, y' = b*x + d*y + f
const IDENTITY = [1, 0, 0, 1, 0, 0];
function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
const translate = (x, y) => [1, 0, 0, 1, x, y];
const scale = (sx, sy) => [sx, 0, 0, sy, 0, 0];
const rotate = (a) => [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

// Entities whose extrusion points down (0,0,-1) are mirrored in X (arbitrary axis algorithm).
function ocs(m, e) {
  const z = e.extrusionDirection?.z;
  return z !== undefined && z < 0 ? mul(m, scale(-1, 1)) : m;
}

// --- Curve tessellation (in entity-local coordinates)
function arcPoints(cx, cy, r, a0, sweep, out = []) {
  const n = Math.max(2, Math.ceil(Math.abs(sweep) / ARC_STEP));
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

function ccwSweep(start, end) {
  let s = end - start;
  while (s <= 0) s += TAU;
  while (s > TAU) s -= TAU;
  return s;
}

function ellipsePoints(cx, cy, mx, my, ratio, t0, t1, out = []) {
  const sweep = Math.abs(t1 - t0 - TAU) < 1e-9 ? TAU : ccwSweep(t0, t1);
  const n = Math.max(4, Math.ceil(sweep / ARC_STEP));
  const nx = -my * ratio, ny = mx * ratio; // minor axis = ratio * perpendicular(major)
  for (let i = 0; i <= n; i++) {
    const t = t0 + (sweep * i) / n;
    const c = Math.cos(t), s = Math.sin(t);
    out.push([cx + mx * c + nx * s, cy + my * c + ny * s]);
  }
  return out;
}

// Polyline vertices with bulges -> points
function bulgePolyline(vertices, closed) {
  const pts = [];
  const n = vertices.length;
  const segs = closed ? n : n - 1;
  if (n === 0) return pts;
  pts.push([vertices[0].x, vertices[0].y]);
  for (let i = 0; i < segs; i++) {
    const p1 = vertices[i], p2 = vertices[(i + 1) % n];
    const b = p1.bulge || 0;
    if (Math.abs(b) < 1e-9) {
      pts.push([p2.x, p2.y]);
      continue;
    }
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const k = (1 - b * b) / (4 * b);
    const cx = (p1.x + p2.x) / 2 - dy * k;
    const cy = (p1.y + p2.y) / 2 + dx * k;
    const r = Math.hypot(p1.x - cx, p1.y - cy);
    const a0 = Math.atan2(p1.y - cy, p1.x - cx);
    const arc = arcPoints(cx, cy, r, a0, 4 * Math.atan(b));
    for (let j = 1; j < arc.length; j++) pts.push(arc[j]);
  }
  return pts;
}

// Non-uniform rational B-spline evaluation (de Boor)
function nurbsPoints(degree, ctrl, knots, weights) {
  const n = ctrl.length;
  if (n < 2) return ctrl.map((p) => [p.x, p.y]);
  const p = Math.min(degree || 3, n - 1);
  if (!knots || knots.length !== n + p + 1) {
    knots = [];
    for (let i = 0; i <= n + p; i++) knots.push(i <= p ? 0 : i >= n ? n - p : i - p);
  }
  const w = weights && weights.length === n ? weights : null;
  const t0 = knots[p], t1 = knots[n];
  const samples = Math.max(16, n * 8);
  const out = [];
  for (let s = 0; s <= samples; s++) {
    const t = s === samples ? t1 - 1e-10 * (t1 - t0) : t0 + ((t1 - t0) * s) / samples;
    let k = p;
    while (k < n - 1 && t >= knots[k + 1]) k++;
    const d = [];
    for (let j = 0; j <= p; j++) {
      const c = ctrl[k - p + j];
      const wt = w ? w[k - p + j] : 1;
      d.push([c.x * wt, c.y * wt, wt]);
    }
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = k - p + j;
        const denom = knots[i + p - r + 1] - knots[i];
        const a = denom === 0 ? 0 : (t - knots[i]) / denom;
        for (let q = 0; q < 3; q++) d[j][q] = (1 - a) * d[j - 1][q] + a * d[j][q];
      }
    }
    out.push([d[p][0] / d[p][2], d[p][1] / d[p][2]]);
  }
  return out;
}

// Smooth curve through fit points (Catmull-Rom)
function fitPointCurve(fit) {
  const P = fit.map((p) => [p.x, p.y]);
  if (P.length < 3) return P;
  const out = [P[0]];
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
    for (let s = 1; s <= 8; s++) {
      const t = s / 8, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map((q) =>
        0.5 * (2 * p1[q] + (-p0[q] + p2[q]) * t + (2 * p0[q] - 5 * p1[q] + 4 * p2[q] - p3[q]) * t2 +
          (-p0[q] + 3 * p1[q] - 3 * p2[q] + p3[q]) * t3)));
    }
  }
  return out;
}

function splinePoints(e) {
  if (e.controlPoints?.length >= 2) return nurbsPoints(e.degree, e.controlPoints, e.knots, e.weights);
  if (e.fitPoints?.length >= 2) return fitPointCurve(e.fitPoints);
  return [];
}

// Hatch boundary path -> closed loop of points
function hatchLoop(path) {
  if (path.vertices) return bulgePolyline(path.vertices, true);
  const pts = [];
  for (const ed of path.edges || []) {
    let seg = [];
    if (ed.type === 1) {
      seg = [[ed.start.x, ed.start.y], [ed.end.x, ed.end.y]];
    } else if (ed.type === 2) {
      const ccw = ed.isCCW !== false;
      const a0 = ccw ? ed.startAngle : -ed.startAngle;
      const a1 = ccw ? ed.endAngle : -ed.endAngle;
      const sweep = ccw ? ccwSweep(a0, a1) : -ccwSweep(a1, a0);
      seg = arcPoints(ed.center.x, ed.center.y, ed.radius, a0, sweep);
    } else if (ed.type === 3) {
      const ccw = ed.isCCW !== false;
      seg = ellipsePoints(ed.center.x, ed.center.y, ed.end.x, ed.end.y, ed.lengthOfMinorAxis,
        ccw ? ed.startAngle : -ed.endAngle, ccw ? ed.endAngle : -ed.startAngle);
      if (!ccw) seg.reverse();
    } else if (ed.type === 4) {
      seg = ed.controlPoints?.length >= 2
        ? nurbsPoints(ed.degree, ed.controlPoints, ed.knots, ed.controlPoints.map((c) => c.weight ?? 1))
        : fitPointCurve(ed.fitDatum || []);
    }
    for (const p of seg) pts.push(p);
  }
  return pts;
}

function loopArea(loop) {
  let a = 0;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) a += (loop[j][0] - loop[i][0]) * (loop[j][1] + loop[i][1]);
  return a / 2;
}

function pointInLoop([x, y], loop) {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i], [xj, yj] = loop[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Triangulate loops with even-odd nesting: loops inside an odd number of others are holes.
function triangulateLoops(loops) {
  loops = loops.filter((l) => l.length >= 3 && Math.abs(loopArea(l)) > 0);
  const depth = loops.map((l, i) => loops.reduce((d, o, j) => d + (j !== i && pointInLoop(l[0], o) ? 1 : 0), 0));
  const tris = [];
  loops.forEach((outer, i) => {
    if (depth[i] % 2) return;
    const holes = loops.filter((h, j) => depth[j] === depth[i] + 1 && pointInLoop(h[0], outer));
    const flat = [];
    const holeIdx = [];
    for (const p of outer) flat.push(p[0], p[1]);
    for (const h of holes) {
      holeIdx.push(flat.length / 2);
      for (const p of h) flat.push(p[0], p[1]);
    }
    const idx = earcut(flat, holeIdx);
    for (const k of idx) tris.push([flat[k * 2], flat[k * 2 + 1]]);
  });
  return tris;
}

// --- Text helpers
const SPECIAL = { c: 'Ø', d: '°', p: '±', u: '', o: '', k: '' };
function decodeSpecials(s) {
  return s.replace(/%%([cdpuok%])/gi, (_, ch) => (ch === '%' ? '%' : SPECIAL[ch.toLowerCase()]))
    .replace(/\\U\+([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

export function stripMText(s) {
  return decodeSpecials(s)
    .replace(/\\P/g, '\n')
    .replace(/\\S([^;]*?)[\^#/]([^;]*?);/g, '$1/$2')
    .replace(/\\[ACFHQTWfcpaHhqtw][^;]*;/g, '')
    .replace(/\\[LlOoKkNX~]/g, (m) => (m === '\\~' ? ' ' : ''))
    .replace(/\\([\\{}])/g, '$1')
    .replace(/[{}]/g, '')
    .trim();
}

// --- Main builder
export function buildDrawing(db) {
  const layers = new Map();
  for (const l of db.tables?.LAYER?.entries || []) {
    const ci = Math.abs(l.colorIndex ?? 7);
    const color = ci >= 1 && ci <= 255 ? ACI[ci] : l.color !== undefined ? rgbIntToArray(l.color) : DEFAULT_COLOR;
    layers.set(l.name, {
      name: l.name,
      color,
      visible: !l.off && !l.frozen && (l.colorIndex ?? 1) >= 0,
      lines: [], tris: [], points: [], lineColors: [], triColors: [], pointColors: [],
      texts: [], count: 0,
    });
  }
  const getLayer = (name) => {
    if (!layers.has(name)) {
      layers.set(name, {
        name, color: DEFAULT_COLOR, visible: true,
        lines: [], tris: [], points: [], lineColors: [], triColors: [], pointColors: [], texts: [], count: 0,
      });
    }
    return layers.get(name);
  };

  const blocks = new Map();
  let modelSpace = null;
  for (const b of db.tables?.BLOCK_RECORD?.entries || []) {
    blocks.set(b.name, b);
    if (b.name.toUpperCase() === '*MODEL_SPACE') modelSpace = b;
  }
  // Fall back to entities that aren't owned by a block definition.
  const blockHandles = new Set([...blocks.values()].filter((b) => b !== modelSpace).map((b) => b.handle));
  const roots = modelSpace?.entities?.length
    ? modelSpace.entities
    : (db.entities || []).filter((e) => !e.isInPaperSpace && !blockHandles.has(e.ownerBlockRecordSoftId) && e.type !== 'ATTRIB');

  const stats = {};
  let skipped = 0;
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  const grow = (x, y) => {
    if (x < bbox[0]) bbox[0] = x;
    if (y < bbox[1]) bbox[1] = y;
    if (x > bbox[2]) bbox[2] = x;
    if (y > bbox[3]) bbox[3] = y;
  };

  function resolveColor(e, layer, parentColor) {
    if (e.color !== undefined && e.color !== null) return rgbIntToArray(e.color);
    const ci = e.colorIndex ?? 256;
    if (ci === 0) return parentColor || layer.color;
    if (ci >= 1 && ci <= 255) return ACI[ci];
    return layer.color;
  }

  function addPolyline(L, color, m, pts, closed = false) {
    if (pts.length < 2) return;
    let prev = apply(m, pts[0][0], pts[0][1]);
    const first = prev;
    grow(prev[0], prev[1]);
    for (let i = 1; i < pts.length; i++) {
      const cur = apply(m, pts[i][0], pts[i][1]);
      L.lines.push(prev[0], prev[1], cur[0], cur[1]);
      L.lineColors.push(color, color);
      grow(cur[0], cur[1]);
      prev = cur;
    }
    if (closed) {
      L.lines.push(prev[0], prev[1], first[0], first[1]);
      L.lineColors.push(color, color);
    }
  }

  function addTris(L, color, m, pts) {
    for (const p of pts) {
      const [x, y] = apply(m, p[0], p[1]);
      L.tris.push(x, y);
      L.triColors.push(color);
      grow(x, y);
    }
  }

  function addText(L, color, m, text, x, y, height, rotation, opts) {
    if (!text || !(height > 0)) return;
    const [wx, wy] = apply(m, x, y);
    const sx = Math.hypot(m[0], m[1]);
    const sy = Math.hypot(m[2], m[3]);
    const angle = Math.atan2(m[1], m[0]);
    L.texts.push({
      text, x: wx, y: wy, h: height * sy, rot: (rotation || 0) + angle,
      wf: (opts.widthFactor || 1) * (sx / (sy || 1)), color,
      halign: opts.halign, valign: opts.valign, mtext: !!opts.mtext,
    });
    grow(wx, wy);
  }

  // TEXT / ATTRIB style: 0 left, 1 center, 2 right, 3 aligned, 4 middle, 5 fit; v: 0 base, 1 bottom, 2 middle, 3 top
  function emitSingleLineText(L, color, m, t, layerEnt) {
    const h = t.halign || 0, v = t.valign || 0;
    const useAlign = (h !== 0 || v !== 0) && h !== 3 && h !== 5 && t.endPoint;
    const p = useAlign ? (layerEnt.alignmentPoint || t.endPoint) : t.startPoint;
    if (!p) return;
    const halign = h === 1 || h === 4 ? 'center' : h === 2 ? 'right' : 'left';
    const valign = h === 4 ? 'middle' : v === 3 ? 'top' : v === 2 ? 'middle' : v === 1 ? 'bottom' : 'alphabetic';
    addText(L, color, m, decodeSpecials(t.text), p.x, p.y, t.textHeight, t.rotation,
      { halign, valign, widthFactor: t.xScale });
  }

  function emit(e, m, parentLayer, parentColor, depth) {
    if (e.isVisible === false) return;
    const layerName = e.layer === '0' && parentLayer ? parentLayer : e.layer || '0';
    const L = getLayer(layerName);
    const color = resolveColor(e, L, parentColor);
    stats[e.type] = (stats[e.type] || 0) + 1;
    if (depth === 0) L.count++;

    switch (e.type) {
      case 'LINE':
        addPolyline(L, color, ocs(m, e), [[e.startPoint.x, e.startPoint.y], [e.endPoint.x, e.endPoint.y]]);
        break;
      case 'XLINE':
      case 'RAY': {
        // Draw construction lines as long segments.
        const p = e.firstPoint || e.position, d = e.unitDirection || e.direction;
        if (p && d) {
          const k = 1e5;
          const a = e.type === 'RAY' ? [p.x, p.y] : [p.x - d.x * k, p.y - d.y * k];
          addPolyline(L, color, m, [a, [p.x + d.x * k, p.y + d.y * k]]);
        }
        break;
      }
      case 'LWPOLYLINE': {
        const closed = (e.flag & 512) !== 0; // LibreDWG stores the DXF 'closed' bit as 512
        addPolyline(L, color, ocs(m, e), bulgePolyline(e.vertices || [], closed));
        break;
      }
      case 'POLYLINE2D':
      case 'POLYLINE3D': {
        const verts = (e.vertices || []).filter((v) => !(v.flag & 16)); // skip spline frame control points
        const closed = (e.flag & 1) !== 0;
        const pts = e.type === 'POLYLINE2D' ? bulgePolyline(verts, closed) : verts.map((v) => [v.x, v.y]);
        addPolyline(L, color, e.type === 'POLYLINE2D' ? ocs(m, e) : m, pts, e.type === 'POLYLINE3D' && closed);
        break;
      }
      case 'CIRCLE':
        addPolyline(L, color, ocs(m, e), arcPoints(e.center.x, e.center.y, e.radius, 0, TAU));
        break;
      case 'ARC':
        addPolyline(L, color, ocs(m, e),
          arcPoints(e.center.x, e.center.y, e.radius, e.startAngle, ccwSweep(e.startAngle, e.endAngle)));
        break;
      case 'ELLIPSE':
        addPolyline(L, color, ocs(m, e), ellipsePoints(e.center.x, e.center.y, e.majorAxisEndPoint.x,
          e.majorAxisEndPoint.y, e.axisRatio, e.startAngle, e.endAngle));
        break;
      case 'SPLINE':
        addPolyline(L, color, m, splinePoints(e), (e.flag & 1) !== 0);
        break;
      case 'LEADER':
        addPolyline(L, color, m, (e.vertices || []).map((v) => [v.x, v.y]));
        break;
      case 'POINT': {
        const [x, y] = apply(m, e.position.x, e.position.y);
        L.points.push(x, y);
        L.pointColors.push(color);
        grow(x, y);
        break;
      }
      case 'SOLID':
      case 'TRACE': {
        const c1 = e.corner1, c2 = e.corner2, c3 = e.corner3, c4 = e.corner4 || e.corner3;
        const om = ocs(m, e);
        addTris(L, color, om, [[c1.x, c1.y], [c2.x, c2.y], [c3.x, c3.y], [c2.x, c2.y], [c4.x, c4.y], [c3.x, c3.y]]);
        break;
      }
      case '3DFACE': {
        const cs = [e.corner1, e.corner2, e.corner3, e.corner4 || e.corner3].map((c) => [c.x, c.y]);
        addPolyline(L, color, m, cs, true);
        break;
      }
      case 'HATCH': {
        const om = ocs(m, e);
        const loops = (e.boundaryPaths || []).map(hatchLoop).filter((l) => l.length >= 2);
        if (e.solidFill === 1 || e.patternName?.toUpperCase() === 'SOLID') {
          try {
            addTris(L, color, om, triangulateLoops(loops));
          } catch {
            for (const l of loops) addPolyline(L, color, om, l, true);
          }
        } else {
          for (const l of loops) addPolyline(L, color, om, l, true);
        }
        break;
      }
      case 'TEXT':
        emitSingleLineText(L, color, ocs(m, e), e, e);
        break;
      case 'ATTRIB':
        if (!(e.flags & 1) && e.text) emitSingleLineText(L, color, m, e.text, e);
        break;
      case 'MTEXT': {
        const ap = e.attachmentPoint || 1;
        const halign = ['left', 'center', 'right'][(ap - 1) % 3];
        const valign = ['top', 'middle', 'bottom'][Math.floor((ap - 1) / 3)];
        let rot = e.rotation || 0;
        if (e.direction && (e.direction.x || e.direction.y)) rot = Math.atan2(e.direction.y, e.direction.x);
        addText(L, color, ocs(m, e), stripMText(e.text || ''), e.insertionPoint.x, e.insertionPoint.y,
          e.textHeight, rot, { halign, valign, mtext: true });
        break;
      }
      case 'INSERT': {
        const block = blocks.get(e.name);
        if (block && depth < MAX_INSERT_DEPTH) {
          const base = block.basePoint || { x: 0, y: 0 };
          const cols = Math.max(1, e.columnCount || 1), rows = Math.max(1, e.rowCount || 1);
          const om = ocs(m, e);
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const local = mul(
                mul(mul(translate(e.insertionPoint.x, e.insertionPoint.y), rotate(e.rotation || 0)),
                  translate(c * (e.columnSpacing || 0), r * (e.rowSpacing || 0))),
                mul(scale(e.xScale || 1, e.yScale || 1), translate(-base.x, -base.y)));
              const bm = mul(om, local);
              for (const child of block.entities || []) {
                if (child.type === 'ATTDEF') continue;
                emit(child, bm, layerName, color, depth + 1);
              }
            }
          }
        }
        // Attributes are stored in the same coordinate system as the insert itself.
        for (const a of e.attribs || []) emit(a, m, layerName, color, depth + 1);
        break;
      }
      case 'DIMENSION': {
        const block = blocks.get(e.name);
        if (block && depth < MAX_INSERT_DEPTH) {
          for (const child of block.entities || []) emit(child, m, layerName, color, depth + 1);
        } else if (e.textPoint) {
          addText(L, color, m, e.text || (e.measurement?.toFixed(2) ?? ''), e.textPoint.x, e.textPoint.y,
            2.5, e.textRotation, { halign: 'center', valign: 'middle' });
        }
        break;
      }
      default:
        skipped++;
    }
  }

  for (const e of roots) {
    if (e.type === 'ATTRIB' || e.type === 'ATTDEF') continue;
    emit(e, IDENTITY, null, null, 0);
  }

  // Shift everything near the origin so Float32 GPU buffers keep full precision
  // (survey drawings often use UTM coordinates in the millions).
  const valid = Number.isFinite(bbox[0]);
  const origin = valid ? [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2] : [0, 0];
  const out = [];
  let textCount = 0;
  for (const L of layers.values()) {
    const lines = new Float32Array(L.lines.length);
    for (let i = 0; i < L.lines.length; i += 2) {
      lines[i] = L.lines[i] - origin[0];
      lines[i + 1] = L.lines[i + 1] - origin[1];
    }
    const tris = new Float32Array(L.tris.length);
    for (let i = 0; i < L.tris.length; i += 2) {
      tris[i] = L.tris[i] - origin[0];
      tris[i + 1] = L.tris[i + 1] - origin[1];
    }
    const points = new Float32Array(L.points.length);
    for (let i = 0; i < L.points.length; i += 2) {
      points[i] = L.points[i] - origin[0];
      points[i + 1] = L.points[i + 1] - origin[1];
    }
    for (const t of L.texts) {
      t.x -= origin[0];
      t.y -= origin[1];
    }
    textCount += L.texts.length;
    out.push({
      name: L.name, color: L.color, visible: L.visible, count: L.count,
      lines, lineColors: packColors(L.lineColors),
      tris, triColors: packColors(L.triColors),
      points, pointColors: packColors(L.pointColors),
      texts: L.texts,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  return {
    layers: out,
    origin,
    bounds: valid ? [bbox[0] - origin[0], bbox[1] - origin[1], bbox[2] - origin[0], bbox[3] - origin[1]] : [-1, -1, 1, 1],
    stats,
    skipped,
    textCount,
    modelEntityCount: roots.length,
  };
}

function packColors(list) {
  const arr = new Uint8Array(list.length * 3);
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    arr[i * 3] = c[0];
    arr[i * 3 + 1] = c[1];
    arr[i * 3 + 2] = c[2];
  }
  return arr;
}
