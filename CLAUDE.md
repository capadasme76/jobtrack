# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

**JobTrack** is a live, deployed job-search dashboard for executive job seekers (pipeline de postulaciones, red de contactos, match de CV, reuniones, métricas, portales), running at **[jobtrack.cl](https://jobtrack.cl)**. It started as a static-HTML prototype and is now a real multi-user product: Supabase for auth/database, Vercel for hosting (auto-deploys on push to `main`), Cloudflare for DNS, and a Vercel serverless function for AI-assisted CV parsing. There is still no build system or bundler — every page is a self-contained HTML file, edited directly.

Everything else (`Avance 1/`, `Tester 5/`, `Tester 6/`, `Tester 7/`, `tester 2/`, `tester 3/`, `tester 4/`, `diseño/`) holds earlier iterations, exported snapshots, and zip archives from previous design passes — treat these as historical/reference material, not code to maintain. Don't edit files inside those folders unless the user explicitly asks you to work on a specific snapshot.

[JobTrack_Prompt_Claude_Design.md](JobTrack_Prompt_Claude_Design.md) is the original design brief (in Spanish) that specifies the pages, layout, color palette, and typography — consult it when making visual/design decisions. `diseño/design_handoff_jobtrack/` has the fuller original Home page design that `index.html` was rebuilt from.

## Site map

| File | Purpose |
|---|---|
| `index.html` | Public marketing Home — hero, feature grid, "Quiénes somos", FAQ + keyword-matching contact bot, Contáctanos. SEO metadata (OG/Twitter/JSON-LD) lives here. |
| `login.html` | Login/signup (Supabase Auth). Signup mode never auto-redirects on an existing session — see "Known-tricky areas" below. |
| `jobtrack-dashboard-cristian.html` | The dashboard app itself (~2200 lines) — everything after login. |
| `terminos.html`, `privacidad.html` | Términos y Condiciones / Política de Privacidad. Drafts referencing Ley N° 21.719 (Chile's data protection law, in force Dec 2026) — explicitly marked as needing real legal review, not a substitute for one. |
| `supabase-config.js` | Exports `SUPABASE_URL` / `SUPABASE_ANON_KEY` (anon key is public by design — RLS does the real access control). Imported by `login.html`, the dashboard, and `api/extract-cv.js`. |
| `supabase-schema.sql` | The `jobtrack_state` table + RLS policy. Run manually in the Supabase SQL editor — there's no migration tooling. |
| `api/extract-cv.js` | Vercel serverless function (Node, ESM). See "AI CV extraction" below. |
| `scripts/check-watched-pages.mjs` | Node script run by `.github/workflows/check-watched-pages.yml` on a daily cron. See "Watched-page checker" below. |
| `robots.txt`, `sitemap.xml` | Only `index.html` (and the legal pages) are indexable; `login.html` and the dashboard are `noindex`. |
| `package.json` | Exists only so Vercel treats `api/*.js` as ES modules (`"type": "module"`) — no dependencies, no build script. Doesn't affect the static HTML files at all. |

## Working locally

No build/lint/test command for the static pages:

```bash
python3 -m http.server 8000
```
then visit `http://localhost:8000/jobtrack-dashboard-cristian.html`. This serves the static files fine, but **cannot run `api/extract-cv.js`** (that's a real serverless function) — test that endpoint against a production/preview deploy instead, or use `vercel dev` if you need it locally.

**Validate changes**: no automated tests. Check the browser console for JS errors (everything runs inline, no framework/TypeScript to catch mistakes at write-time), and exercise the relevant section end-to-end.

## Architecture (jobtrack-dashboard-cristian.html)

Single file: inline `<style>`, then HTML markup for all sections, then `<script type="module">` (an IIFE, with `supabase`/`currentUserId` declared at module top level outside it so the whole file can import ES modules). No frameworks — vanilla JS, direct DOM manipulation (`document.getElementById`, manual `innerHTML` rendering).

**This is a single continuously-scrolling page, not tabs.** The sidebar nav (`.jt-nav a`) just does `scrollIntoView` to an anchor — there's no show/hide of sections. **This means DOM order of the `.jt-module` blocks is literally the visual top-to-bottom order the user sees**; reordering sections means moving whole `<div class="jt-module">...</div>` blocks, not changing a JS render order. Current order: Hoy → Mi perfil → Pipeline → Match CV → Reuniones → Mis contactos → Métricas → Portales → Guía. Mi perfil sits early (right after Hoy) so new users fill in real data before using anything that depends on it (Match CV, cover letters) — it's still collapsed by default (`jt-collapsible-title` pattern) so that early position doesn't force a long form on everyone. Match CV sits third, ahead of Reuniones/Contactos/Métricas, since it's the product's strongest hook. Guía (a static how-to reference, distinct from the "Primeros pasos" onboarding checklist) is last, matching where reference/help content conventionally sits.

**Auth & persistence**: `supabase.auth.getSession()` gates everything — `loadState()` redirects to `login.html` if there's no session. `persist()` upserts the entire `state` object as one JSONB blob per `user_id` into the `jobtrack_state` table (RLS: `auth.uid() = user_id`). No partial updates — every mutation re-saves the whole state.

**State**: a single global `state` object (`opportunities`, `networking`, `meetings`, `profile`, `profileCvVersion`, `dismissedDispatchIds`, `onboarding`, `onboardingDismissed`, `dispatches`, `watchedPages`) seeded from `seedOpportunities`/`seedNetworking`/`seedMeetings`/`seedProfile`/`seedDispatches` example data **only for brand-new accounts** (`loadState()` only applies seed-shaped defaults for fields missing from the loaded row, it never overwrites real saved data). `profileCvVersion` gates one-time forced profile re-seeds — bump that string when the seed profile shape changes and needs to override previously saved state. `onboarding` is a set of boolean flags (profile/opportunity/contact/match/meeting) driving the "Primeros pasos" checklist shown above Hoy for new users — existing accounts predating this field get `onboardingDismissed = true` on load instead of seeing it retroactively.

**Render pipeline**: each data section has its own `render*()` function (`renderProfile`, `renderStats`, `renderDispatches`, `renderBoard`, `renderNetworking`, `renderMeetings`, `renderMetrics`, `renderTicker`, `renderMasthead`, `renderEdition`). `renderAll()` calls all of them (order-independent — each writes only to its own DOM ids) and runs after `loadState()` resolves, then again after each mutation followed by `persist()`. No diffing — each render fully rebuilds its section's `innerHTML`.

**Event wiring**: `wireForms()`, `wireIO()`, `wireNav()` attach all listeners once at startup. New interactive elements need listeners added in the relevant `wire*()` function, not inline `onclick`.

**Sections**: Hoy (stats + dispatches ticker — `state.dispatches` is real & persisted, seeded once with 2 examples, not a hardcoded constant), Mi perfil (collapsed by default, `jt-collapsible-title` pattern; sub-sections Experiencia/Formación/Carta also collapse individually via `profileExpanded`), Pipeline (kanban board, drag/drop by stage, columns cap at `max-height:600px` with their own scroll on desktop only — see "Known-tricky areas", Excel import/export via SheetJS CDN, moved below the board as a secondary action), Match CV (`runMatchAnalysis` — client-side text/keyword matching, no external API — the result includes an explicit disclaimer that it's not a real fit evaluation), Reuniones, Mis contactos (own Excel template/import, plus a name/company search box), Métricas (didactic: % of total per stage, color-coded, tooltips), Portales (static external job-board links), Guía (static how-to reference, 8 numbered steps matching the section order above, each linking to its section).

**Georeferenciación**: `region` field (16 Chilean regions, `CHILE_REGIONS`/`regionOptionsHtml()`) on opportunities and contacts, with a Pipeline filter and Excel column.

**AI CV extraction**: "Mi perfil → Editar" has a CV upload (PDF/`.docx` only, not legacy `.doc`). Text extraction happens **client-side** (pdf.js / mammoth.js, CDN-loaded) — the file itself is never uploaded anywhere. The extracted text is POSTed to `/api/extract-cv` with the user's Supabase access token; that function verifies the token against Supabase before calling Claude (`claude-haiku-4-5-20251001`, forced tool-calling for structured JSON) and returns fields matching `state.profile`'s shape. The response only pre-fills the edit-form fields — nothing is saved until the user reviews and clicks "Guardar perfil".

**Watched-page checker (Fase 2)**: opportunities can optionally have a `careerUrl` (the company's general jobs page, distinct from `link` which is the specific posting) — kept in sync via `syncWatchedPage()`/`removeWatchedPage()` into `state.watchedPages`. `scripts/check-watched-pages.mjs` runs daily via GitHub Actions, hashes each watched page's normalized text, and — only on a detected change — pushes a "verificar tú" entry into that user's `state.dispatches` via Supabase's REST API (service_role key, bypasses RLS by design). Explicitly skips any `linkedin.com` URL (scraping LinkedIn violates their ToS). This replaced an earlier plan to aggregate real job postings — validated that Greenhouse/Lever/Ashby/datos.gob.cl have zero API coverage for this product's target companies (large traditional Chilean employers), so full aggregation isn't viable without a paid API, which was explicitly ruled out.

**Word export**: `downloadWordDoc()` builds a minimal HTML-as-.doc file (MIME trick, not a real docx) — used by `exportProfileToWord()`/`exportCartaToWord()`.

## Known-tricky areas (read before touching)

- **Signup session hijack**: `login.html` used to auto-redirect to the dashboard on *any* existing Supabase session, even mid-signup — meaning a tester on a browser with a leftover session got dropped into someone else's account before they could submit the signup form. Fixed: signup mode now shows a "close this session first" notice instead of redirecting silently. Don't reintroduce a blind `getSession() → redirect` on the signup path.
- **Pipeline scroll**: `.jt-col` has `max-height:600px; overflow-y:auto`, and `.jt-board` uses `align-items:start` (CSS Grid defaults to `stretch`, which used to force every column to match the tallest one's height). If Pipeline columns start looking wrong again, check these two rules first.
- **Two different "link" fields on an opportunity**: `link` is the specific job posting (for "Postular"), `careerUrl` is the company's general jobs page (for the watched-page checker). Users found these confusing before the fields were relabeled — keep the labels explicit if touched again.
- **Only `link` is required** when adding an opportunity — `empresa`/`cargo`/`sector` default to placeholder text ("Empresa por confirmar", etc.) and the opportunity gets auto-flagged `incompleta: true` if left blank. Don't reintroduce a hard requirement on those fields.
- **Secrets**: Supabase `service_role` key lives only as a GitHub Actions secret (`SUPABASE_SERVICE_ROLE_KEY`) and is easy to confuse with the `anon` key or Supabase's newer `sb_secret_...` format (same project, different key system — the classic JWT-based anon/service_role pair is under Supabase's "Legacy API keys" tab now). `ANTHROPIC_API_KEY` lives only as a Vercel environment variable. Neither should ever be hardcoded or imported into client-facing code — `supabase-config.js` intentionally only exports the public anon key.
