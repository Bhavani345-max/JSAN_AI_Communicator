/// <reference types="vite/client" />

// Vite's ambient types declare the non-code imports the bundler resolves —
// `import './styles.css'` among them. Without this reference TypeScript has no
// declaration for a .css module and rejects the import (TS2882), even though
// the build succeeds: `vite build` strips types without consulting them, so the
// error only ever surfaced in `tsc --noEmit`.
