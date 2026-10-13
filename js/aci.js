// AutoCAD Color Index (ACI) palette, generated from the standard hue/value layout.
// Index 0 (ByBlock) and 256 (ByLayer) are resolved elsewhere.

function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

export const ACI = (() => {
  const table = new Array(256);
  table[0] = [255, 255, 255];
  const base = [
    [255, 0, 0], [255, 255, 0], [0, 255, 0], [0, 255, 255],
    [0, 0, 255], [255, 0, 255], [255, 255, 255], [65, 65, 65], [128, 128, 128],
  ];
  base.forEach((c, i) => (table[i + 1] = c));
  const values = [1, 0.65, 0.5, 0.3, 0.15];
  for (let i = 10; i < 250; i++) {
    const hue = Math.floor((i - 10) / 10) * 15;
    const k = (i - 10) % 10;
    const v = values[Math.floor(k / 2)];
    const s = k % 2 === 0 ? 1 : 0.5;
    table[i] = hsvToRgb(hue, s, v);
  }
  const grays = [51, 80, 105, 130, 190, 255];
  grays.forEach((g, i) => (table[250 + i] = [g, g, g]));
  return table;
})();

export function rgbIntToArray(rgb) {
  return [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff];
}

export function rgbToCss([r, g, b]) {
  return `rgb(${r},${g},${b})`;
}
