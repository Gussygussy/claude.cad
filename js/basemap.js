// Web map tiles (Web Mercator) drawn underneath a UTM drawing using a local affine fit.

const HALF = 20037508.342789244; // half the Web Mercator world width in meters
const TILE = 256;
const MAX_CACHE = 600;

export const PROVIDERS = {
  map: {
    label: 'Map',
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors',
    attributionUrl: 'https://www.openstreetmap.org/copyright',
  },
  satellite: {
    label: 'Satellite',
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    maxZoom: 18, // z19 is missing in much of Brazil ("Map data not yet available")
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    attributionUrl: 'https://www.esri.com/',
  },
};

export class Basemap {
  get isLight() {
    return this.provider === 'map';
  }

  constructor(onTileLoaded) {
    this.provider = null;
    this.cache = new Map();
    this.onTileLoaded = onTileLoaded;
  }

  setProvider(key) {
    this.provider = PROVIDERS[key] ? key : null;
  }

  _tile(z, x, y, request) {
    const key = `${this.provider}/${z}/${x}/${y}`;
    let t = this.cache.get(key);
    if (t) {
      // refresh LRU position
      this.cache.delete(key);
      this.cache.set(key, t);
      return t;
    }
    if (!request) return null;
    const img = new Image();
    img.crossOrigin = 'anonymous'; // keeps the canvas exportable as PNG
    t = { img, loaded: false, failed: false };
    img.onload = () => {
      t.loaded = true;
      this.onTileLoaded?.();
    };
    img.onerror = () => (t.failed = true);
    img.src = PROVIDERS[this.provider].url(z, x, y);
    this.cache.set(key, t);
    if (this.cache.size > MAX_CACHE) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
    return t;
  }

  // view: { cx, cy, zoom, width, height, dpr }, georef from geo.js
  draw(ctx, view, georef) {
    const { width: W, height: H, dpr } = view;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (!this.provider || !georef) return;
    const P = PROVIDERS[this.provider];

    const toScreen = (mx, my) => {
      const [x, y] = georef.fromMercator(mx, my);
      return [(x - view.cx) * view.zoom + W / 2, H / 2 - (y - view.cy) * view.zoom];
    };
    const toMerc = (sx, sy) =>
      georef.toMercator(view.cx + (sx - W / 2) / view.zoom, view.cy - (sy - H / 2) / view.zoom);

    // Pick the tile zoom whose pixels best match screen pixels.
    const pxPerMeter = (view.zoom * dpr) / georef.scale;
    const z = Math.max(0, Math.min(P.maxZoom, Math.round(Math.log2((2 * HALF * pxPerMeter) / TILE))));
    const n = 2 ** z;
    const size = (2 * HALF) / n;

    const corners = [toMerc(0, 0), toMerc(W, 0), toMerc(0, H), toMerc(W, H)];
    const mxs = corners.map((c) => c[0]), mys = corners.map((c) => c[1]);
    const clamp = (v) => Math.max(0, Math.min(n - 1, v));
    const x0 = clamp(Math.floor((Math.min(...mxs) + HALF) / size));
    const x1 = clamp(Math.floor((Math.max(...mxs) + HALF) / size));
    const y0 = clamp(Math.floor((HALF - Math.max(...mys)) / size));
    const y1 = clamp(Math.floor((HALF - Math.min(...mys)) / size));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) return; // zoomed far out; skip

    ctx.imageSmoothingEnabled = true;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const t = this._tile(z, tx, ty, true);
        if (t.loaded) {
          this._drawTile(ctx, t.img, z, tx, ty, 0, 0, TILE, toScreen, dpr);
          continue;
        }
        // While loading, stretch a cached ancestor tile over the gap.
        for (let up = 1; up <= 6 && z - up >= 0; up++) {
          const k = 2 ** up;
          const a = this._tile(z - up, Math.floor(tx / k), Math.floor(ty / k), false);
          if (a?.loaded) {
            const sub = TILE / k;
            this._drawTile(ctx, a.img, z, tx, ty, (tx % k) * sub, (ty % k) * sub, sub, toScreen, dpr);
            break;
          }
        }
      }
    }
  }

  _drawTile(ctx, img, z, tx, ty, sx, sy, sSize, toScreen, dpr) {
    const size = (2 * HALF) / 2 ** z;
    const left = -HALF + tx * size, top = HALF - ty * size;
    const tl = toScreen(left, top), tr = toScreen(left + size, top), bl = toScreen(left, top - size);
    ctx.setTransform(
      (dpr * (tr[0] - tl[0])) / TILE, (dpr * (tr[1] - tl[1])) / TILE,
      (dpr * (bl[0] - tl[0])) / TILE, (dpr * (bl[1] - tl[1])) / TILE,
      dpr * tl[0], dpr * tl[1],
    );
    // A hair of overlap hides seams between neighbouring tiles.
    ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, TILE + 0.6, TILE + 0.6);
  }
}
