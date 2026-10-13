// Parses DWG files off the main thread using LibreDWG compiled to WebAssembly.
import {
  LibreDwg,
  Dwg_File_Type,
} from 'https://cdn.jsdelivr.net/npm/@mlightcad/libredwg-web@0.8.0/dist/libredwg-web.js';

const WASM_DIR = 'https://cdn.jsdelivr.net/npm/@mlightcad/libredwg-web@0.8.0/wasm';

let libPromise = null;
function getLib() {
  if (!libPromise) libPromise = LibreDwg.create(WASM_DIR);
  return libPromise;
}

self.onmessage = async (event) => {
  const { id, buffer } = event.data;
  try {
    self.postMessage({ id, status: 'Loading DWG engine…' });
    const lib = await getLib();
    self.postMessage({ id, status: 'Parsing drawing…' });
    const dwg = lib.dwg_read_data(buffer, Dwg_File_Type.DWG);
    if (!dwg) throw new Error('The file could not be read. It may be corrupt or an unsupported version.');
    self.postMessage({ id, status: 'Converting entities…' });
    const db = lib.convert(dwg);
    lib.dwg_free(dwg);
    // The thumbnail is a pointer-backed buffer we don't need; drop it before cloning.
    delete db.thumbnailImage;
    self.postMessage({ id, db });
  } catch (err) {
    self.postMessage({ id, error: err?.message || String(err) });
  }
};

// Start downloading the engine as soon as the worker is created.
getLib().catch(() => { libPromise = null; });
