// 2D CAD viewer: WebGL for geometry, a 2D canvas overlay for text, measurements and markers.

const VERT = `
attribute vec2 a_pos;
attribute vec3 a_col;
uniform vec2 u_center;
uniform vec2 u_scale;
uniform float u_light;
uniform float u_pointSize;
varying vec3 v_col;
void main() {
  gl_Position = vec4((a_pos - u_center) * u_scale, 0.0, 1.0);
  gl_PointSize = u_pointSize;
  vec3 c = a_col;
  // ACI 7 / white is drawn black on light backgrounds, like AutoCAD does.
  if (u_light > 0.5 && c.r > 0.95 && c.g > 0.95 && c.b > 0.95) c = vec3(0.0);
  v_col = c;
}`;

const FRAG = `
precision mediump float;
varying vec3 v_col;
void main() { gl_FragColor = vec4(v_col, 1.0); }`;

const MIN_TEXT_PX = 3;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

export class Viewer {
  constructor(container) {
    this.container = container;
    this.glCanvas = document.createElement('canvas');
    this.overlay = document.createElement('canvas');
    this.glCanvas.className = 'gl-layer';
    this.overlay.className = 'overlay-layer';
    container.append(this.glCanvas, this.overlay);

    const gl = this.glCanvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL is not available in this browser.');
    this.gl = gl;
    this.ctx = this.overlay.getContext('2d');

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    this.prog = prog;
    this.loc = {
      pos: gl.getAttribLocation(prog, 'a_pos'),
      col: gl.getAttribLocation(prog, 'a_col'),
      center: gl.getUniformLocation(prog, 'u_center'),
      scale: gl.getUniformLocation(prog, 'u_scale'),
      light: gl.getUniformLocation(prog, 'u_light'),
      pointSize: gl.getUniformLocation(prog, 'u_pointSize'),
    };

    this.drawing = null;
    this.buffers = [];
    this.view = { cx: 0, cy: 0, zoom: 1 };
    this.light = false;
    this.showText = true;
    this.showPoints = true;
    this.measure = null; // { a: [x,y], b: [x,y] | null, hover: [x,y] }
    this.measureMode = false;
    this.marker = null;
    this.onCursor = null;
    this.onMeasure = null;
    this._dirty = false;
    this._widthCache = new WeakMap();

    this._bindEvents();
    new ResizeObserver(() => this._resize()).observe(container);
    this._resize();
  }

  // --- Data
  setDrawing(drawing) {
    const gl = this.gl;
    for (const b of this.buffers) for (const k of ['lp', 'lc', 'tp', 'tc', 'pp', 'pc']) if (b[k]) gl.deleteBuffer(b[k]);
    this.drawing = drawing;
    this.buffers = drawing.layers.map((L) => {
      const mk = (data) => {
        if (!data.length) return null;
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        return buf;
      };
      return {
        layer: L,
        lp: mk(L.lines), lc: mk(L.lineColors), ln: L.lines.length / 2,
        tp: mk(L.tris), tc: mk(L.triColors), tn: L.tris.length / 2,
        pp: mk(L.points), pc: mk(L.pointColors), pn: L.points.length / 2,
      };
    });
    this.measure = null;
    this.marker = null;
    this.zoomExtents();
  }

  zoomExtents() {
    if (!this.drawing) return;
    const [x0, y0, x1, y1] = this.drawing.bounds;
    this.fitBox(x0, y0, x1, y1);
  }

  fitBox(x0, y0, x1, y1, padding = 0.05) {
    const w = Math.max(x1 - x0, 1e-9), h = Math.max(y1 - y0, 1e-9);
    this.view.cx = (x0 + x1) / 2;
    this.view.cy = (y0 + y1) / 2;
    this.view.zoom = Math.min(this.width / w, this.height / h) * (1 - padding * 2);
    this.requestRender();
  }

  focusOn(x, y, textHeight) {
    this.view.cx = x;
    this.view.cy = y;
    this.view.zoom = Math.max(40 / (textHeight || 1), this.view.zoom);
    this.marker = { x, y, until: performance.now() + 2500 };
    this.requestRender();
    setTimeout(() => this.requestRender(), 2600);
  }

  setLight(light) { this.light = light; this.requestRender(); }

  // --- Coordinates
  screenToWorld(sx, sy) {
    const { cx, cy, zoom } = this.view;
    return [cx + (sx - this.width / 2) / zoom, cy - (sy - this.height / 2) / zoom];
  }
  worldToScreen(x, y) {
    const { cx, cy, zoom } = this.view;
    return [(x - cx) * zoom + this.width / 2, this.height / 2 - (y - cy) * zoom];
  }

  // --- Rendering
  requestRender() {
    if (this._dirty) return;
    this._dirty = true;
    requestAnimationFrame(() => {
      this._dirty = false;
      this.render();
    });
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.container.getBoundingClientRect();
    const hadSize = this.width > 0;
    const oldW = this.width, oldH = this.height;
    this.width = Math.max(1, r.width);
    this.height = Math.max(1, r.height);
    this.dpr = dpr;
    for (const c of [this.glCanvas, this.overlay]) {
      c.width = Math.round(this.width * dpr);
      c.height = Math.round(this.height * dpr);
    }
    // Keep the same world area visible when the window changes size.
    if (hadSize && this.drawing) this.view.zoom *= Math.min(this.width / oldW, this.height / oldH);
    this.requestRender();
  }

  render() {
    const gl = this.gl;
    const bg = this.light ? [1, 1, 1] : [0.11, 0.12, 0.14];
    gl.viewport(0, 0, this.glCanvas.width, this.glCanvas.height);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.drawing) return;

    gl.useProgram(this.prog);
    gl.uniform2f(this.loc.center, this.view.cx, this.view.cy);
    gl.uniform2f(this.loc.scale, (this.view.zoom * 2) / this.width, (this.view.zoom * 2) / this.height);
    gl.uniform1f(this.loc.light, this.light ? 1 : 0);
    gl.uniform1f(this.loc.pointSize, 3 * this.dpr);
    gl.enableVertexAttribArray(this.loc.pos);
    gl.enableVertexAttribArray(this.loc.col);

    const draw = (posBuf, colBuf, count, mode) => {
      if (!posBuf || !count) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.vertexAttribPointer(this.loc.pos, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
      gl.vertexAttribPointer(this.loc.col, 3, gl.UNSIGNED_BYTE, true, 0, 0);
      gl.drawArrays(mode, 0, count);
    };
    const visible = this.buffers.filter((b) => b.layer.visible);
    for (const b of visible) draw(b.tp, b.tc, b.tn, gl.TRIANGLES);
    for (const b of visible) draw(b.lp, b.lc, b.ln, gl.LINES);
    if (this.showPoints) for (const b of visible) draw(b.pp, b.pc, b.pn, gl.POINTS);

    if (this.showText) this._drawTexts(visible);
    this._drawMeasure();
    this._drawMarker();
  }

  _textColor(c) {
    if (this.light && c[0] > 242 && c[1] > 242 && c[2] > 242) return '#000';
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  _drawTexts(visible) {
    const ctx = this.ctx;
    const { zoom } = this.view;
    const W = this.width, H = this.height;
    let drawn = 0;
    for (const b of visible) {
      for (const t of b.layer.texts) {
        const px = t.h * zoom;
        if (px < MIN_TEXT_PX) continue;
        const [sx, sy] = this.worldToScreen(t.x, t.y);
        const lines = t._lines || (t._lines = t.text.split('\n'));
        const longest = t._longest || (t._longest = Math.max(...lines.map((l) => l.length)));
        const wf = Math.min(3, Math.max(0.3, t.wf || 1));
        const reach = (longest * 0.7 * wf + 1) * px + lines.length * px * 1.7;
        if (sx + reach < 0 || sx - reach > W || sy + reach < 0 || sy - reach > H) continue;

        ctx.save();
        ctx.translate(sx, sy);
        if (t.rot) ctx.rotate(-t.rot);
        if (wf !== 1) ctx.scale(wf, 1);
        ctx.font = `${px}px Arial, Helvetica, sans-serif`;
        ctx.fillStyle = this._textColor(t.color);
        ctx.textAlign = t.halign || 'left';
        const lh = px * 1.667;
        if (lines.length === 1) {
          ctx.textBaseline = t.valign || 'alphabetic';
          ctx.fillText(lines[0], 0, 0);
        } else {
          ctx.textBaseline = 'top';
          const total = lh * (lines.length - 1) + px;
          let y0 = t.valign === 'middle' ? -total / 2 : t.valign === 'bottom' ? -total : 0;
          for (const line of lines) {
            ctx.fillText(line, 0, y0);
            y0 += lh;
          }
        }
        ctx.restore();
        drawn++;
      }
    }
    this.textsDrawn = drawn;
  }

  _drawMeasure() {
    const m = this.measure;
    if (!m || !m.a) return;
    const b = m.b || m.hover;
    const ctx = this.ctx;
    const [ax, ay] = this.worldToScreen(...m.a);
    ctx.save();
    ctx.strokeStyle = '#ffb000';
    ctx.fillStyle = '#ffb000';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(ax, ay, 4, 0, Math.PI * 2);
    ctx.fill();
    if (b) {
      const [bx, by] = this.worldToScreen(...b);
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(bx, by, 4, 0, Math.PI * 2);
      ctx.fill();
      const d = Math.hypot(b[0] - m.a[0], b[1] - m.a[1]);
      const label = d.toFixed(3);
      ctx.font = '600 13px system-ui, sans-serif';
      const tw = ctx.measureText(label).width;
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(mx - tw / 2 - 6, my - 22, tw + 12, 20);
      ctx.fillStyle = '#ffb000';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, mx, my - 12);
    }
    ctx.restore();
  }

  _drawMarker() {
    const mk = this.marker;
    if (!mk || performance.now() > mk.until) return;
    const [x, y] = this.worldToScreen(mk.x, mk.y);
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = '#ff3b6b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 18, 0, Math.PI * 2);
    ctx.moveTo(x - 28, y); ctx.lineTo(x - 10, y);
    ctx.moveTo(x + 10, y); ctx.lineTo(x + 28, y);
    ctx.moveTo(x, y - 28); ctx.lineTo(x, y - 10);
    ctx.moveTo(x, y + 10); ctx.lineTo(x, y + 28);
    ctx.stroke();
    ctx.restore();
  }

  // Composite WebGL + overlay into a PNG.
  toPNG() {
    this.render();
    const c = document.createElement('canvas');
    c.width = this.glCanvas.width;
    c.height = this.glCanvas.height;
    const cx = c.getContext('2d');
    cx.drawImage(this.glCanvas, 0, 0);
    cx.drawImage(this.overlay, 0, 0);
    return c.toDataURL('image/png');
  }

  // --- Interaction
  setMeasureMode(on) {
    this.measureMode = on;
    this.container.classList.toggle('measuring', on);
    if (!on) this.measure = null;
    this.requestRender();
  }

  _local(e) {
    const r = this.overlay.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  _zoomAt(sx, sy, factor) {
    const [wx, wy] = this.screenToWorld(sx, sy);
    this.view.zoom = Math.min(1e7, Math.max(1e-7, this.view.zoom * factor));
    const [nx, ny] = this.screenToWorld(sx, sy);
    this.view.cx += wx - nx;
    this.view.cy += wy - ny;
    this.requestRender();
  }

  _bindEvents() {
    const el = this.overlay;
    const pointers = new Map();
    let drag = null;
    let pinch = null;

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [sx, sy] = this._local(e);
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      this._zoomAt(sx, sy, Math.exp(-delta * 0.0015));
    }, { passive: false });

    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, this._local(e));
      if (pointers.size === 2) {
        const [p, q] = [...pointers.values()];
        pinch = { dist: Math.hypot(p[0] - q[0], p[1] - q[1]), mid: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] };
        drag = null;
      } else {
        drag = { start: this._local(e), last: this._local(e), moved: false, button: e.button };
      }
    });

    el.addEventListener('pointermove', (e) => {
      const pos = this._local(e);
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, pos);
      const world = this.screenToWorld(...pos);
      this.onCursor?.(world);
      if (this.measureMode && this.measure?.a && !this.measure.b) {
        this.measure.hover = world;
        this.requestRender();
      }
      if (pinch && pointers.size === 2) {
        const [p, q] = [...pointers.values()];
        const dist = Math.hypot(p[0] - q[0], p[1] - q[1]);
        const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
        this.view.cx -= (mid[0] - pinch.mid[0]) / this.view.zoom;
        this.view.cy += (mid[1] - pinch.mid[1]) / this.view.zoom;
        this._zoomAt(mid[0], mid[1], dist / pinch.dist);
        pinch = { dist, mid };
        return;
      }
      if (drag) {
        const dx = pos[0] - drag.last[0], dy = pos[1] - drag.last[1];
        if (Math.hypot(pos[0] - drag.start[0], pos[1] - drag.start[1]) > 3) drag.moved = true;
        if (drag.moved) {
          this.view.cx -= dx / this.view.zoom;
          this.view.cy += dy / this.view.zoom;
          el.classList.add('panning');
          this.requestRender();
        }
        drag.last = pos;
      }
    });

    const end = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (drag && !drag.moved && drag.button === 0 && this.measureMode) {
        const world = this.screenToWorld(...this._local(e));
        if (!this.measure || this.measure.b) this.measure = { a: world, b: null, hover: null };
        else {
          this.measure.b = world;
          this.onMeasure?.(this.measure);
        }
        this.requestRender();
      }
      drag = null;
      el.classList.remove('panning');
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('dblclick', () => { if (!this.measureMode) this.zoomExtents(); });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}
