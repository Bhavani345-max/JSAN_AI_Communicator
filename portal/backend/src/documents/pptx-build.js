// Slide plan -> a real .pptx file.
//
// Everything here is emitted as native PowerPoint content: text frames, table
// grids and picture parts. Nothing is flattened to an image of a slide, so every
// title, bullet and table cell stays selectable and editable in PowerPoint.

import PptxGenJS from 'pptxgenjs';
import { resolveTheme } from './themes.js';

// LAYOUT_16x9 is 10 x 5.625 inches.
const W = 10;
const H = 5.625;
const MARGIN = 0.55;
const CONTENT_W = W - MARGIN * 2;
const CONTENT_TOP = 1.28;
const CONTENT_BOTTOM = 5.15;
const MAX_TABLE_ROWS = 12;

/** Bullet text has to fit without a scrollbar to hide behind, so scale it down as it grows. */
function bulletFontSize(bullets) {
  const chars = bullets.join(' ').length;
  if (chars > 620) return 12;
  if (chars > 430) return 13.5;
  if (chars > 260) return 15;
  return 16;
}

function addTitle(slide, theme, text) {
  slide.addText(text, {
    x: MARGIN, y: 0.42, w: CONTENT_W, h: 0.62,
    fontSize: 24, bold: true, color: theme.title, fontFace: 'Segoe UI', valign: 'middle'
  });
  // A short accent rule reads as deliberate structure rather than decoration.
  slide.addShape('rect', { x: MARGIN, y: 1.09, w: 1.1, h: 0.055, fill: { color: theme.rule }, line: { width: 0 } });
}

function addBullets(slide, theme, bullets, { x, y, w, h }) {
  if (!bullets.length) return;
  slide.addText(
    bullets.map(text => ({ text, options: { bullet: true, breakLine: true } })),
    {
      x, y, w, h,
      fontSize: bulletFontSize(bullets),
      color: theme.body,
      fontFace: 'Segoe UI',
      valign: 'top',
      lineSpacingMultiple: 1.18,
      paraSpaceAfter: 7
    }
  );
}

function addTable(slide, theme, table, { x, y, w, h }, warnings) {
  let rows = table.rows;
  if (rows.length > MAX_TABLE_ROWS) {
    warnings.push(`A table from page ${table.page} had ${rows.length} rows; the slide shows the first ${MAX_TABLE_ROWS - 1}.`);
    rows = rows.slice(0, MAX_TABLE_ROWS - 1);
  }
  const columns = Math.max(1, rows[0].length);
  const colW = new Array(columns).fill(w / columns);
  const fontSize = columns >= 6 ? 9 : columns >= 4 ? 10.5 : 12;

  const body = rows.map((row, index) => row.map(cell => ({
    text: String(cell ?? '').slice(0, 120),
    options: index === 0
      ? { bold: true, color: theme.tableHeadText, fill: { color: theme.tableHeadBg } }
      : { color: theme.body, fill: { color: index % 2 ? theme.slideBg : theme.tableRowBg } }
  })));

  slide.addTable(body, {
    x, y, w, colW,
    fontSize,
    fontFace: 'Segoe UI',
    border: { type: 'solid', pt: 0.5, color: theme.muted },
    valign: 'middle',
    autoPage: false,
    rowH: Math.min(0.42, Math.max(0.26, h / Math.max(rows.length, 1)))
  });
}

function addImage(slide, image, box) {
  // Fit inside the box at the image's own aspect ratio; 96dpi is a sane baseline
  // for a PDF-embedded raster and keeps small logos from being blown up.
  const naturalW = image.width / 96;
  const naturalH = image.height / 96;
  const scale = Math.min(box.w / naturalW, box.h / naturalH, 1.75);
  const w = naturalW * scale;
  const h = naturalH * scale;
  slide.addImage({
    data: image.dataUri,
    x: box.x + (box.w - w) / 2,
    y: box.y + (box.h - h) / 2,
    w, h
  });
}

/**
 * Build the deck.
 * @returns {Promise<{buffer:Buffer, slideCount:number, warnings:string[]}>}
 */
export async function buildPptx({ plan, tables, images, themeId, sourceName }) {
  const theme = resolveTheme(themeId);
  const warnings = [];
  const pptx = new PptxGenJS();

  pptx.layout = 'LAYOUT_16x9';
  pptx.title = plan.title;
  pptx.subject = sourceName ? `Converted from ${sourceName}` : 'Converted from PDF';
  pptx.author = 'JSAN Dev AI';
  pptx.company = 'JSAN Consulting';

  // ---- cover ----
  const cover = pptx.addSlide();
  cover.background = { color: theme.coverBg };
  cover.addText(plan.title, {
    x: MARGIN, y: 1.75, w: CONTENT_W, h: 1.5,
    fontSize: 40, bold: true, color: theme.coverTitle, fontFace: 'Segoe UI', valign: 'bottom'
  });
  cover.addShape('rect', { x: MARGIN, y: 3.35, w: 1.6, h: 0.06, fill: { color: theme.rule }, line: { width: 0 } });
  if (plan.subtitle) {
    cover.addText(plan.subtitle, {
      x: MARGIN, y: 3.55, w: CONTENT_W, h: 0.8,
      fontSize: 16, color: theme.coverSubtitle, fontFace: 'Segoe UI', valign: 'top'
    });
  }
  if (sourceName) {
    cover.addText(`Converted from ${sourceName}`, {
      x: MARGIN, y: H - 0.75, w: CONTENT_W, h: 0.3,
      fontSize: 10, color: theme.coverSubtitle, fontFace: 'Segoe UI'
    });
  }

  // ---- content ----
  for (const spec of plan.slides) {
    const slide = pptx.addSlide();
    slide.background = { color: theme.slideBg };
    addTitle(slide, theme, spec.title);

    const table = spec.tableRef !== null && spec.tableRef !== undefined ? tables[spec.tableRef] : null;
    const image = spec.imageRef !== null && spec.imageRef !== undefined ? images[spec.imageRef] : null;
    const availableH = CONTENT_BOTTOM - CONTENT_TOP;

    if (table) {
      // Bullets explain the table; the table itself gets the room.
      const lead = spec.bullets.slice(0, 3);
      const leadH = lead.length ? Math.min(1.35, 0.34 * lead.length + 0.2) : 0;
      addBullets(slide, theme, lead, { x: MARGIN, y: CONTENT_TOP, w: CONTENT_W, h: leadH });
      addTable(slide, theme, table, {
        x: MARGIN,
        y: CONTENT_TOP + leadH + (leadH ? 0.16 : 0),
        w: CONTENT_W,
        h: availableH - leadH - 0.16
      }, warnings);
    } else if (image) {
      const hasBullets = spec.bullets.length > 0;
      if (hasBullets) {
        addBullets(slide, theme, spec.bullets, { x: MARGIN, y: CONTENT_TOP, w: CONTENT_W * 0.54, h: availableH });
        addImage(slide, image, { x: MARGIN + CONTENT_W * 0.58, y: CONTENT_TOP, w: CONTENT_W * 0.42, h: availableH });
      } else {
        addImage(slide, image, { x: MARGIN, y: CONTENT_TOP, w: CONTENT_W, h: availableH });
      }
    } else {
      addBullets(slide, theme, spec.bullets, { x: MARGIN, y: CONTENT_TOP, w: CONTENT_W, h: availableH });
    }

    if (spec.notes) slide.addNotes(spec.notes);
  }

  const written = await pptx.write({ outputType: 'nodebuffer' });
  return {
    buffer: Buffer.isBuffer(written) ? written : Buffer.from(written),
    slideCount: plan.slides.length + 1,
    warnings
  };
}
