# Portal Meter: design system

The site (landing page `site/index.html`, live page `demo/index.html`) is built as a postage meter for API calls:
credit is loaded once, every call is franked with a signed mark, and the batch goes out under one manifest.

## Colour (tokens in `assets/site.css`)

| Role | Light (mail stock) | Dark (sorting room under UV) |
|---|---|---|
| Ground `--bg` | `#f4f6f9` | `#0a0d19` |
| Surface `--surface` | `#ffffff` | `#121a2e` |
| Ink `--ink` | `#111a30` | `#eef1f8` |
| Franking ink `--accent` (marks, the one action) | `#e6007a` (text `#c4006a`) | `#ff4fa3`, with a glow (`--glow`, `--ink-glow`): the ink fluoresces |
| Postal blue `--post` (EVM lane, signatures) | `#1f4fd6` | `#6f9bff` |

Light or dark follows the system; the header switch overrides it and is remembered (`localStorage` key `pm-theme`,
guarded). Both token sets are written twice: under `prefers-color-scheme: dark` for `:root:not([data-theme="light"])`
and under `:root[data-theme="dark"]`.

## Type

- Archivo (variable, self-hosted): display at width 62 to 82 % and weight 720 to 860 (the meter's numerals and the
  headings), text at width 100 %, 400.
- Martian Mono at width 87.5 %: hashes, addresses, code and terminal output only.

## Components

- The indicium: a double-ruled box (2 px border + 1 px outline, offset 2 px) in franking ink, with wavy cancellation
  lines to its left (`#i-waves`). Used for the price on the live page.
- The postmark: concentric circles, block number in condensed numerals, curved text; rotated -8 degrees.
- The 4-state barcode (`.code4`): generated from the real transaction hash, one bar per hex digit (value mod 4).
- Ruled lists (manifests) instead of card grids: a 2 px ink rule on top, 1 px rules between rows.
- Buttons are stamps: they step down 1 px on hover and press 2 px on click; one filled button per view.

## Motion

- Tokens: `--d-1` 120 ms, `--d-2` 240 ms, `--d-3` 420 ms; `--ease-enter`, `--ease-exit`, `--ease-move`, `--ease-stamp`
  (no overshoot).
- One authored sequence: the hero replays block 282559 (quote, stamp, answer, 137 vouchers filed by session, one
  manifest stamped). Pausable, stops off screen, rests on its last frame without JavaScript or with reduced motion.
- The sessions section follows the scroll: the chapter in the middle of the screen is active (number filled, frame
  lit, its diagram pulses), and the rail fills with a CSS scroll timeline where supported. Nothing is hidden at any time.
- Pages carry the header and the buy box across navigations with cross-document view transitions (Chromium).
- Only `transform`, `opacity` and `clip-path` animate.
