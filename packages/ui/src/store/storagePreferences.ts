/**
 * One control, concrete ends, and semantic depth rather than verbosity:
 * 0 = Summary (the explanation), 1 = Detail (what the evidence shows), 2 = Source (the evidence).
 */
export type Detail = 0 | 1 | 2;

export const DETAIL_KEY = 'salidium.detail';
export const SIDEBAR_KEY = 'salidium.sidebar';
export const THEME_KEY = 'salidium.theme';
export const STATS_KEY = 'salidium.stats';
export const INGEST_KEY = 'salidium.ingest';
export const REWIND_KEY = 'salidium.rewind';
export const SIDE_FOLDS_KEY = 'salidium.sideFolds';
export const CANVAS_LENS_KEY = 'salidium.canvasLens';
export const CANVAS_STYLE_KEY = 'salidium.canvasStyle';
export const CANVAS_DENSITY_KEY = 'salidium.canvasDensity';
export const CANVAS_BLAST_KEY = 'salidium.canvasBlastRadius';
export const CANVAS_VERIF_KEY = 'salidium.canvasVerification';

export type CanvasLens = 'auto' | 'narrative' | 'system' | 'sequence' | 'verification';
export type CanvasStyle = 'blueprint' | 'studio';
export type CanvasDensity = 'files' | 'modules';

export function storageGet(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function'
      ? localStorage.getItem(key)
      : null;
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
      localStorage.setItem(key, value);
    }
  } catch {
    // Ignore storage quota or SSR absence.
  }
}

export function storedCanvasLens(): CanvasLens {
  const raw = storageGet(CANVAS_LENS_KEY);
  if (raw === 'narrative' || raw === 'system' || raw === 'sequence' || raw === 'verification') {
    return raw;
  }
  return 'auto';
}

export function storedCanvasStyle(): CanvasStyle {
  const raw = storageGet(CANVAS_STYLE_KEY);
  return raw === 'studio' ? 'studio' : 'blueprint';
}

export function storedCanvasDensity(): CanvasDensity {
  const raw = storageGet(CANVAS_DENSITY_KEY);
  return raw === 'modules' ? 'modules' : 'files';
}

/** The one group whose name the store has to know, because it is the one folded by default. */
export const NOTHING_RECORDED = 'Nothing recorded';

export function storedFolds(): string[] {
  const raw = storageGet(SIDE_FOLDS_KEY);
  if (raw === null) return [NOTHING_RECORDED];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Where the change log is shown. The rail is for glancing while you read the page; the table is
 * for actually working through a long one, which a 320 px column is a poor place to do.
 */
export type HistoryMode = 'off' | 'rail' | 'table';

/** `system` follows the OS; the other two pin it. Stored, because a theme that resets is a bug. */
export type Theme = 'system' | 'light' | 'dark';

/**
 * The stylesheet reads `[data-theme]`, and its absence means "follow `prefers-color-scheme`".
 * Applied at module load rather than in an effect so the first paint is already correct.
 */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

export function storedTheme(): Theme {
  const t = storageGet(THEME_KEY);
  return t === 'light' || t === 'dark' ? t : 'system';
}

export function storedDetail(): Detail {
  const d = storageGet(DETAIL_KEY);
  if (d === '1') return 1;
  if (d === '2') return 2;
  return 0;
}

/** The section summoned over the page. Nothing is a section of the document any more. */
export type PanelId = 'checks' | 'left' | 'review' | 'evidence' | 'where';
