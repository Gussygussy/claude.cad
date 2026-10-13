// Georeferencing helpers: UTM (SIRGAS 2000 / WGS84 ellipsoid) <-> lat/lon <-> Web Mercator,
// plus a local affine fit used to draw web map tiles underneath the drawing.

const A = 6378137;
const F = 1 / 298.257222101;
const K0 = 0.9996;
const E2 = F * (2 - F);
const EP2 = E2 / (1 - E2);
const DEG = Math.PI / 180;

export function utmToLatLon(E, N, zone, south) {
  const x = E - 500000;
  const y = south ? N - 10000000 : N;
  const M = y / K0;
  const mu = M / (A * (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const p = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu)
    + ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu)
    + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu)
    + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const sp = Math.sin(p), cp = Math.cos(p), tp = Math.tan(p);
  const C = EP2 * cp * cp, T = tp * tp;
  const Nn = A / Math.sqrt(1 - E2 * sp * sp);
  const R = (A * (1 - E2)) / (1 - E2 * sp * sp) ** 1.5;
  const D = x / (Nn * K0);
  const lat = p - ((Nn * tp) / R) * ((D * D) / 2
    - ((5 + 3 * T + 10 * C - 4 * C * C - 9 * EP2) * D ** 4) / 24
    + ((61 + 90 * T + 298 * C + 45 * T * T - 252 * EP2 - 3 * C * C) * D ** 6) / 720);
  const lon = (D - ((1 + 2 * T + C) * D ** 3) / 6
    + ((5 - 2 * C + 28 * T - 3 * C * C + 8 * EP2 + 24 * T * T) * D ** 5) / 120) / cp;
  return [lat / DEG, zone * 6 - 183 + lon / DEG];
}

export function latLonToMercator(lat, lon) {
  const x = A * lon * DEG;
  const y = A * Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2));
  return [x, y];
}

// Rough sanity check that drawing coordinates look like UTM eastings/northings.
export function looksLikeUtm(x, y) {
  return x > 100000 && x < 900000 && y > 0 && y < 10000000;
}

// Builds an affine map from drawing-local coordinates (UTM minus `origin`) to Web Mercator
// meters. Over a city-sized drawing the error of this linearisation is far below a pixel.
export function makeGeoref(origin, zone, south) {
  const d = 200;
  const merc = (dx, dy) => {
    const [lat, lon] = utmToLatLon(origin[0] + dx, origin[1] + dy, zone, south);
    return latLonToMercator(lat, lon);
  };
  const o = merc(0, 0), ex = merc(d, 0), ey = merc(0, d);
  const a = (ex[0] - o[0]) / d, b = (ex[1] - o[1]) / d;
  const c = (ey[0] - o[0]) / d, e = (ey[1] - o[1]) / d;
  const det = a * e - b * c;
  return {
    zone, south,
    toMercator: (x, y) => [o[0] + a * x + c * y, o[1] + b * x + e * y],
    fromMercator: (mx, my) => {
      const u = mx - o[0], v = my - o[1];
      return [(e * u - c * v) / det, (-b * u + a * v) / det];
    },
    toLatLon: (x, y) => utmToLatLon(origin[0] + x, origin[1] + y, zone, south),
    // Mercator meters per drawing unit
    scale: Math.sqrt(Math.abs(det)),
  };
}
