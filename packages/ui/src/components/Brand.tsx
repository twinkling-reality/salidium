const MARK_VIEWBOX_WIDTH = 64;
const MARK_VIEWBOX_HEIGHT = 44;

export interface BrandMarkProps {
  /** The rendered height in CSS pixels. Width follows the mark's native aspect ratio. */
  size?: number;
  className?: string;
  /** Set when nearby visible text already names Salidium. */
  decorative?: boolean;
  /** Accessible name used when the mark stands alone. */
  label?: string;
}

/**
 * The compact two-part Salidium mark. Keep these paths in sync with the canonical SVG in
 * `assets/brand/salidium-mark.svg`; inlining them lets `currentColor` follow the active theme.
 */
export function BrandMark({
  size = 24,
  className,
  decorative = false,
  label = 'Salidium',
}: BrandMarkProps) {
  return (
    <svg
      className={className}
      viewBox={`0 0 ${MARK_VIEWBOX_WIDTH} ${MARK_VIEWBOX_HEIGHT}`}
      width={(size * MARK_VIEWBOX_WIDTH) / MARK_VIEWBOX_HEIGHT}
      height={size}
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : label}
      focusable="false"
    >
      <path
        fill="currentColor"
        d="M12 1.1C17.2-.2 21.6.1 26.1 2.6l9.1 5c5.4 3 6.6 7.8 3 11.9l-2.7 2.9c-1.4 1.5-1 3.9.8 5.2l3.5 2.8c3.2 2.5 3.9 6.7 1.3 9.8-1.5 1.8-3.6 2.7-6.3 2.7H14.1c-4.3 0-7.3-2.1-9-6L.9 27.1c-1.2-2.7-.9-5.8.1-8.5L5.3 7.3C6.5 4.2 8.8 2 12 1.1Z"
      />
      <path
        fill="currentColor"
        d="M46.3 14.1c1.8-1.4 4.2-1.6 6.2-.4l5.6 3.3c3.1 1.8 4.8 4.7 5.3 8.4l.6 9.4c.3 4.6-2.1 8.1-6.5 8.1h-7.1c-4.1 0-6.6-3.1-6.2-7 .4-3.2-.8-5.8-3.4-7.7-2.7-2-3.1-5.5-1.3-8.1l6.8-6Z"
      />
    </svg>
  );
}

export interface BrandLockupProps {
  markSize?: number;
  className?: string;
}

/** The production lockup: vector mark plus live, accessible product-name text. */
export function BrandLockup({ markSize = 24, className }: BrandLockupProps) {
  const classes = ['brand-lockup', className].filter(Boolean).join(' ');

  return (
    <span className={classes}>
      <BrandMark size={markSize} className="brand-lockup-mark" decorative />
      <span className="brand-lockup-name">Salidium</span>
    </span>
  );
}
