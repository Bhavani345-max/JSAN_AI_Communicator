// PDF -> structured blocks.
//
// A flat text dump cannot tell a heading from a paragraph, so this works from
// pdf.js's positioned text items instead: every item carries an x/y and a glyph
// height, which is what makes headings, bullet lists and column-aligned tables
// recoverable. The output is deliberately plain data — the deck planner and the
// PPTX builder both consume it, and a future .docx builder could too.

import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import path from 'path';
import { toRgba, rgbaToPng } from './png.js';

const require = createRequire(import.meta.url);

// pdf.js must be loaded from its `legacy` build to run under Node, and its font
// and cmap lookups need real directory URLs with trailing slashes — a plain
// Windows path throws. Resolving through the package's own location keeps this
// correct both locally and inside the container.
let pdfjsPromise;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const pkgJson = require.resolve('pdfjs-dist/package.json');
      const pkgUrl = pathToFileURL(path.dirname(pkgJson) + path.sep).href;
      const lib = await import(new URL('legacy/build/pdf.mjs', pkgUrl).href);
      return {
        lib,
        standardFontDataUrl: new URL('standard_fonts/', pkgUrl).href,
        cMapUrl: new URL('cmaps/', pkgUrl).href
      };
    })();
  }
  return pdfjsPromise;
}

const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 4_000_000;
const MIN_IMAGE_WIDTH = 60;
const MIN_IMAGE_HEIGHT = 40;
const IMAGE_TARGET_WIDTH = 1400;

const BULLET_PATTERN = /^\s*(?:[•▪●◦‣·⁃∙]|[-–—*]\s|\(?\d{1,2}[.)]\s|\(?[a-z][.)]\s)/i;
const PAGE_FURNITURE = /^(?:page\s+)?\d{1,3}(?:\s*\/\s*\d{1,3})?$/i;

/** Group text items into visual lines, then into cells within each line. */
function toLines(items) {
  const rows = [];
  for (const item of items) {
    if (typeof item.str !== 'string' || !item.str.trim()) continue;
    const x = item.transform[4];
    const y = item.transform[5];
    const size = Math.abs(item.height || item.transform[3] || 0) || 10;
    // Same baseline within a fraction of the glyph height is the same line.
    let row = rows.find(r => Math.abs(r.y - y) <= Math.max(1.5, size * 0.35));
    if (!row) { row = { y, size: 0, parts: [] }; rows.push(row); }
    row.parts.push({ x, right: x + (item.width || 0), text: item.str, size });
    row.size = Math.max(row.size, size);
  }

  return rows
    .map(row => {
      const parts = row.parts.sort((a, b) => a.x - b.x);
      const cells = [];
      let cur = null;
      for (const part of parts) {
        const gap = cur ? part.x - cur.right : 0;
        // A wide gap is a column boundary; a small one is just word spacing that
        // the PDF expressed as separate positioning rather than a space glyph.
        if (!cur || gap > Math.max(6, row.size * 0.9)) {
          cur = { x: part.x, right: part.right, text: part.text.trim() };
          cells.push(cur);
        } else {
          const needsSpace = gap > row.size * 0.18 && !cur.text.endsWith(' ') && !part.text.startsWith(' ');
          cur.text += (needsSpace ? ' ' : '') + part.text;
          cur.right = part.right;
        }
      }
      for (const cell of cells) cell.text = cell.text.replace(/\s+/g, ' ').trim();
      const kept = cells.filter(c => c.text);
      return {
        y: row.y,
        size: row.size,
        x: kept[0]?.x ?? 0,
        cells: kept,
        text: kept.map(c => c.text).join('  ').trim()
      };
    })
    .filter(line => line.text && !PAGE_FURNITURE.test(line.text))
    .sort((a, b) => b.y - a.y);   // PDF y grows upward, so descending is top-down
}

/** The dominant text size, weighted by how much text is set in it. */
function bodySize(lines) {
  const weight = new Map();
  for (const line of lines) {
    const key = Math.round(line.size * 2) / 2;
    weight.set(key, (weight.get(key) || 0) + line.text.length);
  }
  let best = 10, bestWeight = -1;
  for (const [size, w] of weight) if (w > bestWeight) { best = size; bestWeight = w; }
  return best || 10;
}

/**
 * Runs of consecutive lines that share column positions are tables.
 *
 * Prose lines collapse into a single cell, so requiring three aligned cells on
 * two or more adjacent lines separates a real table from a wrapped sentence.
 */
function findTableRuns(lines, body) {
  const runs = [];
  let run = [];
  const flush = () => {
    if (run.length >= 2) {
      const columnSets = run.map(l => l.cells.map(c => c.x));
      const first = columnSets[0];
      const aligned = columnSets.every(set =>
        set.filter(x => first.some(fx => Math.abs(fx - x) <= 8)).length >= 2
      );
      if (aligned) runs.push(run.slice());
    }
    run = [];
  };

  for (const line of lines) {
    const isRow = line.cells.length >= 3;
    const adjacent = !run.length || Math.abs(run[run.length - 1].y - line.y) <= body * 3;
    if (isRow && adjacent) run.push(line);
    else { flush(); if (isRow) run = [line]; }
  }
  flush();
  return runs;
}

/** Snap the cells of each row onto a shared set of columns. */
function runToRows(run) {
  const buckets = [];
  for (const line of run) {
    for (const cell of line.cells) {
      const hit = buckets.find(b => Math.abs(b - cell.x) <= 8);
      if (hit === undefined) buckets.push(cell.x);
    }
  }
  buckets.sort((a, b) => a - b);
  return run.map(line => {
    const cells = new Array(buckets.length).fill('');
    for (const cell of line.cells) {
      let nearest = 0;
      for (let i = 1; i < buckets.length; i++) {
        if (Math.abs(buckets[i] - cell.x) < Math.abs(buckets[nearest] - cell.x)) nearest = i;
      }
      cells[nearest] = cells[nearest] ? `${cells[nearest]} ${cell.text}` : cell.text;
    }
    return cells;
  });
}

function headingLevel(size, body) {
  if (size >= body * 1.55) return 1;
  if (size >= body * 1.25) return 2;
  if (size >= body * 1.1) return 3;
  return 0;
}

/** Nearest-neighbour downscale, to keep a high-resolution scan from bloating the deck. */
function downscale(width, height, rgba, targetWidth) {
  const scale = targetWidth / width;
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.floor(x / scale));
      rgba.copy(out, (y * w + x) * 4, (sy * width + sx) * 4, (sy * width + sx) * 4 + 4);
    }
  }
  return { width: w, height: h, rgba: out };
}

/** pdf.js resolves image XObjects through a callback store; guard against a name that never resolves. */
function getImageObject(page, name) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => finish(null), 5000);
    for (const store of [page.objs, page.commonObjs]) {
      try { store?.get(name, finish); } catch { /* try the other store */ }
    }
  });
}

async function extractImages(page, pageNumber, OPS, state, warnings) {
  const found = [];
  let ops;
  try { ops = await page.getOperatorList(); } catch { return found; }

  const names = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject) {
      const name = ops.argsArray[i]?.[0];
      if (typeof name === 'string' && !names.includes(name)) names.push(name);
    }
  }

  for (const name of names) {
    if (state.count >= MAX_IMAGES || state.bytes >= MAX_IMAGE_BYTES) break;
    try {
      const bitmap = await getImageObject(page, name);
      if (!bitmap?.width || !bitmap?.height) continue;
      if (bitmap.width < MIN_IMAGE_WIDTH || bitmap.height < MIN_IMAGE_HEIGHT) continue;
      if (bitmap.width * bitmap.height > MAX_IMAGE_PIXELS) continue;

      let rgba = toRgba(bitmap);
      if (!rgba) { warnings.push(`An image on page ${pageNumber} used a colour format that could not be read.`); continue; }

      let { width, height } = bitmap;
      if (width > IMAGE_TARGET_WIDTH) ({ width, height, rgba } = downscale(width, height, rgba, IMAGE_TARGET_WIDTH));

      const png = rgbaToPng(width, height, rgba);
      state.count += 1;
      state.bytes += png.length;
      found.push({
        page: pageNumber,
        width,
        height,
        bytes: png.length,
        dataUri: `image/png;base64,${png.toString('base64')}`
      });
    } catch {
      warnings.push(`An image on page ${pageNumber} could not be decoded and was skipped.`);
    }
  }
  return found;
}

/**
 * Read a PDF into ordered blocks plus the tables and images they reference.
 *
 * Tables and images are kept verbatim and referenced by index, so nothing
 * downstream — including the model — has to retype their contents.
 */
export async function extractPdf(buffer, { maxPages = 60 } = {}) {
  const { lib, standardFontDataUrl, cMapUrl } = await loadPdfjs();
  // Releasing worker resources is `loadingTask.destroy()`, not a method on the
  // document proxy — and it has to run even when a malformed PDF throws midway.
  const loadingTask = lib.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    useSystemFonts: true,
    standardFontDataUrl,
    cMapUrl,
    cMapPacked: true
  });
  try {
    return await readDocument(await loadingTask.promise, lib, maxPages);
  } finally {
    await loadingTask.destroy().catch(() => {});
  }
}

async function readDocument(doc, lib, maxPages) {

  const warnings = [];
  const blocks = [];
  const tables = [];
  const images = [];
  const imageState = { count: 0, bytes: 0 };
  const pagesRead = Math.min(doc.numPages, maxPages);
  if (doc.numPages > pagesRead) {
    warnings.push(`Only the first ${pagesRead} of ${doc.numPages} pages were read.`);
  }

  const allLines = [];
  const perPage = [];
  for (let pageNumber = 1; pageNumber <= pagesRead; pageNumber++) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const lines = toLines(content.items);
    perPage.push({ pageNumber, page, lines });
    allLines.push(...lines);
  }

  const body = bodySize(allLines);

  for (const { pageNumber, page, lines } of perPage) {
    const runs = findTableRuns(lines, body);
    const consumed = new Set();
    const tableAt = new Map();
    for (const run of runs) {
      const rows = runToRows(run);
      // Two columns of stray alignment is not worth presenting as a table.
      if (rows.length < 2 || rows[0].length < 2) continue;
      const index = tables.length;
      tables.push({ index, page: pageNumber, rows });
      tableAt.set(run[0], index);
      for (const line of run) consumed.add(line);
    }

    let current = null;   // open paragraph or bullet block
    for (const line of lines) {
      if (tableAt.has(line)) {
        blocks.push({ type: 'table', index: tableAt.get(line), page: pageNumber });
        current = null;
        continue;
      }
      if (consumed.has(line)) continue;

      const level = headingLevel(line.size, body);
      const isHeading = level > 0 && line.text.length <= 120;

      if (isHeading) {
        blocks.push({ type: 'heading', level, text: line.text, page: pageNumber });
        current = null;
        continue;
      }

      if (BULLET_PATTERN.test(line.text)) {
        const text = line.text.replace(BULLET_PATTERN, '').trim();
        if (!text) continue;
        if (current?.type === 'bullets') current.items.push(text);
        else { current = { type: 'bullets', items: [text], page: pageNumber, x: line.x }; blocks.push(current); }
        continue;
      }

      // An indented line under a bullet list is that bullet's continuation.
      if (current?.type === 'bullets' && line.x > current.x + 4) {
        current.items[current.items.length - 1] += ' ' + line.text;
        continue;
      }

      if (current?.type === 'paragraph') current.text += ' ' + line.text;
      else { current = { type: 'paragraph', text: line.text, page: pageNumber }; blocks.push(current); }
    }

    for (const image of await extractImages(page, pageNumber, lib.OPS, imageState, warnings)) {
      image.index = images.length;
      images.push(image);
      blocks.push({ type: 'image', index: image.index, page: pageNumber });
    }
  }

  const textChars = blocks.reduce((n, b) =>
    n + (b.text?.length || 0) + (b.items?.join(' ').length || 0), 0);

  if (!textChars) {
    warnings.push('No selectable text was found. This looks like a scanned PDF, which needs OCR before it can be converted.');
  }

  return {
    pageCount: doc.numPages,
    pagesRead,
    blocks,
    tables,
    images,
    warnings,
    textChars,
    headings: blocks.filter(b => b.type === 'heading').length
  };
}
