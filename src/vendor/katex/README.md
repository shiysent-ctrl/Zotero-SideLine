# KaTeX vendor files

This directory contains the browser distribution of KaTeX 0.18.9, bundled so Zotero Sideline can render formulas offline.

- Source package: `katex@0.18.9` from the npm registry
- Included: `katex.min.js`, `katex.min.css`, the referenced WOFF2 fonts, and `LICENSE`
- License: MIT; see `LICENSE`
- Local modifications: none

The plugin loads `katex.min.js` into its bootstrap sandbox before its own modules. Reader documents receive `katex.min.css` on demand from `Sideline.util.ensureMathStyles()`.
