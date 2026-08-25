// Deck templates.
//
// The project had no template system to reuse, so these are a small built-in
// set drawn from the brand tokens already used in the web app (--jsan-blue,
// --jsan-navy, --jsan-cyan and friends in web/src/styles.css) so a generated
// deck looks like it belongs to the same product. Adding a template is adding
// one entry here; the picker in the UI is driven by this list.

export const THEMES = {
  'jsan-blue': {
    id: 'jsan-blue',
    label: 'JSAN Blue',
    description: 'Brand navy title slide, blue headings on white.',
    swatch: ['#0a1a3a', '#0050a9', '#00d4ff'],
    coverBg: '0A1A3A',
    coverTitle: 'FFFFFF',
    coverSubtitle: '9FC4E8',
    slideBg: 'FFFFFF',
    title: '0A1A3A',
    body: '1B2740',
    accent: '0050A9',
    rule: '00D4FF',
    tableHeadBg: '0050A9',
    tableHeadText: 'FFFFFF',
    tableRowBg: 'F2F7FC',
    muted: '6F7787'
  },
  'light-minimal': {
    id: 'light-minimal',
    label: 'Light Minimal',
    description: 'Restrained monochrome with a single accent rule.',
    swatch: ['#ffffff', '#172033', '#0050a9'],
    coverBg: 'FFFFFF',
    coverTitle: '111827',
    coverSubtitle: '6F7787',
    slideBg: 'FFFFFF',
    title: '111827',
    body: '2B3444',
    accent: '374151',
    rule: '0050A9',
    tableHeadBg: '111827',
    tableHeadText: 'FFFFFF',
    tableRowBg: 'F5F6F8',
    muted: '8B95A6'
  },
  'dark-slate': {
    id: 'dark-slate',
    label: 'Dark Slate',
    description: 'Dark slides for presenting in a lit room.',
    swatch: ['#0d111b', '#7890ff', '#00d4ff'],
    coverBg: '080D16',
    coverTitle: 'FFFFFF',
    coverSubtitle: '9AA6BF',
    slideBg: '121825',
    title: 'F3F6FB',
    body: 'D7DEEA',
    accent: '7890FF',
    rule: '00D4FF',
    tableHeadBg: '1F2A44',
    tableHeadText: 'FFFFFF',
    tableRowBg: '18202F',
    muted: '929BAD'
  }
};

export const DEFAULT_THEME = 'jsan-blue';

export function resolveTheme(id) {
  return THEMES[id] || THEMES[DEFAULT_THEME];
}

/** The shape the picker in the web app needs — no colour internals. */
export function listThemes() {
  return Object.values(THEMES).map(({ id, label, description, swatch }) => ({ id, label, description, swatch }));
}
