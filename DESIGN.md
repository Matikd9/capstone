---
name: Nexxo Postulación El Teniente
description: Portal de postulación y panel RR.HH. vestidos como EPP de alta visibilidad; naranja flúor y franja reflectante solo en lo activo.
colors:
  graphite: "#1c232d"
  graphite-raised: "#2a3340"
  shell-line: "#3d4757"
  text-secondary: "#4a5562"
  text-muted: "#626c78"
  cold-ground: "#eef0f2"
  surface: "#ffffff"
  surface-sunken: "#f6f7f8"
  surface-recessed: "#e9ecef"
  line: "#d5d9de"
  line-strong: "#b4bcc5"
  hivis: "#ff6a13"
  hivis-deep: "#e05a0a"
  hivis-tint: "#fff1e8"
  reflect: "#c7ccd2"
  stripe: "#ffffff"
  reflect-hi: "#eef1f4"
  reflect-dim: "#9aa3ad"
  ok: "#1f7a48"
  ok-tint: "#e7f4ec"
  ok-line: "#9fd1b3"
  ok-on-dark: "#86d6a6"
  danger: "#b83224"
  danger-tint: "#fbecea"
  danger-line: "#eeb2a9"
  warn: "#9a5a00"
  warn-tint: "#fdf2e1"
  warn-line: "#efc27e"
  info: "#1d5fb8"
  info-tint: "#e8f0fb"
  info-line: "#a9c4ea"
typography:
  display:
    fontFamily: "Archivo, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "2.125rem"
    fontWeight: 800
    lineHeight: 1.15
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 800
    lineHeight: 1.15
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 700
    lineHeight: 1.3
  title-sm:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 700
    lineHeight: 1.15
  body:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
  body-sm:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.55
  caption:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "Archivo Narrow, Archivo, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.05em"
  numeral:
    fontFamily: "Archivo Narrow, Archivo, system-ui, sans-serif"
    fontSize: "2.125rem"
    fontWeight: 700
    lineHeight: 1
    fontFeature: "tnum"
  numeral-metric:
    fontFamily: "Archivo Narrow, Archivo, system-ui, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 700
    lineHeight: 1.1
    fontFeature: "tnum"
rounded:
  sm: "4px"
  md: "6px"
  lg: "10px"
  full: "50%"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  base: "16px"
  lg: "24px"
  xl: "32px"
  2xl: "40px"
components:
  shell-bar:
    backgroundColor: "{colors.graphite}"
    textColor: "{colors.reflect-hi}"
    height: "64px"
  phase-segment-pending:
    backgroundColor: "{colors.graphite-raised}"
    textColor: "{colors.reflect-dim}"
    height: "76px"
  phase-segment-active:
    backgroundColor: "{colors.hivis}"
    textColor: "{colors.graphite}"
    height: "76px"
  phase-segment-completed:
    backgroundColor: "{colors.graphite-raised}"
    textColor: "{colors.reflect-hi}"
    height: "76px"
  button-primary:
    backgroundColor: "{colors.hivis}"
    textColor: "{colors.graphite}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 20px 5px"
    height: "48px"
  button-primary-hover:
    backgroundColor: "{colors.hivis-deep}"
    textColor: "{colors.graphite}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.md}"
    padding: "0 20px"
    height: "48px"
  button-secondary-hover:
    backgroundColor: "{colors.surface-sunken}"
  button-danger:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.danger}"
    rounded: "{rounded.md}"
    padding: "0 20px"
    height: "48px"
  button-danger-hover:
    backgroundColor: "{colors.danger-tint}"
  button-success:
    backgroundColor: "{colors.ok-tint}"
    textColor: "{colors.ok}"
    rounded: "{rounded.md}"
    padding: "0 20px"
    height: "48px"
  button-on-dark:
    backgroundColor: "transparent"
    textColor: "{colors.reflect-hi}"
    rounded: "{rounded.md}"
    height: "44px"
  button-disabled:
    backgroundColor: "{colors.surface-recessed}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.md}"
  button-sm:
    padding: "0 14px"
    height: "40px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.graphite}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 14px"
    height: "48px"
  option-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.graphite}"
    rounded: "{rounded.md}"
    padding: "14px 16px"
    height: "56px"
  option-card-selected:
    backgroundColor: "{colors.hivis-tint}"
    textColor: "{colors.graphite}"
  status-neutral:
    backgroundColor: "{colors.surface-recessed}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "4px 10px"
    height: "28px"
  status-ok:
    backgroundColor: "{colors.ok-tint}"
    textColor: "{colors.ok}"
  status-danger:
    backgroundColor: "{colors.danger-tint}"
    textColor: "{colors.danger}"
  status-warn:
    backgroundColor: "{colors.warn-tint}"
    textColor: "{colors.warn}"
  status-info:
    backgroundColor: "{colors.info-tint}"
    textColor: "{colors.info}"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "32px 36px 36px"
  matrix-row:
    backgroundColor: "{colors.surface}"
    typography: "{typography.body-sm}"
    height: "48px"
---

# Design System: Nexxo Postulación El Teniente

## Overview

**Creative North Star: "Alta Visibilidad"**

The interface dresses like the worker's own personal protective equipment. A graphite shell bar carries the logo on a white plate; below it the page floor is a cold light grey and every working surface is white with a 1px hairline. Against that quiet field, one thing glows: a fluorescent orange band crossed by a double white retroreflective stripe, worn only by whatever is active right now: the current phase, the one action that advances, the focus ring. Statuses speak the hard-hat code of a mining site (green conforme, red descarte, amber revisión, blue en curso, grey pendiente), each one an explicit mark with a square swatch and an uppercase narrow label.

Density follows the reader. The applicant portal is generous and touch-first (48px fields and buttons, 56px option cards, a 352px rail explaining why each document is asked for). The RR.HH. panel is a high-density module board: a five-cell metrics strip split by hairlines, a sticky-header matrix with 48px rows grouped action-first, and a right-hand drawer that opens the file without losing the matrix. Motion is brief and literal: a sheen crosses the reflective stripe when a phase activates, like headlights sweeping a vest, and a state cell flips like a split-flap board when it changes. Both stand down under reduced motion.

The system rejects the grey SaaS portal with a blue stepper and the earlier yellow-and-black hazard-stripe look. No gradients for atmosphere, no glass, no blur.

**Key Characteristics:**
- Fluorescent orange is reserved; the reflective double stripe is the signature of "active".
- Hard-hat state code for every status, always as an explicit labelled mark.
- Archivo for reading, Archivo Narrow in caps for labels and tabular numerals.
- Flat white modules on a cold grey floor, 1px hairlines, 6px corners.
- Unavailable means struck through; loading and "current" are never struck.

## Colors

A cold, graphite-and-grey industrial field where colour is spent only on activity (orange) and on state (hard-hat code).

### Primary
- **Fluorescent Hi-Vis Orange** (hivis): the current phase segment, the primary CTA, the focus ring, the text caret, and the applicant's own current choice (selected quiz option with its orange key, checked consent box). Text on it is always graphite, never white.
- **Pressed Hi-Vis** (hivis-deep): hover and pressed state of anything in hivis; border of the checked consent box.
- **Hi-Vis Wash** (hivis-tint): background of a selected quiz option only.

### Secondary
- **Reflective Tape White** (stripe, #ffffff): the double stripe on the active phase, the tape line inside the primary button's bottom edge, the login panel's vertical stripe and the email band. White, not silver: on orange it reads as tape catching light.
- **Silver** (reflect): the drawer head's bottom rule, pending rail dots, camera reticle corners, labels on graphite.
- **Silver Highlight** (reflect-hi): body text on the graphite shell, completed phase labels.
- **Dim Silver** (reflect-dim): pending phase numbers and labels on graphite.

### Tertiary (hard-hat state code)
Each state has a text colour, a tint background and a line colour, used together.
- **Conforme Green** (ok / ok-tint / ok-line): approved, pre-acreditado, contratado, loaded dropzone, completed checks. ok-on-dark is the completed-phase check on graphite.
- **Descarte Red** (danger / danger-tint / danger-line): descartado, rechazado, file errors, destructive buttons.
- **Revisión Amber** (warn / warn-tint / warn-line): en revisión manual, pendiente, OCR warnings.
- **En Curso Blue** (info / info-tint / info-line): preseleccionado, aprobado faena, docs cargados.
- **Pendiente Grey** (surface-recessed with text-secondary): postulado and any not-yet-started state.

### Neutral
- **Graphite** (graphite): the shell bar, primary text, the quiz timer block, camera button, text on hivis.
- **Raised Graphite** (graphite-raised): the phase band floor and pending/completed segments; shell hover.
- **Shell Hairline** (shell-line): 1px borders of controls sitting on graphite.
- **Cold Ground** (cold-ground): the page floor behind every module.
- **Surface / Sunken / Recessed** (surface, surface-sunken, surface-recessed): white modules; table headers, hover rows, notes; disabled fills, neutral status, option keys.
- **Hairline / Strong Hairline** (line, line-strong): module borders and dividers; field strokes, dashed dropzones, secondary button borders.
- **Secondary / Muted Text** (text-secondary, text-muted): descriptions and leads; hints, captions, uppercase labels.

### Named Rules
**The Hi-Vis Reservation Rule.** Orange marks only what is active now: the current phase, the single primary action, focus, and the user's own current selection. Never decoration, never a heading, never an icon tint, never a second primary button on the same view.

**The Hard-Hat Code Rule.** Every status uses exactly one of the five state families, always as text colour on its own tint. Colour never carries state alone; it travels with an uppercase label and a square swatch.

## Typography

**Display Font:** Archivo (with system-ui, -apple-system, Segoe UI, Roboto, sans-serif)
**Body Font:** Archivo
**Label Font:** Archivo Narrow (with Archivo, system-ui)

**Character:** A sturdy grotesque that reads like site signage at heavy weights, paired with its narrow cut for the caps labels and numerals of equipment tags. Both load from Google Fonts at weights 400 to 800 (Narrow 500 to 700).

### Hierarchy
- **Display** (800, 2.125rem, 1.15, -0.01em): the portal page title and the login brand title on graphite; 1.75rem under 767px.
- **Headline** (800, 1.75rem, 1.15): the title of each wizard step and the denser RR.HH. panel page title (1.375rem on mobile).
- **Title** (700, 1.375rem, 1.3): quiz question text (max 62ch), modal and drawer titles.
- **Title Small** (700, 1.125rem): form section headings, matrix title, drawer section titles.
- **Body** (400, 1rem, 1.55): running text and field values; leads cap at 68 to 80ch.
- **Body Small** (400, 0.875rem): field labels (600), matrix cells, rail copy, buttons in dense contexts.
- **Caption** (400, 0.8125rem, 1.45): field hints, dropzone subtext, metric descriptions.
- **Label** (Narrow 600, 0.75rem, 0.05em, uppercase): definition-list terms, table headers, filter labels, metric labels, status pills (0.04em), group rows (700), rail section titles (0.875rem, 700).
- **Numeral** (Narrow 700, 2.125rem, 1, tabular): phase numbers and the quiz countdown. Metric values use the 1.875rem variant; folios use Narrow 700 at 0.9375rem.

### Named Rules
**The Tabular Numerals Rule.** Every number that can change or be compared (folios, scores, RUT, timers, counts, metrics, inputs) sets `font-variant-numeric: tabular-nums` so columns and countdowns never jitter.

**The Caps Belong to Labels Rule.** Uppercase Narrow is for naming a field, column, metric, state or rail section. It never sits as a small tag stacked above a heading; context lines (such as quiz progress) run in sentence case.

## Layout

A centred page column (1280px max on the portal, 1600px on the panel) with 40px side gutters on desktop, 24px under 1023px. The graphite shell (64px) and the phase band (76px) run edge to edge; the band's outer segments pad their content to align with the page column, so the vest reads at a glance across the full window while text still sits on the grid.

The portal is a two-column grid: a fluid white form card (padding 32/36px) and a 352px sticky rail, 32px apart; under 1023px the rail drops below and stops sticking. The page head pairs the title with a fact strip: definition items separated by vertical hairlines between horizontal rules. Inside forms, sections stack 28px apart, each opened by a 1px top rule; the action bar closes the card with a rule and right-aligned primary action.

The panel stacks a page head, a five-cell metrics strip (cells separated by 1px gaps over a hairline background), and the matrix panel (toolbar with filters, a synced top scrollbar, a scroll container with sticky headers, 1200px minimum table width). The expediente drawer is 920px wide (full width on small screens) with a sticky head and a sticky decision footer.

Spacing rhythm steps 4, 8, 12, 16, 24, 32, 40px, with 28px between form sections and 72px below the main column. Breakpoints: 1023px, 767px, 639px (panel also 1100px and 380px). Touch targets are 44px minimum, 48px for fields and buttons.

## Elevation & Depth

Flat by construction. Depth comes from tonal layering (graphite shell over cold ground over white modules) and 1px hairlines, not from lifting. Two soft shadows exist and both are graphite-tinted, never black.

### Shadow Vocabulary
- **Resting module** (`0 1px 2px rgba(28,35,45,0.06), 0 1px 1px rgba(28,35,45,0.04)`): form card, rail, metrics strip, matrix panel. Barely there; the hairline does the work.
- **Overlay** (`0 8px 24px rgba(28,35,45,0.12), 0 2px 6px rgba(28,35,45,0.06)`): drawer, toasts, notification dropdown, skip link. Only for things that float above the page.
- **Decision footer** (`0 -6px 16px rgba(28,35,45,0.06)`): the drawer's sticky decision bar, separating it from scrolling content.

The primary button carries a 3px white tape line just above its bottom edge, drawn with two inset shadows (`inset 0 -5px 0` hivis over `inset 0 -8px 0` stripe; shifted up 2px when pressed, matched to hivis-deep on hover). It reads as reflective tape, not elevation.

### Named Rules
**The Hairline Before Shadow Rule.** Separate with a 1px line or a tonal step first. Shadow is reserved for overlays; a resting module never gets more than the resting shadow.

## Shapes

Gently squared industrial forms. Controls, buttons, fields, callouts and option cards use a 6px corner (md); larger modules (form card, rail, metrics strip, matrix panel, dropzones, toasts) use 10px (lg); small tags (status pills, option keys, checkbox, logo plate) use 4px (sm). Only dots and the dropzone icon disc are round. Status swatches are hard squares (8px). The drawer's state swatch is a small hard-hat silhouette (22x12px, 6px top corners, 2px bottom). Dropzones are 2px dashed until filled, then solid in the state code. Field strokes are 1.5px; module borders 1px.

## Components

### Phase Band (signature)
The vest itself. Three equal segments on raised graphite, edge to edge, 76px tall.
- **Active:** fluorescent orange with the double white stripe at 9 to 17% and 83 to 91% of the height (hard stops, no blending), graphite text, and a one-time 700ms white sheen sweeping across 150ms after activation. Its neighbour's divider disappears so the band reads as one strip.
- **Pending:** dim silver Narrow numeral (2.125rem) and caps label on graphite.
- **Completed:** the numeral is replaced by a green-on-dark check; label in silver highlight at weight 500.
- **Mobile:** gutters tighten to 24px, numerals drop to 1.75rem, labels wrap.

### Buttons
- **Shape:** 6px corners, 48px tall (40px small, 36px inside matrix rows, 56px large), weight 700.
- **Primary:** hivis fill, graphite text, a white tape line inside its bottom edge; hover deepens to hivis-deep. One per view.
- **Secondary:** white with a strong hairline; hover moves to sunken surface. **Danger:** white with red line and text, red tint on hover. **Success:** green tint, line and text, used for confirmed results (and copied links). **Camera:** graphite fill, white text. **On dark:** transparent with shell hairline, for the shell bar.
- **Disabled (unavailable):** recessed fill, no strip, label struck through (1.5px muted line).
- **Disabled (loading):** same fill, never struck; a 16px spinner leads the label and the cursor shows progress.
- **Current state (drawer decision):** the button for the file's present state is disabled but not struck; it carries a positive "Estado actual" tag (white, strong hairline, Narrow 700 caps at 0.6875rem).
- **Focus:** 2px hivis outline, 2px offset, on every interactive element.

### Status Pills (hard-hat tags)
- **Style:** 28px tall, 4px corners, Narrow 600 caps at 0.75rem, an 8px square swatch in currentColor before the label, text colour on its own tint.
- **States:** the five hard-hat families map each state of the hiring machine. In the matrix the pill is fixed at 10.75rem min width so a state change never moves columns. Code badges (OCR/biometric verdicts) share the shape without the swatch.

### Matrix (RR.HH.)
- **Order:** action first. Group rows (sunken, Narrow 700 caps with a muted count) split "Requiere acción" from the rest.
- **Rows:** 48px, 0.875rem, hairline dividers, hover to sunken surface; sticky Narrow caps headers on sunken.
- **Estado cell:** the whole cell takes the state tint, pill sits transparent inside. On change, the cell flips open top-down (320ms clip) and a white sheen crosses it (340ms), like a split-flap board.
- **Row actions:** secondary small buttons at 36px.

### Metrics Strip
Five white cells in one module, separated by 1px hairline gaps. Each cell has a 4px top bar (strong hairline by default, or the state colour it counts), a caps label, a Narrow tabular value and a caption.

### Inputs / Fields
- **Style:** 48px, white, 1.5px strong hairline, 6px corners, tabular numerals; selects carry a drawn chevron.
- **Focus:** hivis outline. **Invalid** (after interaction): red stroke. **Disabled/locked:** sunken fill.
- **Dropzone:** 172px min, 2px dashed strong hairline, a 48px round icon disc; hover/drag turns the border graphite; loaded turns solid green on green tint; error red on red tint.
- **Consent box:** bordered row with a 24px custom checkbox that fills hivis with a graphite check when accepted; the row border goes graphite.

### Option Cards (quiz)
56px min, white, 1.5px strong hairline, a 28px Narrow letter key on recessed grey. Selected: hivis border plus inner 1px ring, hivis wash, and the key fills hivis.

### Cards / Containers
- **Corner Style:** 10px. **Background:** white on cold ground. **Shadow:** resting module only. **Border:** 1px hairline. **Padding:** 32/36px for the form card, 22/24px for rail sections.
- **Callouts and result notes:** 6px corners, tint plus line in a state family, used for OCR banners and dictamen notes.

### Navigation (shell)
Graphite bar, 64px, logo on a white 4px plate (32px tall), context line in silver at 0.875rem, a bordered help or session control on the right with ink-2 hover. The panel adds a notification bell with a count badge and a dropdown overlay.

### Expediente Drawer
920px right panel over a 48% graphite scrim, sliding in 220ms. Sticky head with a silver bottom rule shows the name and a hard-hat swatch plus caps state label in its state colour. Sections split by hairlines; the decision bar sticks to the bottom.

### Login
Split screen: graphite brand panel with logo plate, display title and a flat vertical reflective stripe (two white bands, graphite between) near its right edge; white form side with a single primary button.

## Do's and Don'ts

### Do:
- **Do** use the same system in transactional email (src/mailer.js): graphite header with logo plate, orange phase band with white stripes, white body, hard-hat status pill, orange button with white tape line, graphite footer; table layout, inline styles, Arial as the font fallback.
- **Do** keep hivis to the current phase, the one primary action, the focus ring and the user's current selection; text on it is graphite.
- **Do** draw the reflective stripe as hard-stop white bands (9 to 17% and 83 to 91% on horizontal bands; flat vertical bands on the login panel), never as a soft gradient.
- **Do** show every status as a labelled hard-hat mark: square swatch, Narrow caps label, text colour on its own tint.
- **Do** strike through the label of an unavailable button, and keep loading buttons (spinner) and the drawer's current-state button (positive "Estado actual" tag) unstruck.
- **Do** set every comparable number in tabular numerals, and labels in Archivo Narrow caps.
- **Do** order RR.HH. lists action first and keep column geometry fixed when a state changes.
- **Do** separate with 1px hairlines and tonal steps; keep shadows to the resting and overlay values.
- **Do** keep 48px fields and buttons and 44px minimum targets on the applicant side.
- **Do** disable the phase sheen and the state flip under `prefers-reduced-motion`.

### Don't:
- **Don't** use orange for decoration, headings, icons, links, borders at rest or a second CTA.
- **Don't** bring back the blue SaaS stepper or the yellow-and-black hazard stripe.
- **Don't** add gradients for atmosphere, glass, blur or backdrop effects; the only gradient-built shapes are the hard-stop reflective stripe and the momentary sheen.
- **Don't** stack a small uppercase tag above a heading; a pill above a heading must carry a real state.
- **Don't** set interface text in monospace. The panel's raw OCR log and magic-link box currently use a system monospace stack for literal data; that is a carried exception, not a pattern to extend.
- **Don't** use text glyphs or emoji as icons; icons are drawn SVG (2px stroke) inline or as masks.
- **Don't** let colour carry a state without its label.
- **Don't** use the legacy alias variables (`--ecf-*`, `--safety-yellow*`, `--status-*`, `--radius-terminal`) in new work; they exist only so existing JS keeps resolving.
