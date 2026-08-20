# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

This is a design/prototyping workspace for **JobTrack**, a single-page job-search dashboard for executive job seekers (pipeline de postulaciones, red de contactos, match de CV, reuniones, métricas, portales). There is no build system, package manager, or test suite — the product is one self-contained HTML file per version, editable directly.

The current, most up-to-date version is [jobtrack-dashboard-cristian.html](jobtrack-dashboard-cristian.html) at the repo root. Everything else (`Avance 1/`, `Tester 5/`, `Tester 6/`, `Tester 7/`, `tester 2/`, `tester 3/`, `tester 4/`, `diseño/`) holds earlier iterations, exported snapshots, and zip archives from previous design passes — treat these as historical/reference material, not code to maintain. Don't edit files inside those folders unless the user explicitly asks you to work on a specific snapshot.

[JobTrack_Prompt_Claude_Design.md](JobTrack_Prompt_Claude_Design.md) is the original design brief (in Spanish) that specifies the pages, layout, color palette, and typography the dashboard should follow — consult it when making visual/design decisions.

## Working with the HTML file

There is no build, lint, or test command. The file is plain HTML/CSS/JS with no bundler:

- **Preview**: open the file directly in a browser, or serve it locally, e.g.:
  ```bash
  python3 -m http.server 8000
  ```
  then visit `http://localhost:8000/jobtrack-dashboard-cristian.html`.
- **Validate changes**: there are no automated tests. Verify by opening the file in a browser and exercising the relevant section (see Architecture below) — check the browser console for JS errors since everything runs inline with no framework to catch mistakes.

## Architecture (jobtrack-dashboard-cristian.html)

Single file, ~2000 lines: inline `<style>` block, then HTML markup for all sections, then a single inline `<script>` block containing all app logic. No frameworks — vanilla JS with direct DOM manipulation (`document.getElementById`, manual `innerHTML` rendering).

**Theming**: CSS custom properties on `:root`, redefined under `@media (prefers-color-scheme: dark)` for automatic dark mode. Fonts loaded from Google Fonts.

**State**: a single global `state` object (`opportunities`, `networking`, `meetings`, `profile`, `profileCvVersion`, `dismissedDispatchIds`, `welcomeBannerDismissed`) seeded from `seedOpportunities` / `seedNetworking` / `seedMeetings` / `seedProfile` example data. State is persisted via `persist()` / `loadState()`, which call `window.storage.set/get("jobtrack-state", ...)` — this is the Claude Artifact runtime storage API, **not** `localStorage` or a backend. `loadState()` also handles one-time forced migrations keyed on `profileCvVersion` (e.g. re-seeding the profile after a CV update) — bump that version string when the seed profile/meetings shape changes and needs to override previously saved state.

**Render pipeline**: each data section has its own `render*()` function (`renderProfile`, `renderStats`, `renderDispatches`, `renderBoard`, `renderNetworking`, `renderMeetings`, `renderMetrics`, `renderTicker`, `renderMasthead`, `renderEdition`) that re-renders its DOM subtree from `state`. `renderAll()` calls all of them and is invoked after `loadState()` resolves on startup, and individually after each mutation (add/edit/delete/drag) followed by `persist()`. There's no diffing — each render fully rebuilds its section's `innerHTML`.

**Event wiring**: `wireForms()`, `wireIO()`, and `wireNav()` attach all event listeners once at startup (form add/cancel/save buttons, sidebar nav clicks, import/export buttons). New interactive elements need their listeners added in the relevant `wire*()` function, not inline `onclick` attributes.

**Sections** (in nav order, matching `id="sec-*"` anchors): Mi perfil, Hoy (stats + dispatches ticker), Pipeline (kanban board with drag/drop by stage, Excel import/export via the SheetJS CDN `xlsx.full.min.js`), Contactos (red de contactos, with its own Excel template/import), Reuniones, Match CV (`runMatchAnalysis` — client-side text matching between pasted job descriptions and the profile, no external API), Métricas, Portales (static list of external job-board links, grouped by category).

**Word export**: `downloadWordDoc()` builds a minimal HTML-as-.doc file (MIME trick, not a real docx) for profile/cover-letter export — used by `exportProfileToWord()` and `exportCartaToWord()`.
