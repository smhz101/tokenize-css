# tokenize-css

A tiny CLI that **extracts design tokens from a plain CSS file** and (optionally) **rewrites your CSS** to use those tokens. It focuses on practical wins with zero build-time dependencies: no PostCSS, no AST, just fast regex-based parsing with careful guards.

It can generate tokens for:

- **Colors** (semantic roles + numbered palette) with an **auto dark theme**.
- **Spacing** (from margin/padding/gap usage).
- **Borders** (widths), **Radius**, **Shadows**.
- **Motion** (durations + easing).
- **Typography** (**font-family, font-size, line-height, font-weight, letter-spacing**).

It also supports **numeric unit conversion** (`px`, `rem`, `em`, `%`, `vh`, `vw`, `ch`) on the input **before analysis** so your tokens and rewrites reflect your preferred units.

---

## Table of Contents

- [Install](#install)
- [Quick Start](#quick-start)
- [CLI](#cli)
- [What It Generates](#what-it-generates)
- [Rewrite Mode](#rewrite-mode)
- [Unit Conversion](#unit-conversion)
- [Algorithms & Heuristics](#algorithms--heuristics)
- [Manifest JSON Schema](#manifest-json-schema)
- [Naming Strategy](#naming-strategy)
- [Examples](#examples)
- [Limitations](#limitations)
- [Tips](#tips)

---

## Install

Add the script to your project (e.g. `scripts/tokenize-css.js`) and make it executable:

```bash
chmod +x scripts/tokenize-css.js
```

Or run with node directly: _(Requires Node 16+)_

```bash
node scripts/tokenize-css.js input.css
```

---

## Quick Start

Generate tokens CSS only:

```bash
node tokenize-css.js app.css --out tokens.css
```

Generate tokens, rewrite CSS to use them, and output a manifest:

```bash
node tokenize-css.js app.css \
  --out tokens.css \
  --rewrite app-output.css \
  --manifest tokens.json \
  --features all
```

> Convert px > rem (16px root) before analyzing/rewrite:

```bash
node tokenize-css.js app.css \
  --convert "px>rem" --root-size 16 \
  --rewrite app-output.css
```

---

## CLI

```bash
node tokenize-css.js input.css
  [--out tokens.css]
  [--rewrite style.vars.css]
  [--manifest tokens.json]
  [--algorithm flip|invert|tone]
  [--features all|colors,spacing,borders,radius,shadows,motion,typography]
  [--prefix-space space]
  [--prefix-shadow shadow]
  [--prefix-duration duration]
  [--prefix-ease ease]
  [--prefix-font-family ff]
  [--prefix-font-size fs]
  [--prefix-line-height lh]
  [--prefix-letter-spacing ls]
  [--prefix-font-weight fw]
  [--convert "px>rem,vh>px,%>px"]
  [--root-size 16]
  [--context-size 16]
	[--viewport-width 100]
  [--viewport-height 100]
  [--percent-base 100]
  [--ch-width 1]
  [--convert-out converted.css]
  [--stable-names] # use content hashes instead of sequence numbers
```

---

#### Key flags

- `--out` — where to write the generated tokens CSS (default: `tokens.css`).
- `--rewrite` — writes a file containing the tokens block plus your CSS with `var(...)` replacements.
- `--manifest` — writes a JSON manifest of all token mappings.
- `--features` — subset of features (comma-separated) or all.
- `--algorithm` — dark-mode color algorithm:

  - `flip` (default): invert lightness in HSL, desaturates near-neutrals.
  - `invert`: simple RGB invert, clamped.
  - `tone`: darker tone with light desaturation (HSL-based OKLCH-like approximation).

- `--convert` — run numeric unit conversions first (supports `px`, `rem`, `em`, `%`, `vh`, `vw`, `ch`).
- `--root-size` — pixels per `1rem` (default 16).
- `--context-size` — fallback pixels per `1em` (default 16). A lightweight pre-scan picks up `font-size` on selectors to locally refine em context during conversion.
- `--viewport-width`/`--viewport-height` — pixels per `100vw`/`100vh` (default 100).
- `--percent-base` — pixels per `100%` when converting `%` (default 100).
- `--ch-width` — pixels per `1ch` (default 1).
- `--convert-out` — write the converted CSS to a file even when not rewriting.
- `--prefix-\*` — customize variable names.
- `--stable-names` — produce hash-based names that don’t shift when new tokens are discovered.

---

## What It Generates

Tokens CSS

Two blocks are emitted:

```css
:root {
	/* Colors */
	--color-fg: #111111;
	--color-bg: #ffffff;
	--color-primary: #3b82f6;
	/* ...semantic, then numbered --c01, --c02, ... */

	/* Typography — font families */
	--ff-1: 'Inter', system-ui, sans-serif;

	/* Typography — font sizes / line heights / weights / letter spacing */
	--fs-1: 1rem;
	--lh-1: 1.5;
	--fw-1: 600;
	--ls-1: 0.02em;

	/* Spacing */
	--space-1: 0.5rem;
	--space-2: 1rem;

	/* Borders / Radius */
	--border-width-1: 1px;
	--radius-1: 0.25rem;

	/* Shadows */
	--shadow-1: 0 1px 2px rgba(0, 0, 0, 0.1);

	/* Motion */
	--duration-1: 0.2s;
	--ease-1: ease-in-out;
}

:root[data-theme='dark'] {
	/* Colors (transformed by --algorithm) */
	--color-fg: #eeeeee;
	--color-bg: #0a0a0a;
	--color-primary: #7aa9ff;

	/* Typography / Shadows / Motion are usually identical */
	--ff-1: 'Inter', system-ui, sans-serif;
	--duration-1: 0.2s;
	--ease-1: ease-in-out;
	/* ... */
}
```

**Color roles**: `--color-fg`, `--color-bg`, `--color-primary`, `--color-secondary`, `--color-accent`, `--color-border`, `--color-surface-1`, `--color-surface-2`, `--color-outline`, `--color-muted`, `--color-disabled` + numbered `--c01`, `--c02`, …

**Typography**: `--ff-*`, `--fs-*`, `--lh-*` (unitless/length allowed), `--fw-*`, `--ls-*`.

---

## Rewrite Mode

When `--rewrite` is provided, your CSS is rewritten to use `var(...)`:

- Colors — literal > `var(--color-*)` or numbered tokens.
- Spacing — all `margin|padding|gap(+ variants)` lengths that match known tokens.
- Borders — `border/outline` widths that match tokens.
- Radius — `border-radius` values must match normalized forms (spacing and / spacing normalized).
- Shadows — exact-match (whitespace-normalized).
- Motion — `durations` and `easing in` transition/animation props.
- Typography
  - `font-family` longhand and font shorthand tail.
  - `font-size`, `line-height`, `font-weight`, `letter-spacing` longhands.
  - font shorthand: replaces weight, `<size>[/<line-height>]`, and the family tail when recognized.

> The rewriter avoids unsafe concatenations and invalid forms (e.g. it prevents `5var(--radius-1)%` and avoids emitting multiple tokens without separators like `var(--lh-3).var(--lh-5))`.

---

## Unit Conversion

Unit conversion runs before tokenization and rewrite so your tokens reflect the desired units.

- Supported conversions: `px`, `rem`, `em`, `%`, `vh`, `vw`, `ch`.
- Handles tokens inside `calc()`, `clamp()`, `min()`, `max()` recursively.
- Uses `--root-size` for `rem`.
- For `em`, a light pre-scan of `font-size` per selector acts as a local context; otherwise it falls back to `--context-size`.
- `--viewport-width`/`--viewport-height` provide the pixel bases for `100vw`/`100vh` (default 100).
- `--percent-base` sets pixels for `100%` (default 100); `--ch-width` sets pixels per `1ch` (default 1).

Examples:

```bash
# px > rem at 16px root
node tokenize-css.js app.css --convert "px>rem" --root-size 16 --out tokens.css

# chain conversions px>rem, rem>em
node tokenize-css.js app.css --convert "px>rem,rem>em" --context-size 16 --rewrite out.css

# convert vh > px using a 900px viewport height
node tokenize-css.js app.css --convert "vh>px" --viewport-height 900 --convert-out app.converted.css
```

---

## Algorithms & Heuristics

**Color roles**

- Detects all color literals (`#rgb[a]`, `rgb[a]()`, `hsl[a]()`).
- Scores usage frequency, luminance, saturation, and selectors (`body`, `links`, `buttons`, `hover`) to choose semantic roles.
- Remaining colors are assigned numbered tokens by frequency.

**Dark mode**

- `flip` (default): invert HSL lightness with neutral handling.
- `invert`: invert RGB with clamping.
- `tone`: darker, slightly desaturated tone (HSL-based approximation for an OKLCH transform).

**Typography**

- Counts longhands plus a lightweight `font` shorthand parser to pick up `font-size`, optional `line-height`, `font-weight`, and the `family` list tail.
- Families are normalized (comma spacing and inner whitespace) for stable matching.

**Spacing / Borders / Radius / Shadows / Motion**

- Frequency-first ordering, with numeric secondary ordering where applicable.
- Radius normalized to consistent spacing and slash handling `(a / b)`.

---

## Manifest JSON Schema

When `--manifest tokens.json` is provided:

```json
{
	"colors": {
		"semantic": { "--color-bg": "#ffffff", "...": "..." },
		"numbered": { "--c01": "#3b82f6", "...": "..." }
	},
	"typography": {
		"fontFamilies": { "--ff-1": "'Inter', system-ui, sans-serif" },
		"fontSizes": { "--fs-1": "1rem" },
		"lineHeights": { "--lh-1": "1.5" },
		"fontWeights": { "--fw-1": "600" },
		"letterSpacing": { "--ls-1": "0.02em" }
	},
	"spacing": { "--space-1": "0.5rem" },
	"borderWidths": { "--border-width-1": "1px" },
	"radii": { "--radius-1": "0.25rem" },
	"shadows": { "--shadow-1": "0 1px 2px rgba(0,0,0,.1)" },
	"motion": {
		"durations": { "--duration-1": "0.2s" },
		"easing": { "--ease-1": "ease-in-out" }
	},
	"meta": {
		"input": "app.css",
		"algorithm": "flip",
		"features": [
			"colors",
			"spacing",
			"borders",
			"radius",
			"shadows",
			"motion",
			"typography"
		]
	}
}
```

---

## Naming Strategy

- Default names are sequence-based (`--space-1`, `--fs-3`, …).
- Pass `--stable-names` to use content-hash names (MD5, 8 hex chars) such as `--space-a1b2c3d4`.
  _This keeps names stable even as new tokens are discovered later._
- Customize prefixes with --prefix-\* flags.

#### Examples

Extract only typography and colors, with stable names and a custom font family prefix:

```bash
node tokenize-css.js app.css \
  --features colors,typography \
  --prefix-font-family typeface \
  --stable-names \
  --out tokens.css --manifest tokens.json
```

Rewrite CSS while preserving tokens in `rem` (convert px>rem first):

```bash
node tokenize-css.js app.css \
  --convert "px>rem" --root-size 16 \
  --out tokens.css \
  --rewrite app.tokens.rewritten.css
```

Generate tokens with a different dark scheme:

```bash
node tokenize-css.js app.css \
  --algorithm tone \
  --out tokens.css
```

---

## Limitations

- Parser is regex-based for speed; it doesn’t build a full CSS AST.
- Radius/shadows replacements require normalized forms to match; this tool normalizes common whitespace forms but not every edge case.
- Only `px`, `rem`, `em`, `%`, `vh`, `vw`, `ch` are converted numerically; other units pass through.
- `font` shorthand parsing is intentionally conservative—exotic shorthands may not be fully recognized.
- Token rewrite is literal-based; if a value is computed by custom properties or complex functions, a direct match may not be possible.

---

## Tips

- Start with **conversion only** to see what your CSS looks like in `rem/em`:

```bash
node tokenize-css.js app.css --convert "px>rem" --convert-out app.converted.css
```

- Use `--stable-names` once you’re ready to commit token names to your design system.

- Prefer unitless `line-height` in your CSS to get cleaner tokens.

- If a border-radius value didn’t rewrite, check its exact form; tokenization prefers exact normalized matches (e.g., `6px` vs `6px 6px 6px 6px` are different literals).

- Keep your font-family lists consistent (quote names with spaces, consistent generic family endings) for the best matching.

---

> ### Enjoy your freshly tokenized CSS!
>
> If you hit a case that doesn’t rewrite cleanly, open an issue with a small before/after snippet and I’ll suggest a safe pattern for it.
