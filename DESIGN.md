# Threadline Design System

## Overview

Threadline uses a restrained product interface built around a persistent navigation rail, a broad working canvas, and strong typographic hierarchy. The visual system should feel closer to an editor or research desk than a sales dashboard.

## Principles

- Prefer one continuous workspace over a grid of floating cards.
- Use lines, spacing, and type weight to create structure before adding containers.
- Reserve color for selection, action, and meaningful status.
- Keep data compact but never cramped; chronology and provenance must scan quickly.
- Use familiar controls and modest 150–200ms state transitions.

## Color

All production colors are represented as OKLCH design tokens.

- `--background`: `oklch(1 0 0)` — pure white working canvas.
- `--surface-subtle`: `oklch(0.978 0.004 150)` — quiet navigation and grouped regions.
- `--surface-raised`: `oklch(0.99 0.002 150)` — controls that need separation.
- `--ink`: `oklch(0.18 0.012 255)` — deep neutral text.
- `--ink-muted`: `oklch(0.48 0.018 255)` — secondary copy.
- `--line`: `oklch(0.91 0.008 150)` — default dividers.
- `--accent`: `oklch(0.600 0.158 150)` — primary action and current selection.
- `--accent-strong`: `oklch(0.51 0.145 150)` — accessible hover/pressed treatment.
- `--secondary`: `oklch(0.61 0.12 238)` — distinct blue accent for source/provenance cues.
- `--warning`: `oklch(0.67 0.14 73)`; `--danger`: `oklch(0.58 0.19 25)`.

No gradients or purple AI accents. Inactive elements remain neutral.

## Typography

Use a single system sans stack: Inter when available, then `ui-sans-serif`, `-apple-system`, `BlinkMacSystemFont`, and `Segoe UI`. Use a fixed compact scale from 12px metadata through 28px page titles. Body copy defaults to 14px/1.55. Numeric summaries use tabular numerals.

## Shape and Elevation

- Primary radius: 8px; compact controls: 6px; large empty states: 12px.
- Avoid full-pill controls except true statuses or compact filters.
- Shadows are exceptional. Prefer a 1px divider; menus may use a restrained neutral shadow.

## Layout

- Desktop navigation rail: 232px.
- Content max width: 1440px, with 28–40px page gutters.
- Primary pages use a title/action row, then divided sections or tables.
- On narrow screens the rail becomes a compact top navigation; content retains 16px gutters.

## Components

- Navigation: icon plus precise text label; selected state uses a slim accent marker and tinted surface.
- Buttons: solid accent for the single primary action, neutral outline or text for secondary actions.
- Tables and timelines: subtle row dividers, 44–52px rows, sticky labels only when they improve scanning.
- Empty states: concise guidance embedded in the relevant section, never a detached promotional card.
- Status: pair a restrained dot or icon with plain language. Do not communicate state through color alone.
- Focus: 2px accent outline with 2px offset on every interactive element.

## Motion

Use 150–200ms easing for hover, disclosure, and selection changes. Disable nonessential transitions under `prefers-reduced-motion`. Never choreograph page-load animation.
