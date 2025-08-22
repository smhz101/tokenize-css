#!/usr/bin/env node
/* tokenize-css.js
   ---------------------------------------------------------------
   Generates rich tokens from an input CSS:
     • Colors (semantic + numbered) + dark scheme
     • Spacing scale (from margin/padding/gap)
     • Border widths
     • Border radii
     • Shadows
     • Motion (durations, easing)
   Optionally:
     • Converts units numerically (px↔rem↔em) BEFORE analysis/rewrite
     • Rewrites CSS to use the generated tokens
     • Emits a JSON manifest

   Usage:
     node tokenize-css.js input.css
       [--out tokens.css]
       [--rewrite style.vars.css]
       [--manifest tokens.json]
       [--algorithm flip|invert]
       [--features all|colors,spacing,borders,radius,shadows,motion,typography]
       [--prefix-space space]
       [--prefix-shadow shadow]
       [--prefix-duration duration]
       [--prefix-ease ease]
       [--convert "px>rem,em>px,rem>em"]     // numeric unit conversion pairs (comma-sep)
       [--root-size 16]                      // 1rem = <root-size> px (default 16)
       [--context-size 16]                   // 1em  = <context-size> px (global fallback)
       [--convert-out converted.css]         // write CSS after conversion (useful without --rewrite)
       [--prefix-font-size fs]
       [--prefix-line-height lh]
       [--prefix-letter-spacing ls]
       [--prefix-font-weight fw]
       [--prefix-font-family ff]
   Notes:
     • Unit conversion runs FIRST on the loaded CSS, so tokens & rewrites reflect converted values.
     • Supported convertible units: px, rem, em (others are left untouched).
     • `--context-size` is a single global fallback for `em` (no per-selector cascade resolution).
     • If `--convert-out` is provided and `--rewrite` is omitted, the converted CSS is saved to that file.

   Examples:
     # Convert px→rem at 16px root, produce tokens, rewrite, and manifest
     node tokenize-css.js app.css \
       --convert "px>rem" --root-size 16 \
       --out tokens.css --rewrite style.vars.css --manifest tokens.json

     # Convert rem→px with an 18px root and ONLY output converted CSS
     node tokenize-css.js app.css \
       --convert "rem>px" --root-size 18 \
       --convert-out app.converted.css

     # Chain conversions px→rem then rem→em using a 16px context for em
     node tokenize-css.js app.css \
       --convert "px>rem,rem>em" --root-size 16 --context-size 16 \
       --rewrite style.vars.css
*/

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ---------------------------------------------------------------
   CORE CONSTANTS / REGEX (declared first to avoid TDZ issues)
---------------------------------------------------------------- */
const COLOR_RE =
  /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|rgba?\(\s*[^)]+\)|hsla?\(\s*[^)]+\)/g;
const RULE_RE = /([^{}]+)\{([^}]*)\}/g; // selector { decls }
const PROP_RE = /([-\w]+)\s*:\s*([^;]+);/g; // name: value;
const LENGTH_TOKEN_RE = /-?\d*\.?\d+(?:px|rem|em|%|vh|vw)\b/g;
const lenPropsRE = /^(margin|padding|gap|column-gap|row-gap)(|-(top|right|bottom|left))$/;
const radiusPropRE = /^border-radius$/;
const shadowPropRE = /^box-shadow$/;
const motionPropRE =
  /^(transition|transition-duration|transition-timing-function|animation|animation-duration|animation-timing-function)$/;

// Handle typography
const fontShorthandRE = /^font$/;
const fontFamilyPropRE = /^font-family$/;
const fontSizePropRE = /^font-size$/;
const lineHeightPropRE = /^line-height$/;
const fontWeightPropRE = /^font-weight$/;
const letterSpacingPropRE = /^letter-spacing$/;

/* ---------------------------------------------------------------
   CLI
---------------------------------------------------------------- */
const args = process.argv.slice(2);
if (!args[0]) {
  console.error(
    'Usage: node tokenize-css.js input.css ' +
      '[--out tokens.css] [--rewrite out.css] [--manifest tokens.json] ' +
      '[--algorithm flip|invert|tone] ' +
      '[--features all|colors,spacing,borders,radius,shadows,motion,typography] ' +
      '[--prefix-space space] [--prefix-shadow shadow] ' +
      '[--prefix-duration duration] [--prefix-ease ease] ' +
      '[--prefix-font-family ff] [--prefix-font-size fs] ' +
      '[--prefix-line-height lh] [--prefix-letter-spacing ls] [--prefix-font-weight fw] ' +
      '[--convert "px>rem,em>px,rem>em"] [--root-size 16] [--context-size 16] ' +
      '[--convert-out converted.css]'
  );
  process.exit(1);
}
const inFile = args[0];
const outFile = flag('--out', 'tokens.css');
const rewriteFile = flag('--rewrite', null);
const manifestFile = flag('--manifest', null);
const algorithm = flag('--algorithm', 'flip'); // flip|invert|tone
const featuresArg = flag('--features', 'all');
const features =
  featuresArg === 'all'
    ? ['colors', 'spacing', 'borders', 'radius', 'shadows', 'motion', 'typography']
    : featuresArg.split(',').map((s) => s.trim().toLowerCase());

const PREFIX_SPACE = flag('--prefix-space', 'space');
const PREFIX_SHADOW = flag('--prefix-shadow', 'shadow');
const PREFIX_DURATION = flag('--prefix-duration', 'duration');
const PREFIX_EASE = flag('--prefix-ease', 'ease');

// --- Unit conversion flags ---
const convertSpec = flag('--convert', null); // e.g. "px>rem,em>px"
const convertOut = flag('--convert-out', null); // optional explicit output when only converting
const ROOT_SIZE = parseFloat(flag('--root-size', '16')); // px per 1rem
const CONTEXT_SIZE = parseFloat(flag('--context-size', '16')); // px per 1em (global fallback)

const PREFIX_FF = flag('--prefix-font-family', 'ff');
const PREFIX_FS = flag('--prefix-font-size', 'fs'); // --fs-1, --fs-2, ...
const PREFIX_LH = flag('--prefix-line-height', 'lh'); // --lh-1, ...
const PREFIX_LS = flag('--prefix-letter-spacing', 'ls'); // --ls-1, ...
const PREFIX_FW = flag('--prefix-font-weight', 'fw'); // --fw-1, ...

/** stable name generator (index or hash), guarded against collisions */
const STABLE = flag('--stable-names', null) != null; // pass --stable-names to enable

function litHash(lit, prefix) {
  const h = crypto.createHash('md5').update(String(lit)).digest('hex').slice(0, 8);
  return `--${prefix}-${h}`;
}
function makeNameFactory(prefix) {
  const used = new Set();
  return (lit, i) => {
    const name = STABLE ? litHash(lit, prefix) : `--${prefix}-${i + 1}`;
    // guard (very unlikely): ensure no duplicates
    let out = name,
      n = 2;
    while (used.has(out)) out = `${name}-${n++}`;
    used.add(out);
    return out;
  };
}

function flag(name, def) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : def;
}

/* ---------------------------------------------------------------
   READ (+ optional unit conversion) > PARSE (selectors/props)
---------------------------------------------------------------- */
// 1) read
let css = fs.readFileSync(inFile, 'utf8');

// 2) optional unit conversion (px<>rem<>em) before analysis
const convertPairs = parseConvert(convertSpec);
if (convertPairs.length) {
  css = convertCssUnits(css, convertPairs, { rootPx: ROOT_SIZE, contextPx: CONTEXT_SIZE });
  if (convertOut && !rewriteFile) {
    fs.writeFileSync(convertOut, css, 'utf8');
    console.log(`Converted CSS > ${path.relative(process.cwd(), convertOut)}`);
  }
}

// 3) lightweight parse into entries
const entries = []; // { selector, prop, value }
let m;
while ((m = RULE_RE.exec(css))) {
  const selector = m[1].trim();
  const decls = m[2];
  let p;
  while ((p = PROP_RE.exec(decls))) {
    entries.push({
      selector,
      prop: p[1].trim().toLowerCase(),
      value: p[2].trim(),
    });
  }
}

/* ---------------------------------------------------------------
   COLLECT CANDIDATES
---------------------------------------------------------------- */
const byColor = new Map(); // color literal > {count, props, selectors, rgba, hsl, lum, sat}
const byLength = new Map(); // spacing literal > {count, props}
const byBorderWidth = new Map(); // width literal > {count}
const byRadius = new Map(); // radius string > {count}
const byShadow = new Map(); // full box-shadow > {count}
const byDuration = new Map(); // '200ms'/'0.2s' > {count, ms}
const byEase = new Map(); // easing function > {count}
const byFontSize = new Map(); // literal -> {count}
const byLineHeight = new Map(); // literal -> {count}
const byFontWeight = new Map(); // literal -> {count}
const byLetterSpacing = new Map(); // literal -> {count}
const byFontFamily = new Map(); // literal -> {count}

for (const e of entries) {
  // colors
  const colors = e.value.match(COLOR_RE) || [];
  for (const c of colors) {
    const key = c.trim();
    if (!byColor.has(key))
      byColor.set(key, {
        count: 0,
        props: new Map(),
        selectors: [],
        rgba: null,
        hsl: null,
        lum: 0,
        sat: 0,
      });
    const node = byColor.get(key);
    node.count++;
    node.props.set(e.prop, (node.props.get(e.prop) || 0) + 1);
    node.selectors.push(e.selector);
  }

  // font shorthand first (so counts include it even if longhands appear elsewhere)
  if (fontShorthandRE.test(e.prop)) {
    const parts = parseFontShorthand(e.value);
    if (parts.fs) {
      byFontSize.set(parts.fs, { count: (byFontSize.get(parts.fs)?.count || 0) + 1 });
    }
    if (parts.lh) {
      byLineHeight.set(parts.lh, { count: (byLineHeight.get(parts.lh)?.count || 0) + 1 });
    }
    if (parts.fw) {
      byFontWeight.set(parts.fw, { count: (byFontWeight.get(parts.fw)?.count || 0) + 1 });
    }
  }

  // typography
  if (fontFamilyPropRE.test(e.prop)) {
    const lit = normalizeFontFamilyList(e.value);
    if (!isCssWideKeyword(lit)) {
      byFontFamily.set(lit, { count: (byFontFamily.get(lit)?.count || 0) + 1 });
    }
  }

  // also consume family from font shorthand
  if (fontShorthandRE.test(e.prop)) {
    const sh = parseFontShorthandWithFamily(e.value);
    if (sh.family) {
      const fam = normalizeFontFamilyList(sh.family);
      if (!isCssWideKeyword(fam)) {
        byFontFamily.set(fam, { count: (byFontFamily.get(fam)?.count || 0) + 1 });
      }
    }
  }

  if (fontSizePropRE.test(e.prop)) {
    const lit = e.value.trim();
    if (!byFontSize.has(lit)) byFontSize.set(lit, { count: 0 });
    byFontSize.get(lit).count++;
  }
  if (lineHeightPropRE.test(e.prop)) {
    const lit = e.value.trim();
    if (!byLineHeight.has(lit)) byLineHeight.set(lit, { count: 0 });
    byLineHeight.get(lit).count++;
  }
  if (fontWeightPropRE.test(e.prop)) {
    const lit = e.value.trim();
    if (!byFontWeight.has(lit)) byFontWeight.set(lit, { count: 0 });
    byFontWeight.get(lit).count++;
  }
  if (letterSpacingPropRE.test(e.prop)) {
    const lit = e.value.trim();
    if (!byLetterSpacing.has(lit)) byLetterSpacing.set(lit, { count: 0 });
    byLetterSpacing.get(lit).count++;
  }

  // spacing
  if (lenPropsRE.test(e.prop)) {
    extractLengths(e.value).forEach((len) => {
      if (!byLength.has(len)) byLength.set(len, { count: 0, props: new Map() });
      const node = byLength.get(len);
      node.count++;
      node.props.set(e.prop, (node.props.get(e.prop) || 0) + 1);
    });
  }

  // border widths (from border/outline shorthands)
  if (/^border/.test(e.prop) || /^outline/.test(e.prop)) {
    const width = extractBorderWidth(e.value);
    if (width) {
      if (!byBorderWidth.has(width)) byBorderWidth.set(width, { count: 0 });
      byBorderWidth.get(width).count++;
    }
  }

  // radius
  if (radiusPropRE.test(e.prop)) {
    const lit = normalizeRadius(e.value);
    if (!byRadius.has(lit)) byRadius.set(lit, { count: 0 });
    byRadius.get(lit).count++;
  }

  // shadows
  if (shadowPropRE.test(e.prop)) {
    const cleaned = e.value.replace(/\s+/g, ' ').trim();
    if (!byShadow.has(cleaned)) byShadow.set(cleaned, { count: 0 });
    byShadow.get(cleaned).count++;
  }

  // motion
  if (motionPropRE.test(e.prop)) {
    extractDurations(e.value).forEach((d) => {
      if (!byDuration.has(d.str)) byDuration.set(d.str, { count: 0, ms: d.ms });
      byDuration.get(d.str).count++;
    });
    extractEasings(e.value).forEach((fn) => {
      if (!byEase.has(fn)) byEase.set(fn, { count: 0 });
      byEase.get(fn).count++;
    });
  }
}

/* ---------------------------------------------------------------
   COLOR SEMANTICS
---------------------------------------------------------------- */
const palette = [...byColor.keys()];
for (const k of palette) {
  const n = byColor.get(k);
  n.rgba = toRgba(k);
  const hsl = rgbaToHsl(n.rgba);
  n.hsl = hsl;
  n.sat = hsl.s;
  n.lum = relLuminance(n.rgba);
}

const roles = {};
const used = new Set();
const isGrayish = (c) => byColor.get(c).sat <= 0.1;
const isSaturated = (c) => byColor.get(c).sat >= 0.22;
const lum = (c) => byColor.get(c).lum;
const count = (c) => byColor.get(c).count;
const usedInProp = (c, name) => byColor.get(c).props.has(name);
const usedInSelector = (c, re) => byColor.get(c).selectors.some((s) => re.test(s));
const distinct = (a, b) => (a && b ? hslDist(byColor.get(a).hsl, byColor.get(b).hsl) > 0.18 : true);

roles['--color-fg'] =
  pickBest(
    palette.filter((c) => isGrayish(c)),
    (c) => {
      let s = 0;
      s += (1 - lum(c)) * 2.0;
      s += Math.log1p(count(c)) * 0.4;
      if (usedInProp(c, 'color')) s += 1.0;
      if (usedInSelector(c, /\bbody\b/)) s += 2.0;
      return s;
    }
  ) || pickBest(palette, (c) => 1 - lum(c) + Math.log1p(count(c)) * 0.3);

roles['--color-bg'] = pickBest(
  palette,
  (c) => {
    let s = 0;
    s += lum(c) * 2.0;
    s += Math.log1p(count(c)) * 0.3;
    if (usedInProp(c, 'background') || usedInProp(c, 'background-color')) s += 0.7;
    if (usedInSelector(c, /\bbody\b/)) s += 2.0;
    return s;
  },
  used
);

roles['--color-primary'] = pickBest(
  palette.filter((c) => isSaturated(c)),
  (c) => {
    let s = 0;
    s += byColor.get(c).sat * 2.0;
    s += Math.log1p(count(c)) * 0.4;
    if (usedInSelector(c, /\ba\b|button|\.button|:hover/i)) s += 1.5;
    if (
      usedInProp(c, 'color') ||
      usedInProp(c, 'background') ||
      usedInProp(c, 'border') ||
      usedInProp(c, 'border-color')
    )
      s += 0.7;
    const L = lum(c);
    s += L > 0.2 && L < 0.9 ? 0.3 : -0.2;
    return s;
  },
  used
);

roles['--color-secondary'] = pickBest(
  palette.filter((c) => isSaturated(c) && distinct(c, roles['--color-primary'])),
  (c) => byColor.get(c).sat + Math.log1p(count(c)) * 0.3,
  used
);

roles['--color-accent'] = pickBest(
  palette.filter(
    (c) =>
      isSaturated(c) &&
      distinct(c, roles['--color-primary']) &&
      distinct(c, roles['--color-secondary'])
  ),
  (c) => byColor.get(c).sat + Math.log1p(count(c)) * 0.25,
  used
);

roles['--color-border'] = pickBest(
  palette.filter((c) => isGrayish(c)),
  (c) => {
    let s = 0;
    s += (1 - Math.abs(lum(c) - 0.88)) * 1.5;
    if (usedInProp(c, 'border') || usedInProp(c, 'border-color')) s += 1.0;
    s += Math.log1p(count(c)) * 0.2;
    return s;
  },
  used
);

roles['--color-surface-1'] = pickBest(
  palette.filter((c) => isGrayish(c)),
  (c) => {
    let s = 0;
    s += (1 - Math.abs(lum(c) - 0.96)) * 1.4;
    if (usedInProp(c, 'background') || usedInProp(c, 'background-color')) s += 0.6;
    s += Math.log1p(count(c)) * 0.2;
    return s;
  },
  used
);

roles['--color-surface-2'] = pickBest(
  palette.filter((c) => isGrayish(c)),
  (c) => {
    let s = 0;
    s += (1 - Math.abs(lum(c) - 0.9)) * 1.2;
    if (usedInProp(c, 'background') || usedInProp(c, 'background-color')) s += 0.5;
    s += Math.log1p(count(c)) * 0.2;
    return s;
  },
  used
);

roles['--color-outline'] =
  pickBest(
    palette,
    (c) => {
      let s = 0;
      if (usedInProp(c, 'outline')) s += 2.0;
      if (usedInSelector(c, /focus|:focus|skip-link|screen-reader/)) s += 1.0;
      s += isGrayish(c) ? 0.3 : 0;
      s -= Math.abs(lum(c) - 0.75);
      return s;
    },
    used
  ) || roles['--color-border'];

roles['--color-muted'] = pickBest(
  palette.filter((c) => isGrayish(c)),
  (c) => {
    const L = lum(c);
    return 1 - Math.abs(L - 0.5) + Math.log1p(count(c)) * 0.1;
  },
  used
);

roles['--color-disabled'] =
  pickBest(
    palette.filter((c) => isGrayish(c)),
    (c) => {
      let s = 0;
      const L = lum(c);
      if (usedInSelector(c, /disabled/)) s += 1.5;
      s += 1 - Math.abs(L - 0.6);
      return s;
    },
    used
  ) || roles['--color-muted'];

/* Remaining colors > numbered vars */
const semanticMap = new Map(); // color > var
for (const [varName, colorLit] of Object.entries(roles)) {
  if (colorLit) semanticMap.set(colorLit, varName);
}
const remainingColors = palette
  .filter((c) => !semanticMap.has(c))
  .sort((a, b) => byColor.get(b).count - byColor.get(a).count || a.localeCompare(b));
const numericColorMap = new Map();
remainingColors.forEach((c, i) => numericColorMap.set(c, `--c${String(i + 1).padStart(2, '0')}`));
const colorToVar = new Map([...semanticMap.entries(), ...numericColorMap.entries()]); // color > variable

/* ---------------------------------------------------------------
   FONT / SPACING / BORDERS / RADII / SHADOWS / MOTION
---------------------------------------------------------------- */

// Fonts
let ffOrder = [],
  ffMap = new Map(),
  fsOrder = [],
  fsMap = new Map(),
  lhOrder = [],
  lhMap = new Map(),
  fwOrder = [],
  fwMap = new Map(),
  lsOrder = [],
  lsMap = new Map();

if (features.includes('typography')) {
  const nameFF = makeNameFactory(PREFIX_FF);
  const nameFS = makeNameFactory(PREFIX_FS);
  const nameLH = makeNameFactory(PREFIX_LH);
  const nameFW = makeNameFactory(PREFIX_FW);
  const nameLS = makeNameFactory(PREFIX_LS);

  ffOrder = [...byFontFamily.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([k]) => k);
  ffMap = new Map(ffOrder.map((v, i) => [v, nameFF(v, i)]));

  fsOrder = [...byFontSize.entries()]
    .sort((a, b) => b[1].count - a[1].count || lenToPxSafe(b[0]) - lenToPxSafe(a[0]))
    .map(([k]) => k);
  fsMap = new Map(fsOrder.map((v, i) => [v, nameFS(v, i)]));

  lhOrder = [...byLineHeight.entries()]
    .sort((a, b) => b[1].count - a[1].count || lineHeightToFloat(b[0]) - lineHeightToFloat(a[0]))
    .map(([k]) => k);
  lhMap = new Map(lhOrder.map((v, i) => [v, nameLH(v, i)]));

  fwOrder = [...byFontWeight.entries()]
    .sort((a, b) => b[1].count - a[1].count || fontWeightToNum(b[0]) - fontWeightToNum(a[0]))
    .map(([k]) => k);
  fwMap = new Map(fwOrder.map((v, i) => [v, nameFW(v, i)]));

  lsOrder = [...byLetterSpacing.entries()]
    .sort((a, b) => b[1].count - a[1].count || lenToPxSafe(b[0]) - lenToPxSafe(a[0]))
    .map(([k]) => k);
  lsMap = new Map(lsOrder.map((v, i) => [v, nameLS(v, i)]));
}

// Spacing
let spacingOrder = [],
  spacingMap = new Map();
if (features.includes('spacing')) {
  const name = makeNameFactory(PREFIX_SPACE);
  spacingOrder = [...byLength.entries()]
    .sort((a, b) => b[1].count - a[1].count || lenToPx(b[0]) - lenToPx(a[0]))
    .map(([k]) => k);
  spacingMap = new Map(spacingOrder.map((lit, i) => [lit, name(lit, i)]));
}

// Borders
let borderWidthOrder = [],
  borderWidthMap = new Map();
if (features.includes('borders')) {
  const name = makeNameFactory('border-width');
  borderWidthOrder = [...byBorderWidth.entries()]
    .sort((a, b) => b[1].count - a[1].count || lenToPx(a[0]) - lenToPx(b[0]))
    .map(([k]) => k);
  borderWidthMap = new Map(borderWidthOrder.map((w, i) => [w, name(w, i)]));
}

// Radius
let radiusOrder = [],
  radiusMap = new Map();
if (features.includes('radius')) {
  const name = makeNameFactory('radius');
  radiusOrder = [...byRadius.entries()]
    .sort((a, b) => b[1].count - a[1].count || lenToPx(a[0]) - lenToPx(b[0]))
    .map(([k]) => k);
  radiusMap = new Map(radiusOrder.map((r, i) => [r, name(r, i)]));
}

// Shadows
let shadowOrder = [],
  shadowMap = new Map();
if (features.includes('shadows')) {
  const name = makeNameFactory(PREFIX_SHADOW);
  shadowOrder = [...byShadow.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([k]) => k);
  shadowMap = new Map(shadowOrder.map((s, i) => [s, name(s, i)]));
}

// Motion
let durOrder = [],
  durationMap = new Map();
let easeOrder = [],
  easeMap = new Map();
if (features.includes('motion')) {
  const nameDur = makeNameFactory(PREFIX_DURATION);
  const nameEase = makeNameFactory(PREFIX_EASE);
  durOrder = [...byDuration.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].ms - b[1].ms)
    .map(([k]) => k);
  durationMap = new Map(durOrder.map((d, i) => [d, nameDur(d, i)]));
  easeOrder = [...byEase.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([k]) => k);
  easeMap = new Map(easeOrder.map((e, i) => [e, nameEase(e, i)]));
}

/* ---------------------------------------------------------------
   EMIT TOKENS (:root + [data-theme="dark"])
---------------------------------------------------------------- */
const linesRoot = [];
const linesDark = [];

if (features.includes('colors')) {
  const orderedColorVars = [
    ...Object.keys(roles).filter((k) => roles[k]),
    ...remainingColors.map((c) => numericColorMap.get(c)),
  ];
  linesRoot.push('  /* Colors */');
  linesDark.push('  /* Colors */');
  for (const v of orderedColorVars) {
    const color = varToColor(v) || '#000';
    const rgba = toRgba(color);
    const baseOut = rgbaToCss(rgba);
    const darkOut = rgbaToCss(toDark(rgba, algorithm));
    linesRoot.push(`  ${v}: ${baseOut};`);
    linesDark.push(`  ${v}: ${darkOut};`);
  }
}

if (features.includes('typography')) {
  if (ffOrder.length) {
    linesRoot.push('\n  /* Typography — font families */');
    ffOrder.forEach((v) => linesRoot.push(`  ${ffMap.get(v)}: ${v};`));
    // linesDark.push('\n  /* Typography (same as light) */');
    // ffOrder.forEach((v) => linesDark.push(`  ${ffMap.get(v)}: ${v};`));
  }
  if (fsOrder.length) {
    linesRoot.push('\n  /* Typography — font sizes */');
    fsOrder.forEach((v) => linesRoot.push(`  ${fsMap.get(v)}: ${v};`));
  }
  if (lhOrder.length) {
    linesRoot.push('\n  /* Typography — line heights */');
    lhOrder.forEach((v) => linesRoot.push(`  ${lhMap.get(v)}: ${v};`)); // keeps unitless/length/keyword
  }
  if (fwOrder.length) {
    linesRoot.push('\n  /* Typography — font weights */');
    fwOrder.forEach((v) => linesRoot.push(`  ${fwMap.get(v)}: ${v};`));
  }
  if (lsOrder.length) {
    linesRoot.push('\n  /* Typography — letter spacing */');
    lsOrder.forEach((v) => linesRoot.push(`  ${lsMap.get(v)}: ${v};`));
  }

  // dark theme: typography values usually identical
  if (fsOrder.length || lhOrder.length || fwOrder.length || lsOrder.length) {
    linesDark.push('\n  /* Typography (same as light) */');
    fsOrder.forEach((v) => linesDark.push(`  ${fsMap.get(v)}: ${v};`));
    lhOrder.forEach((v) => linesDark.push(`  ${lhMap.get(v)}: ${v};`));
    fwOrder.forEach((v) => linesDark.push(`  ${fwMap.get(v)}: ${v};`));
    lsOrder.forEach((v) => linesDark.push(`  ${lsMap.get(v)}: ${v};`));
  }
}

if (features.includes('spacing') && spacingOrder.length) {
  linesRoot.push('\n  /* Spacing (by frequency) */');
  spacingOrder.forEach((lit) => linesRoot.push(`  ${spacingMap.get(lit)}: ${preferRem(lit)};`));
}

if (features.includes('borders') && borderWidthOrder.length) {
  linesRoot.push('\n  /* Border widths */');
  borderWidthOrder.forEach((w) => linesRoot.push(`  ${borderWidthMap.get(w)}: ${w};`));
}

if (features.includes('radius') && radiusOrder.length) {
  linesRoot.push('\n  /* Radii */');
  radiusOrder.forEach((r) => linesRoot.push(`  ${radiusMap.get(r)}: ${r};`));
}

if (features.includes('shadows') && shadowOrder.length) {
  linesRoot.push('\n  /* Shadows */');
  shadowOrder.forEach((s) => linesRoot.push(`  ${shadowMap.get(s)}: ${s};`));
  linesDark.push('\n  /* Shadows (same as light; adjust if needed) */');
  shadowOrder.forEach((s) => linesDark.push(`  ${shadowMap.get(s)}: ${s};`));
}

if (features.includes('motion') && (durOrder.length || easeOrder.length)) {
  if (durOrder.length) {
    linesRoot.push('\n  /* Durations */');
    durOrder.forEach((d) => linesRoot.push(`  ${durationMap.get(d)}: ${normalizeDuration(d)};`));
    linesDark.push('\n  /* Durations */');
    durOrder.forEach((d) => linesDark.push(`  ${durationMap.get(d)}: ${normalizeDuration(d)};`));
  }
  if (easeOrder.length) {
    linesRoot.push('\n  /* Easing */');
    easeOrder.forEach((e) => linesRoot.push(`  ${easeMap.get(e)}: ${e};`));
    linesDark.push('\n  /* Easing */');
    easeOrder.forEach((e) => linesDark.push(`  ${easeMap.get(e)}: ${e};`));
  }
}

const tokensCss =
  `:root{\n${linesRoot.join('\n')}\n}\n\n` +
  `:root[data-theme="dark"]{\n${linesDark.join('\n')}\n}\n`;

fs.writeFileSync(outFile, tokensCss, 'utf8');

/* ---------------------------------------------------------------
   OPTIONAL: REWRITE CSS WITH var(...)
---------------------------------------------------------------- */
if (rewriteFile) {
  let rewritten = css;

  // Colors
  if (features.includes('colors')) {
    const lits = [...colorToVar.keys()].sort((a, b) => b.length - a.length);
    for (const lit of lits) rewritten = replaceAll(rewritten, lit, `var(${colorToVar.get(lit)})`);
  }

  // Typography
  if (features.includes('typography')) {
    rewritten = rewriteByProp(rewritten, (prop, val) => {
      if (!fontFamilyPropRE.test(prop)) return val;
      const lit = normalizeFontFamilyList(val);
      const vname = ffMap.get(lit);
      return vname ? `var(${vname})` : val;
    });

    // font-size
    rewritten = rewriteByProp(rewritten, (prop, val) => {
      if (!fontSizePropRE.test(prop)) return val;
      return safeReplaceMap(val, fsMap);
    });
    // line-height
    rewritten = rewriteByProp(rewritten, (prop, val) => {
      if (!lineHeightPropRE.test(prop)) return val;
      return safeReplaceMap(val, lhMap);
    });
    // font-weight
    rewritten = rewriteByProp(rewritten, (prop, val) => {
      if (!fontWeightPropRE.test(prop)) return val;
      return safeReplaceMap(val, fwMap);
    });
    // letter-spacing
    rewritten = rewriteByProp(rewritten, (prop, val) => {
      if (!letterSpacingPropRE.test(prop)) return val;
      return safeReplaceMap(val, lsMap);
    });

    // shorthand: font: [style] [variant] [weight] <size>[/<line-height>] <family...>
    rewritten = rewriteByProp(rewritten, (prop, val) => {
      if (!/^font$/.test(prop)) return val;

      // 1) weight (bold/400/etc)
      for (const [lit, vname] of fwMap) {
        val = val.replace(new RegExp(`\\b${escRE(lit)}\\b`, 'i'), `var(${vname})`);
      }

      // 2) size + optional /line-height
      for (const [sizeLit, sizeVar] of fsMap) {
        const re = new RegExp(`(^|\\s)(${escRE(sizeLit)})(\\s*/\\s*([^\\s/;]+))?`, 'i');
        val = val.replace(re, (_, pre, _sz, slashPart, lhLit) => {
          let out = `${pre}var(${sizeVar})`;
          if (slashPart && lhLit) {
            const lhVar = lhMap.get(lhLit);
            out += lhVar ? ` / var(${lhVar})` : ` / ${lhLit}`;
          }
          return out;
        });
      }

      // 3) family tail
      const m = /(-?\d*\.?\d+(?:px|rem|em|%))(?:\s*\/\s*([^\s/;]+))?(.*)$/i.exec(val);
      if (m) {
        const head = val.slice(0, m.index + m[0].length - m[3].length);
        const familyTail = normalizeFontFamilyList(m[3].trim());
        const ffVar = ffMap.get(familyTail);
        if (ffVar) return `${head}var(${ffVar})`;
      }
      return val;
    });
  }

  // Spacing
  if (features.includes('spacing')) {
    rewritten = rewriteByProp(rewritten, (prop, val) => {
      if (!lenPropsRE.test(prop)) return val;
      for (const [lit, vname] of spacingMap) val = replaceAll(val, lit, `var(${vname})`);
      return val;
    });
  }

  // Border widths
  if (features.includes('borders')) {
    rewritten = rewriteByProp(rewritten, (prop, val) => {
      if (!/^border/.test(prop) && !/^outline/.test(prop)) return val;
      for (const [lit, vname] of borderWidthMap) val = replaceAll(val, lit, `var(${vname})`);
      return val;
    });
  }

  // Radius
  if (features.includes('radius')) {
    rewritten = rewriteByProp(rewritten, (prop, val) => {
      if (!radiusPropRE.test(prop)) return val;
      const lit = normalizeRadius(val);
      const vname = radiusMap.get(lit);
      return vname ? `var(${vname})` : val;
    });
  }

  // Shadows
  if (features.includes('shadows')) {
    rewritten = rewriteByProp(rewritten, (prop, val) => {
      if (!shadowPropRE.test(prop)) return val;
      const lit = val.replace(/\s+/g, ' ').trim();
      const vname = shadowMap.get(lit);
      return vname ? `var(${vname})` : val;
    });
  }

  // Motion
  if (features.includes('motion')) {
    rewritten = rewriteByProp(rewritten, (prop, val) => {
      if (!motionPropRE.test(prop)) return val;
      for (const [lit, vname] of durationMap) val = replaceAll(val, lit, `var(${vname})`);
      for (const [lit, vname] of easeMap) val = replaceAll(val, lit, `var(${vname})`);
      return val;
    });
  }

  const finalCss = `/* Generated tokens */\n${tokensCss}\n/* Original CSS with replacements */\n${rewritten}`;
  fs.writeFileSync(rewriteFile, finalCss, 'utf8');
}

/* ---------------------------------------------------------------
   OPTIONAL: MANIFEST JSON
---------------------------------------------------------------- */
if (manifestFile) {
  const manifest = {
    colors: {
      semantic: Object.fromEntries([...semanticMap.entries()].map(([lit, v]) => [v, lit])),
      numbered: Object.fromEntries([...numericColorMap.entries()].map(([lit, v]) => [v, lit])),
    },
    typography: features.includes('typography')
      ? {
          fontFamilies: Object.fromEntries([...ffMap.entries()].map(([lit, v]) => [v, lit])),
          fontSizes: Object.fromEntries([...fsMap.entries()].map(([lit, v]) => [v, lit])),
          lineHeights: Object.fromEntries([...lhMap.entries()].map(([lit, v]) => [v, lit])),
          fontWeights: Object.fromEntries([...fwMap.entries()].map(([lit, v]) => [v, lit])),
          letterSpacing: Object.fromEntries([...lsMap.entries()].map(([lit, v]) => [v, lit])),
        }
      : {},
    spacing: features.includes('spacing')
      ? Object.fromEntries([...spacingMap.entries()].map(([lit, v]) => [v, lit]))
      : {},
    borderWidths: features.includes('borders')
      ? Object.fromEntries([...borderWidthMap.entries()].map(([lit, v]) => [v, lit]))
      : {},
    radii: features.includes('radius')
      ? Object.fromEntries([...radiusMap.entries()].map(([lit, v]) => [v, lit]))
      : {},
    shadows: features.includes('shadows')
      ? Object.fromEntries([...shadowMap.entries()].map(([lit, v]) => [v, lit]))
      : {},
    motion: features.includes('motion')
      ? {
          durations: Object.fromEntries(
            [...durationMap.entries()].map(([lit, v]) => [v, normalizeDuration(lit)])
          ),
          easing: Object.fromEntries([...easeMap.entries()].map(([lit, v]) => [v, lit])),
        }
      : {},
    meta: { input: path.basename(inFile), algorithm, features },
  };
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2), 'utf8');
}

/* ---------------------------------------------------------------
   LOGS
---------------------------------------------------------------- */
console.log(`Tokens > ${path.relative(process.cwd(), outFile)}`);
if (rewriteFile) console.log(`Rewritten CSS > ${path.relative(process.cwd(), rewriteFile)}`);
if (manifestFile) console.log(`Manifest > ${path.relative(process.cwd(), manifestFile)}`);

/* ===============================================================
   HELPERS
=============================================================== */
function replaceAll(hay, needle, replacement) {
  const safe = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return hay.replace(new RegExp(safe, 'g'), replacement);
}
function rewriteByProp(source, transform) {
  return source.replace(RULE_RE, (full, sel, decls) => {
    const newDecls = decls.replace(PROP_RE, (m, prop, val) => {
      const out = transform(prop.trim().toLowerCase(), val);
      return `${prop}: ${out};`;
    });
    return `${sel}{${newDecls}}`;
  });
}
function pickBest(cands, scoreFn, markUsed) {
  if (!cands.length) return null;
  const ranked = cands.map((c) => ({ c, s: scoreFn(c) })).sort((a, b) => b.s - a.s);
  const pick = ranked[0].c;
  if (markUsed) markUsed.add(pick);
  return pick;
}
function varToColor(v) {
  for (const [lit, name] of semanticMap) if (name === v) return lit;
  for (const [lit, name] of numericColorMap) if (name === v) return lit;
  return null;
}

/* Lengths / units */
function extractLengths(value) {
  return (value.match(LENGTH_TOKEN_RE) || []).map((s) => s.trim());
}

function lenToPx(lit) {
  const m = lit.match(/^(-?\d*\.?\d+)(px|rem|em|%|vh|vw)$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const u = m[2];
  switch (u) {
    case 'px':
      return n;
    case 'rem':
      return n * ROOT_SIZE;
    case 'em':
      return n * CONTEXT_SIZE;
    case '%':
    case 'vh':
    case 'vw':
      return n; // only for relative ordering
    default:
      return n;
  }
}

function preferRem(lit) {
  const m = lit.match(/^(-?\d*\.?\d+)(px)$/);
  if (!m) return lit;
  const px = parseFloat(m[1]);
  if (px % 4 === 0) {
    const rem = +(px / ROOT_SIZE).toFixed(4);
    return `${stripZero(rem)}rem`;
  }
  return lit;
}

function stripZero(x) {
  return String(x).replace(/\.?0+$/, '');
}

/* Borders / radii */
function extractBorderWidth(val) {
  const m = val.match(LENGTH_TOKEN_RE);
  return m ? m[0] : null;
}
function extractRadiusTokens(val) {
  return [val.trim()];
}

/* Motion */
function extractDurations(val) {
  const DUR_RE = /-?\d*\.?\d+(ms|s)\b/g;
  const out = [];
  let m;
  while ((m = DUR_RE.exec(val))) {
    const str = m[0];
    out.push({ str, ms: toMs(str) });
  }
  return out;
}
function extractEasings(val) {
  const EASE_RE =
    /(?:linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end|steps\([^)]*\)|cubic-bezier\([^)]*\))/g;
  return val.match(EASE_RE) || [];
}
function toMs(str) {
  const n = parseFloat(str);
  return /ms$/.test(str) ? n : n * 1000;
}
function normalizeDuration(str) {
  const s = toMs(str) / 1000;
  return `${stripZero(+s.toFixed(3))}s`;
}

/* Color conversions / transforms */
function toRgba(token) {
  token = token.trim().toLowerCase();
  if (token.startsWith('#')) return hexToRgba(token);
  if (token.startsWith('rgb')) return rgbStrToRgba(token);
  if (token.startsWith('hsl')) return hslStrToRgba(token);
  return { r: 0, g: 0, b: 0, a: 1 };
}
function hexToRgba(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3 || h.length === 4) {
    const r = parseInt(h[0] + h[0], 16),
      g = parseInt(h[1] + h[1], 16),
      b = parseInt(h[2] + h[2], 16);
    const a = h.length === 4 ? parseInt(h[3] + h[3], 16) / 255 : 1;
    return { r, g, b, a };
  }
  if (h.length === 6 || h.length === 8) {
    const r = parseInt(h.slice(0, 2), 16),
      g = parseInt(h.slice(2, 4), 16),
      b = parseInt(h.slice(4, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}
function rgbStrToRgba(str) {
  const parts = str
    .slice(str.indexOf('(') + 1, str.lastIndexOf(')'))
    .split(',')
    .map((s) => s.trim());
  const to255 = (v) => (/%$/.test(v) ? Math.round(parseFloat(v) * 2.55) : parseFloat(v));
  const r = to255(parts[0] || '0'),
    g = to255(parts[1] || '0'),
    b = to255(parts[2] || '0');
  const a = parts[3] != null ? parseFloat(parts[3]) : 1;
  return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a: clamp(a, 0, 1) };
}
function hslStrToRgba(str) {
  const parts = str
    .slice(str.indexOf('(') + 1, str.lastIndexOf(')'))
    .split(',')
    .map((s) => s.trim());
  let h = parseFloat(parts[0] || '0');
  let s = /%$/.test(parts[1]) ? parseFloat(parts[1]) / 100 : parseFloat(parts[1] || '0');
  let l = /%$/.test(parts[2]) ? parseFloat(parts[2]) / 100 : parseFloat(parts[2] || '0');
  const a = parts[3] != null ? parseFloat(parts[3]) : 1;
  return hslToRgba({ h, s, l, a });
}
function rgbaToCss({ r, g, b, a }) {
  if (a === 1) {
    const hex = (n) => n.toString(16).padStart(2, '0');
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  }
  return `rgba(${r}, ${g}, ${b}, ${round(a, 4)})`;
}
function round(n, p = 3) {
  const f = 10 ** p;
  return Math.round(n * f) / f;
}
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
function rgbaToHsl({ r, g, b, a }) {
  let R = r / 255,
    G = g / 255,
    B = b / 255;
  const max = Math.max(R, G, B),
    min = Math.min(R, G, B);
  let h = 0,
    s = 0,
    l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case R:
        h = (G - B) / d + (G < B ? 6 : 0);
        break;
      case G:
        h = (B - R) / d + 2;
        break;
      case B:
        h = (R - G) / d + 4;
        break;
    }
    h *= 60;
  }
  return { h, s, l, a };
}
function hslToRgba({ h, s, l, a = 1 }) {
  h = ((h % 360) + 360) % 360;
  s = clamp(s, 0, 1);
  l = clamp(l, 0, 1);
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v, a };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = h / 360;
  const t = [hk + 1 / 3, hk, hk - 1 / 3].map((x) => {
    x = ((x % 1) + 1) % 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  });
  return { r: Math.round(t[0] * 255), g: Math.round(t[1] * 255), b: Math.round(t[2] * 255), a };
}
function relLuminance({ r, g, b }) {
  const nl = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const R = nl(r),
    G = nl(g),
    B = nl(b);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

// minimal OKLCH tone-like dark transform (fallback approximation)
function toDarkTone(rgba) {
  // use HSL fallback, darken while reducing saturation
  const hsl = rgbaToHsl(rgba);
  const out = {
    ...hsl,
    l: clamp(1 - hsl.l * 0.9, 0.1, 0.92),
    s: clamp(hsl.s * 0.9, 0, 1),
  };
  return clampRgb(hslToRgba(out));
}

function toDark(rgba, mode) {
  if (mode === 'invert') return clampRgb(invertRgb(rgba));
  if (mode === 'tone') return toDarkTone(rgba); // NEW algorithm
  // default: flip lightness
  const hsl = rgbaToHsl(rgba);
  const neutral = hsl.s < 0.08;
  const out = { ...hsl };
  out.l = clamp(1 - hsl.l, 0.08, 0.92);
  if (neutral) out.s = 0;
  return clampRgb(hslToRgba(out));
}

function invertRgb({ r, g, b, a }) {
  return { r: clamp(255 - r, 10, 245), g: clamp(255 - g, 10, 245), b: clamp(255 - b, 10, 245), a };
}
function clampRgb({ r, g, b, a }) {
  return {
    r: clamp(Math.round(r), 0, 255),
    g: clamp(Math.round(g), 0, 255),
    b: clamp(Math.round(b), 0, 255),
    a: clamp(a, 0, 1),
  };
}
function hslDist(a, b) {
  const dh = Math.abs(a.h - b.h) / 360,
    ds = Math.abs(a.s - b.s),
    dl = Math.abs(a.l - b.l);
  return Math.sqrt(dh * dh + ds * ds + dl * dl);
}
/* ---------------------------------------------------------------
   UNIT CONVERSION
   - Supports px, rem, em
   - Uses global ROOT_SIZE (rem) and CONTEXT_SIZE (em)
---------------------------------------------------------------- */

/** Parse "--convert" like "px>rem,em>px" > [{from:'px', to:'rem'}, ...] */
function parseConvert(spec) {
  if (!spec) return [];
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const [from, to] = pair.split('>').map((x) => x.trim().toLowerCase());
      const ok = ['px', 'rem', 'em'];
      if (!ok.includes(from) || !ok.includes(to) || from === to) return null;
      return { from, to };
    })
    .filter(Boolean);
}

/** Convert a single numeric token with unit among px/rem/em */
function convertLengthUnitToken(token, from, to, { rootPx = 16, contextPx = 16 }) {
  const m = token.match(/^(-?\d*\.?\d+)(px|rem|em)$/i);
  if (!m) return token;
  let val = parseFloat(m[1]);
  const unit = m[2].toLowerCase();

  // only convert if token unit matches the pair's "from"
  if (unit !== from) return token;

  // normalize to px
  let px;
  if (from === 'px') px = val;
  else if (from === 'rem') px = val * rootPx;
  else if (from === 'em') px = val * contextPx;

  // px > target
  let out;
  if (to === 'px') out = px;
  else if (to === 'rem') out = px / rootPx;
  else if (to === 'em') out = px / contextPx;

  return prettifyUnit(out, to);
}

/** Convert all applicable tokens in a CSS value string for a set of pairs */
function convertUnitsInValue(value, pairs, opts) {
  const withFns = convertUnitsInFunctions(value, pairs, opts);
  // only touch px|rem|em tokens (avoid %, vh, vw)
  return withFns.replace(/(-?\d*\.?\d+)(px|rem|em)\b/gi, (m) => {
    let out = m;
    for (const { from, to } of pairs) out = convertLengthUnitToken(out, from, to, opts);
    return out;
  });
}

/** Convert units across the whole CSS source */
function convertCssUnits(source, pairs, { rootPx = 16, contextPx = 16 } = {}) {
  if (!pairs.length) return source;
  const fsMap = buildFontSizeMap(source);
  return source.replace(RULE_RE, (full, sel, decls) => {
    const ctxPx = fsMap.get(sel.trim()) || contextPx;
    const newDecls = decls.replace(PROP_RE, (m, prop, val) => {
      const v = convertUnitsInValue(val, pairs, { rootPx, contextPx: ctxPx });
      return `${prop}: ${v};`;
    });
    return `${sel}{${newDecls}}`;
  });
}

/** Format with minimal trailing zeros */
function prettifyUnit(n, unit) {
  // keep up to 4 decimals, strip trailing zeros/decimal
  const num = stripZero(+n.toFixed(4));
  return `${num}${unit}`;
}

// parse length-like or unitless where applicable without throwing
function lenToPxSafe(lit) {
  // supports px/rem/em; falls back: unitless/others => NaN -> treat as 0
  const m = String(lit)
    .trim()
    .match(/^(-?\d*\.?\d+)(px|rem|em)$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const u = m[2].toLowerCase();
  if (u === 'px') return n;
  if (u === 'rem') return n * ROOT_SIZE;
  if (u === 'em') return n * CONTEXT_SIZE;
  return 0;
}

function lineHeightToFloat(v) {
  // unitless -> number, length -> px (approx), keyword "normal" -> 1.2 (conventional fallback)
  const s = String(v).trim().toLowerCase();
  if (s === 'normal') return 1.2;
  const unitless = s.match(/^(-?\d*\.?\d+)$/);
  if (unitless) return parseFloat(unitless[1]);
  const px = lenToPxSafe(s);
  return isNaN(px) ? 0 : px;
}

function fontWeightToNum(v) {
  const s = String(v).trim().toLowerCase();
  if (/^\d{3}$/.test(s)) return parseInt(s, 10);
  if (s === 'normal') return 400;
  if (s === 'bold') return 700;
  if (s === 'lighter' || s === 'bolder') return 500; // mid fallback just for ordering
  return 0;
}

// parse + convert inside calc()/clamp()/min()/max()
function convertUnitsInFunctions(value, pairs, opts) {
  // recursively replace length tokens inside math functions
  const FN_RE = /(calc|min|max|clamp)\(\s*([^()]*|\((?:[^()]*|\([^()]*\))*\))*\)/gi;
  return value.replace(FN_RE, (fn) => {
    // convert primitives inside the function string
    const inner = fn.replace(/(-?\d*\.?\d+)(px|rem|em)\b/gi, (m) => {
      let out = m;
      for (const { from, to } of pairs) out = convertLengthUnitToken(out, from, to, opts);
      return out;
    });
    return inner;
  });
}

// build a quick font-size map before conversion (from original CSS)
function buildFontSizeMap(source) {
  const map = new Map(); // selector -> px
  source.replace(RULE_RE, (full, sel, decls) => {
    decls.replace(PROP_RE, (m, prop, val) => {
      if (prop.trim().toLowerCase() === 'font-size') {
        // normalize to px using ROOT/CONTEXT fallbacks
        const px = lenToPxSafe(val.trim());
        if (px) map.set(sel.trim(), px);
      }
      return m;
    });
    return full;
  });
  return map;
}

function parseFontShorthand(v) {
  // very light parse: look for font-size[/line-height] and font-weight keywords/numbers
  const sizePart = v.match(/(^|\s)(-?\d*\.?\d+(px|rem|em|%)(?:\s*\/\s*[^ \t/;]+)?)/i);
  const weightPart = v.match(/\b(100|200|300|400|500|600|700|800|900|normal|bold)\b/i);
  let fs = null,
    lh = null,
    fw = null,
    ls = null;
  if (sizePart) {
    const raw = sizePart[2];
    const m = raw.match(/^([^\s/]+)(?:\s*\/\s*([^\s/]+))?/);
    if (m) {
      fs = m[1];
      lh = m[2] || null;
    }
  }
  if (weightPart) fw = weightPart[1];
  return { fs, lh, fw, ls };
}

// normalize family list spacing/commas for stable matching
function normalizeFontFamilyList(s) {
  return String(s)
    .replace(/\s*,\s*/g, ',') // collapse comma spaces
    .replace(/\s+/g, ' ') // collapse inner whitespace
    .trim()
    .replace(/,/g, ', '); // pretty: one space after comma
}

// extend shorthand parser to also extract the family tail
function parseFontShorthandWithFamily(v) {
  // match the first font-size [ / line-height ] and capture the tail as family
  const m = /(-?\d*\.?\d+(?:px|rem|em|%))(?:\s*\/\s*([^\s/;]+))?(.*)$/i.exec(v);
  let fs = null,
    lh = null,
    fw = null,
    family = null;
  if (m) {
    fs = m[1];
    lh = m[2] || null;
    family = m[3].trim();
  }
  const weightPart = v.match(/\b(100|200|300|400|500|600|700|800|900|normal|bold)\b/i);
  if (weightPart) fw = weightPart[1];
  return { fs, lh, fw, family };
}

// escape for regex
function escRE(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeReplaceMap(val, map) {
  const pairs = [...map.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [lit, vname] of pairs) {
    const re = new RegExp(`(^|[^\\w-])(${escRE(lit)})(?![\\w-])`, 'gi'); // <- add i
    val = val.replace(re, (_, pre) => `${pre}var(${vname})`);
  }
  return val;
}

function normalizeRadius(v) {
  return v
    .replace(/\s*\/\s*/g, ' / ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isCssWideKeyword(s) {
  return /^(inherit|initial|unset|revert|revert-layer)$/i.test(String(s).trim());
}
