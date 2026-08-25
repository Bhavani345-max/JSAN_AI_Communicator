// Blocks -> slide plan.
//
// This is the only place a model is involved, because deciding how a document
// should be broken into slides, and what each slide is called, is judgement
// rather than mechanics. Everything factual stays out of its hands: tables and
// figures are referenced by index and copied verbatim later, so the model never
// retypes a number it could get wrong. If it is unavailable or answers badly,
// `fallbackPlan` builds a usable deck from the document's own heading structure.

const MAX_SLIDES = 24;
const MAX_BULLETS = 6;
const MAX_BULLET_CHARS = 180;
const MAX_TITLE_CHARS = 90;
const MAX_OUTLINE_CHARS = 24_000;

const clean = (value, limit) => String(value ?? '')
  .replace(/[*_`#]+/g, '')          // models drift into markdown; slides want plain text
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, limit);

/** A compact rendering of the document for the model, with referencable markers. */
export function buildOutline({ blocks, tables, images }) {
  const lines = [];
  for (const block of blocks) {
    if (block.type === 'heading') lines.push(`${'#'.repeat(Math.min(3, block.level))} ${block.text}`);
    else if (block.type === 'bullets') for (const item of block.items) lines.push(`- ${item}`);
    else if (block.type === 'paragraph') lines.push(`p: ${block.text.slice(0, 600)}`);
    else if (block.type === 'table') {
      const table = tables[block.index];
      if (table) {
        lines.push(`[TABLE ${block.index} — ${table.rows[0].length} columns x ${table.rows.length} rows; header: ${table.rows[0].join(' | ')}]`);
      }
    } else if (block.type === 'image') {
      const image = images[block.index];
      if (image) lines.push(`[FIGURE ${block.index} — ${image.width}x${image.height}px on page ${image.page}]`);
    }
  }
  const text = lines.join('\n');
  return text.length > MAX_OUTLINE_CHARS
    ? text.slice(0, MAX_OUTLINE_CHARS) + '\n[outline truncated]'
    : text;
}

const SYSTEM_PROMPT = `You turn an extracted document outline into a presentation plan.
Reply with JSON only — no prose, no code fences.

Schema:
{"title":"string","subtitle":"string","slides":[{"title":"string","bullets":["string"],"notes":"string","tableRef":0,"imageRef":0}]}

Rules:
- Between 5 and 16 slides, ordered as the document is.
- Every slide needs a specific title. Never use placeholders like "Slide 3".
- 2 to 6 bullets per slide, each one short, plain text, under 140 characters.
- Use only facts present in the outline. Never invent figures, names or findings.
- Never retype table contents. To show TABLE n, set "tableRef": n and keep the bullets to what the table means.
- To place FIGURE n, set "imageRef": n. Omit both keys when not needed.
- Reference each table and figure at most once.
- "notes" is one or two sentences a presenter would say. Omit if you have nothing useful.`;

function parseJsonObject(raw) {
  const text = String(raw || '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '');
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

/** Keep only what is structurally sound, so a sloppy answer degrades instead of breaking the build. */
export function validatePlan(raw, { tables, images }) {
  if (!raw || !Array.isArray(raw.slides)) return null;
  const usedTables = new Set();
  const usedImages = new Set();
  const slides = [];

  for (const candidate of raw.slides) {
    if (slides.length >= MAX_SLIDES) break;
    const title = clean(candidate?.title, MAX_TITLE_CHARS);
    const bullets = (Array.isArray(candidate?.bullets) ? candidate.bullets : [])
      .map(b => clean(b, MAX_BULLET_CHARS))
      .filter(Boolean)
      .slice(0, MAX_BULLETS);

    const tableRef = Number.isInteger(candidate?.tableRef) && tables[candidate.tableRef] && !usedTables.has(candidate.tableRef)
      ? candidate.tableRef : null;
    const imageRef = Number.isInteger(candidate?.imageRef) && images[candidate.imageRef] && !usedImages.has(candidate.imageRef)
      ? candidate.imageRef : null;

    if (!title || (!bullets.length && tableRef === null && imageRef === null)) continue;
    if (tableRef !== null) usedTables.add(tableRef);
    if (imageRef !== null) usedImages.add(imageRef);

    slides.push({ title, bullets, notes: clean(candidate?.notes, 400), tableRef, imageRef });
  }

  if (!slides.length) return null;
  return {
    title: clean(raw.title, 120) || 'Presentation',
    subtitle: clean(raw.subtitle, 160),
    slides
  };
}

const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-Z(])/;

/**
 * Build a deck straight from the document's own structure.
 *
 * Used when the model is switched off, unreachable, or returns something that
 * fails validation — the feature still produces a real deck either way.
 */
export function fallbackPlan({ blocks, tables, images }, filename = '') {
  const headings = blocks.filter(b => b.type === 'heading');
  const firstHeading = headings.find(h => h.level <= 2);
  const firstParagraph = blocks.find(b => b.type === 'paragraph');

  const slides = [];
  const usedTables = new Set();
  const usedImages = new Set();
  let current = null;

  const open = (title) => {
    if (slides.length >= MAX_SLIDES) { current = null; return; }
    current = { title: clean(title, MAX_TITLE_CHARS) || 'Overview', bullets: [], notes: '', tableRef: null, imageRef: null };
    slides.push(current);
  };

  for (const block of blocks) {
    if (block.type === 'heading') {
      // A level-3 heading inside a section is a bullet, not a new slide.
      if (block.level <= 2 || !current) open(block.text);
      else if (current.bullets.length < MAX_BULLETS) current.bullets.push(clean(block.text, MAX_BULLET_CHARS));
      continue;
    }
    if (!current) open(firstHeading?.text || 'Overview');
    if (!current) break;

    if (block.type === 'bullets') {
      for (const item of block.items) {
        if (current.bullets.length >= MAX_BULLETS) break;
        current.bullets.push(clean(item, MAX_BULLET_CHARS));
      }
    } else if (block.type === 'paragraph') {
      for (const sentence of block.text.split(SENTENCE_SPLIT)) {
        if (current.bullets.length >= MAX_BULLETS) break;
        const text = clean(sentence, MAX_BULLET_CHARS);
        if (text.length > 12) current.bullets.push(text);
      }
    } else if (block.type === 'table' && !usedTables.has(block.index)) {
      if (current.tableRef !== null) open(`${current.title} (table)`);
      if (current) { current.tableRef = block.index; usedTables.add(block.index); }
    } else if (block.type === 'image' && !usedImages.has(block.index)) {
      if (current.imageRef !== null) open(`${current.title} (figure)`);
      if (current) { current.imageRef = block.index; usedImages.add(block.index); }
    }
  }

  const usable = slides.filter(s => s.bullets.length || s.tableRef !== null || s.imageRef !== null);
  const title = clean(firstHeading?.text, 120)
    || clean(firstParagraph?.text?.split(SENTENCE_SPLIT)[0], 120)
    || clean(filename.replace(/\.pdf$/i, ''), 120)
    || 'Presentation';

  return {
    title,
    subtitle: clean(headings[1]?.text, 160),
    slides: usable.length ? usable : [{ title, bullets: ['This document had no extractable structure.'], notes: '', tableRef: null, imageRef: null }]
  };
}

/**
 * Plan a deck, preferring the model and falling back to document structure.
 * Never throws: a failed plan is reported as a warning, not an error.
 */
export async function planDeck({ extract, filename, useAi, callModel, key, model }) {
  const warnings = [];
  if (!useAi) {
    return { plan: fallbackPlan(extract, filename), source: 'structure', warnings };
  }

  try {
    const outline = buildOutline(extract);
    const answer = await callModel({
      key,
      model,
      timeout: 90_000,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Document: ${filename || 'untitled.pdf'}\nPages: ${extract.pagesRead}\n\nOutline:\n${outline}` }
      ]
    });
    const plan = validatePlan(parseJsonObject(answer), extract);
    if (plan) return { plan, source: 'ai', warnings };
    warnings.push('The AI response could not be used, so the deck follows the document structure instead.');
  } catch (error) {
    warnings.push(`The AI step was skipped (${error.message.slice(0, 120)}). The deck follows the document structure instead.`);
  }

  return { plan: fallbackPlan(extract, filename), source: 'structure', warnings };
}
