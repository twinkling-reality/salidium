export type ConnectorCurveStyle = 'bezier' | 'step' | 'straight';
export type SectionMarkerStyle = 'none' | 'square' | 'number';
export type BackdropFillMode = 'solid' | 'gradient';

export interface CanvasSectionVisibility {
  agentAndTools: boolean;
  editedFilesSummary: boolean;
  checksAndReview: boolean;
  codeMap: boolean;
  coverageMeter: boolean;
}

export interface CanvasStyleConfig {
  format: 'salidium.canvas-style/v1';
  fillMode: BackdropFillMode;
  canvasBgPrimary: string;
  canvasBgSecondary: string;
  canvasGradientAngle: number;
  cardBgColor: string;
  cardBgOpacity: number;
  cardBlurPx: number;
  cornerRadiusPx: number;
  cardPaddingPx: number;
  cardGapPx: number;
  borderWidthPx: number;
  borderColor: string;
  borderOpacity: number;
  headingColor: string;
  textColor: string;
  mutedTextColor: string;
  accentColor: string;
  connectorStyle: ConnectorCurveStyle;
  connectorWidthPx: number;
  connectorColor: string;
  sectionMarker: SectionMarkerStyle;
  sections: CanvasSectionVisibility;
}

export const DEFAULT_CANVAS_STYLE_CONFIG: CanvasStyleConfig = {
  format: 'salidium.canvas-style/v1',
  fillMode: 'solid',
  canvasBgPrimary: '#f6f5f2',
  canvasBgSecondary: '#eae7e0',
  canvasGradientAngle: 145,
  cardBgColor: '#ffffff',
  cardBgOpacity: 100,
  cardBlurPx: 0,
  cornerRadiusPx: 10,
  cardPaddingPx: 16,
  cardGapPx: 10,
  borderWidthPx: 1,
  borderColor: '#c6c2b6',
  borderOpacity: 100,
  headingColor: '#1f1e1b',
  textColor: '#1f1e1b',
  mutedTextColor: '#66635b',
  accentColor: '#2b59c3',
  connectorStyle: 'bezier',
  connectorWidthPx: 1.5,
  connectorColor: '#9c988e',
  sectionMarker: 'none',
  sections: {
    agentAndTools: true,
    editedFilesSummary: false,
    checksAndReview: true,
    codeMap: true,
    coverageMeter: true,
  },
};

const CANVAS_STYLE_STORAGE_KEY = 'salidium.canvasStyleConfig.v1';

export type RgbTuple = [number, number, number];

export function parseHexRgb(hex: string): RgbTuple | null {
  const clean = hex.replace('#', '').trim();
  if (clean.length === 3) {
    const c0 = clean.charAt(0);
    const c1 = clean.charAt(1);
    const c2 = clean.charAt(2);
    const r = Number.parseInt(c0 + c0, 16);
    const g = Number.parseInt(c1 + c1, 16);
    const b = Number.parseInt(c2 + c2, 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
    return [r, g, b];
  }
  if (clean.length !== 6) return null;
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return [r, g, b];
}

function srgbChannelToLinear(c255: number): number {
  const c = Math.max(0, Math.min(255, c255)) / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.1 relative luminance in [0, 1]. */
export function relativeLuminance(rgb: RgbTuple): number {
  const r = srgbChannelToLinear(rgb[0]);
  const g = srgbChannelToLinear(rgb[1]);
  const b = srgbChannelToLinear(rgb[2]);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** OKLab perceptual lightness L in [0, 1] from sRGB [0..255]. */
export function oklabLightness(rgb: RgbTuple): number {
  const r = srgbChannelToLinear(rgb[0]);
  const g = srgbChannelToLinear(rgb[1]);
  const b = srgbChannelToLinear(rgb[2]);
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  return 0.2104542553 * Math.cbrt(l) + 0.793617785 * Math.cbrt(m) - 0.0040720468 * Math.cbrt(s);
}

/** WCAG contrast ratio between two RGB tuples in [1, 21]. */
export function contrastRatio(a: RgbTuple, b: RgbTuple): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

function mixRgb(base: RgbTuple, target: RgbTuple, targetWeight: number): RgbTuple {
  const w = Math.max(0, Math.min(1, targetWeight));
  return [
    Math.round(base[0] * (1 - w) + target[0] * w),
    Math.round(base[1] * (1 - w) + target[1] * w),
    Math.round(base[2] * (1 - w) + target[2] * w),
  ];
}

function rgbToHex([r, g, b]: RgbTuple): string {
  const toHex = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function rgbToRgba([r, g, b]: RgbTuple, opacityPct: number): string {
  const alpha = Math.max(0, Math.min(100, opacityPct)) / 100;
  return `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha.toFixed(2)})`;
}

function ensureContrastAgainstSurfaces(
  fg: RgbTuple,
  bgs: RgbTuple[],
  minRatio: number,
  pole: RgbTuple,
): RgbTuple {
  const minContrast = (c: RgbTuple) => Math.min(...bgs.map((bg) => contrastRatio(c, bg)));
  if (minContrast(fg) >= minRatio) return fg;
  let low = 0;
  let high = 1;
  let best = pole;
  for (let i = 0; i < 12; i++) {
    const mid = (low + high) / 2;
    const candidate = mixRgb(fg, pole, mid);
    if (minContrast(candidate) >= minRatio) {
      best = candidate;
      high = mid;
    } else {
      low = mid;
    }
  }
  return best;
}

export function loadCanvasStyleConfig(): CanvasStyleConfig {
  try {
    if (typeof localStorage === 'undefined' || typeof localStorage.getItem !== 'function') {
      return DEFAULT_CANVAS_STYLE_CONFIG;
    }
    const raw = localStorage.getItem(CANVAS_STYLE_STORAGE_KEY);
    if (!raw) return DEFAULT_CANVAS_STYLE_CONFIG;
    const parsed = JSON.parse(raw) as Partial<CanvasStyleConfig>;
    if (!parsed || typeof parsed !== 'object') return DEFAULT_CANVAS_STYLE_CONFIG;
    return {
      ...DEFAULT_CANVAS_STYLE_CONFIG,
      ...parsed,
      sections: {
        ...DEFAULT_CANVAS_STYLE_CONFIG.sections,
        ...(parsed.sections ?? {}),
      },
    };
  } catch {
    return DEFAULT_CANVAS_STYLE_CONFIG;
  }
}

export function saveCanvasStyleConfig(config: CanvasStyleConfig): void {
  try {
    if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
      localStorage.setItem(CANVAS_STYLE_STORAGE_KEY, JSON.stringify(config));
    }
  } catch {
    // Ignore storage errors
  }
}

/**
 * Computes inline CSS custom properties with mathematical perceptual contrast guardrails across all
 * 3 elevation tiers:
 * - Tier 0: Canvas Backdrop (`--custom-canvas-bg`)
 * - Tier 1: Section Container (`--custom-card-bg`)
 * - Tier 2: Inner Node Card (`--custom-card-subtle-bg` + `--custom-inner-border-color`)
 */
export function canvasStyleToInlineVars(config: CanvasStyleConfig): Record<string, string> {
  const canvasPrimaryRgb = parseHexRgb(config.canvasBgPrimary) ?? [246, 245, 242];
  const canvasSecondaryRgb = parseHexRgb(config.canvasBgSecondary) ?? canvasPrimaryRgb;
  const effectiveCanvasRgb =
    config.fillMode === 'gradient'
      ? mixRgb(canvasPrimaryRgb, canvasSecondaryRgb, 0.5)
      : canvasPrimaryRgb;

  const rawCardRgb = parseHexRgb(config.cardBgColor) ?? [255, 255, 255];
  const cardAlpha = Math.max(0.2, Math.min(1, config.cardBgOpacity / 100));
  const compositedTier1Rgb = mixRgb(effectiveCanvasRgb, rawCardRgb, cardAlpha);

  const canvasL = oklabLightness(effectiveCanvasRgb);
  const tier1L = oklabLightness(compositedTier1Rgb);

  // Guardrail 1: Prevent white-on-white or dark-on-dark collapse between Tier 0 (Canvas) and Tier 1 (Container)
  let adjustedCardRgb = rawCardRgb;
  let effectiveTier1Rgb = compositedTier1Rgb;
  if (Math.abs(tier1L - canvasL) < 0.022) {
    const contrastPole: RgbTuple = canvasL > 0.55 ? [228, 224, 214] : [48, 56, 70];
    adjustedCardRgb = mixRgb(rawCardRgb, contrastPole, canvasL > 0.55 ? 0.35 : 0.42);
    effectiveTier1Rgb = mixRgb(effectiveCanvasRgb, adjustedCardRgb, cardAlpha);
  }

  const effectiveTier1L = oklabLightness(effectiveTier1Rgb);
  const isLightSurface = effectiveTier1L > 0.55;
  const highContrastPole: RgbTuple = isLightSurface ? [24, 23, 20] : [245, 247, 250];

  // Guardrail 2: Ensure Tier 2 (Inner Node Card) is perceptually distinct from Tier 1 (Section Container)
  const tier2MixWeight = isLightSurface ? 0.055 : 0.09;
  const tier2Rgb = mixRgb(effectiveTier1Rgb, highContrastPole, tier2MixWeight);

  // Guardrail 3: Ensure text, heading, and muted text maintain WCAG legibility against Tier 1 & Tier 2
  const rawTextRgb =
    parseHexRgb(config.textColor) ?? (isLightSurface ? [31, 30, 27] : [230, 237, 243]);
  const safeTextRgb = ensureContrastAgainstSurfaces(
    rawTextRgb,
    [effectiveTier1Rgb, tier2Rgb],
    4.6,
    highContrastPole,
  );

  const rawHeadingRgb = parseHexRgb(config.headingColor) ?? safeTextRgb;
  const safeHeadingRgb = ensureContrastAgainstSurfaces(
    rawHeadingRgb,
    [effectiveTier1Rgb, tier2Rgb],
    4.6,
    highContrastPole,
  );

  const rawMutedRgb =
    parseHexRgb(config.mutedTextColor) ?? (isLightSurface ? [102, 99, 91] : [148, 163, 184]);
  const safeMutedRgb = ensureContrastAgainstSurfaces(
    rawMutedRgb,
    [effectiveTier1Rgb, tier2Rgb],
    3.1,
    highContrastPole,
  );

  // Guardrail 4: Enforce visible border contrast on both Tier 1 and Tier 2 even if borderColor matches cardBg or borderWidthPx is 0
  const rawBorderRgb = parseHexRgb(config.borderColor) ?? [198, 194, 182];
  const borderAlpha = Math.max(0.25, Math.min(1, config.borderOpacity / 100));
  const compositedBorderRgb = mixRgb(effectiveTier1Rgb, rawBorderRgb, borderAlpha);
  const safeBorderRgb = ensureContrastAgainstSurfaces(
    compositedBorderRgb,
    [effectiveTier1Rgb],
    1.28,
    highContrastPole,
  );
  const safeInnerBorderRgb = ensureContrastAgainstSurfaces(
    mixRgb(safeBorderRgb, highContrastPole, isLightSurface ? 0.12 : 0.16),
    [tier2Rgb],
    1.34,
    highContrastPole,
  );

  const effectiveBorderWidthPx = Math.max(0.75, config.borderWidthPx);

  const canvasBg =
    config.fillMode === 'gradient'
      ? `linear-gradient(${config.canvasGradientAngle}deg, ${config.canvasBgPrimary} 0%, ${config.canvasBgSecondary} 100%)`
      : config.canvasBgPrimary;

  return {
    '--custom-canvas-bg': canvasBg,
    '--custom-card-bg': rgbToRgba(adjustedCardRgb, config.cardBgOpacity),
    '--custom-card-subtle-bg': rgbToHex(tier2Rgb),
    '--custom-card-blur': `${config.cardBlurPx}px`,
    '--custom-radius': `${config.cornerRadiusPx}px`,
    '--custom-radius-inner': `${Math.max(2, Math.round(config.cornerRadiusPx * 0.65))}px`,
    '--custom-padding': `${config.cardPaddingPx}px`,
    '--custom-gap': `${config.cardGapPx}px`,
    '--custom-border-width': `${effectiveBorderWidthPx}px`,
    '--custom-border-color': rgbToHex(safeBorderRgb),
    '--custom-inner-border-color': rgbToHex(safeInnerBorderRgb),
    '--custom-heading-color': rgbToHex(safeHeadingRgb),
    '--custom-text-color': rgbToHex(safeTextRgb),
    '--custom-muted-color': rgbToHex(safeMutedRgb),
    '--custom-accent-color': config.accentColor,
    '--custom-connector-width': `${config.connectorWidthPx}`,
    '--custom-connector-color': config.connectorColor,
  };
}

export function buildConnectorPath(
  style: ConnectorCurveStyle,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): string {
  const midX = (x1 + x2) / 2;
  if (style === 'straight') {
    return `M ${x1} ${y1} L ${x2} ${y2}`;
  }
  if (style === 'step') {
    return `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`;
  }
  return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
}
