// Document generation endpoints.
//
// Mounted by server.js under /api/documents. Auth, rate limiting and the model
// call are injected rather than imported, so this module stays independent of
// the server's wiring and a second generator (.docx, .xlsx) can be added beside
// it without touching either file's internals.
//
// The conversion streams newline-delimited JSON. A PDF parse plus a model call
// is too slow to leave a user watching an unlabelled spinner, and the stages are
// genuinely known server-side, so they are reported as they happen rather than
// guessed at with a timer in the browser.

import express from 'express';
import { extractPdf } from './pdf-extract.js';
import { planDeck } from './deck-plan.js';
import { buildPptx } from './pptx-build.js';
import { listThemes, DEFAULT_THEME, THEMES } from './themes.js';

export const MAX_PDF_BYTES = 8 * 1024 * 1024;
const MAX_PAGES = 60;
const EXTRACT_TIMEOUT_MS = 90_000;

const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms))
]);

/** Keep only a safe leaf name — this value comes back as a download filename. */
function safeName(raw) {
  const base = String(raw || 'document.pdf').split(/[\\/]/).pop() || 'document.pdf';
  return base.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120) || 'document.pdf';
}

export function createDocumentRoutes({ auth, limiter, callModel, modelKeyFor, planningModel = 'auto' }) {
  const router = express.Router();

  router.get('/templates', auth, (_req, res) => {
    res.json({
      templates: listThemes(),
      defaultTemplate: DEFAULT_THEME,
      maxPdfBytes: MAX_PDF_BYTES,
      maxPages: MAX_PAGES
    });
  });

  router.post('/pdf-to-pptx', auth, limiter, async (req, res) => {
    // Validate before a single byte is streamed: once the NDJSON body starts the
    // status code is fixed at 200, and a bad request deserves a real one.
    const filename = safeName(req.body?.filename);
    const themeId = THEMES[req.body?.theme] ? req.body.theme : DEFAULT_THEME;
    const wantsAi = req.body?.useAi !== false;

    const base64 = String(req.body?.pdfBase64 || '');
    if (!base64) return res.status(400).json({ error: 'Choose a PDF to convert.' });

    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) return res.status(400).json({ error: 'That upload could not be read. Try choosing the file again.' });
    if (buffer.length > MAX_PDF_BYTES) {
      return res.status(413).json({
        error: `That PDF is ${(buffer.length / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_PDF_BYTES / 1024 / 1024} MB.`
      });
    }
    if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      return res.status(400).json({ error: 'That file is not a PDF. Choose a file that ends in .pdf.' });
    }

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');   // ask any proxy in front not to buffer
    res.flushHeaders?.();
    const emit = (event) => { if (!res.writableEnded) res.write(JSON.stringify(event) + '\n'); };

    try {
      emit({ stage: 'extracting', message: 'Reading the PDF' });
      const extract = await withTimeout(extractPdf(buffer, { maxPages: MAX_PAGES }), EXTRACT_TIMEOUT_MS, 'Reading the PDF');

      if (!extract.textChars) {
        emit({
          stage: 'failed',
          error: 'No selectable text was found in this PDF. It looks like a scan or an image-only export, which needs OCR before it can become slides.'
        });
        return res.end();
      }

      emit({
        stage: 'extracted',
        message: `Read ${extract.pagesRead} page${extract.pagesRead === 1 ? '' : 's'}`,
        pages: extract.pagesRead,
        headings: extract.headings,
        tables: extract.tables.length,
        images: extract.images.length
      });

      // The per-developer key never leaves the server; only the plan comes back.
      let key = null;
      const planWarnings = [];
      if (wantsAi) {
        try { key = modelKeyFor(req.user); }
        catch { planWarnings.push('Your AI key could not be read, so the deck follows the document structure instead.'); }
      }
      const useAi = wantsAi && !!key;

      emit({
        stage: 'planning',
        message: useAi ? 'Organising the slides with AI' : 'Organising slides from the document structure'
      });
      const planned = await planDeck({ extract, filename, useAi, callModel, key, model: planningModel });

      emit({ stage: 'building', message: 'Building the PowerPoint file', slides: planned.plan.slides.length + 1 });
      const built = await buildPptx({
        plan: planned.plan,
        tables: extract.tables,
        images: extract.images,
        themeId,
        sourceName: filename
      });

      emit({
        stage: 'done',
        message: 'Ready to download',
        file: {
          filename: filename.replace(/\.pdf$/i, '') + '.pptx',
          base64: built.buffer.toString('base64'),
          bytes: built.buffer.length,
          contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        },
        deck: {
          title: planned.plan.title,
          subtitle: planned.plan.subtitle,
          slideCount: built.slideCount,
          slideTitles: planned.plan.slides.map(s => s.title),
          organisedBy: planned.source,
          template: themeId
        },
        source: {
          pages: extract.pagesRead,
          pageCount: extract.pageCount,
          headings: extract.headings,
          tablesCarried: planned.plan.slides.filter(s => s.tableRef !== null && s.tableRef !== undefined).length,
          tablesFound: extract.tables.length,
          imagesCarried: planned.plan.slides.filter(s => s.imageRef !== null && s.imageRef !== undefined).length,
          imagesFound: extract.images.length
        },
        warnings: [...extract.warnings, ...planWarnings, ...planned.warnings, ...built.warnings]
      });
      res.end();
    } catch (error) {
      console.error('PDF to PPTX failed:', error.message);
      emit({ stage: 'failed', error: `The conversion did not finish: ${error.message.slice(0, 200)}` });
      res.end();
    }
  });

  return router;
}
