import type {
  BackdropFillMode,
  CanvasStyleConfig,
  ConnectorCurveStyle,
  SectionMarkerStyle,
} from '../../lib/visualPresets.ts';

export function CanvasDesignInspector({
  config,
  onChange,
  onReset,
  onClose,
}: {
  config: CanvasStyleConfig;
  onChange: (patch: Partial<CanvasStyleConfig>) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const toggleSection = (key: keyof CanvasStyleConfig['sections']) => {
    onChange({
      sections: {
        ...config.sections,
        [key]: !config.sections[key],
      },
    });
  };

  return (
    <section className="wf-inspector" aria-label="Canvas style and layout inspector">
      <header className="wf-inspector-head">
        <div className="wf-inspector-title-wrap">
          <span className="wf-inspector-title">Canvas Style &amp; Layout</span>
          <span className="wf-inspector-sub">
            Adjust layout blocks, spacing, surface fills, backdrop blur, borders, and connector
            geometry in real time.
          </span>
        </div>
        <div className="wf-inspector-actions">
          <button type="button" className="canvas-pill" onClick={onReset}>
            Reset
          </button>
          <button type="button" className="canvas-pill is-on" onClick={onClose}>
            Done
          </button>
        </div>
      </header>

      <div className="wf-inspector-grid">
        {/* Column 1: Layout, Spacing & Visible Blocks */}
        <div className="wf-panel-group">
          <span className="wf-group-title">Layout &amp; Blocks</span>

          <div className="wf-prop-stack">
            <span className="wf-prop-label">Visible Sections</span>
            <div className="wf-toggle-list">
              {(
                [
                  ['agentAndTools', 'Agent & Tools'],
                  ['editedFilesSummary', 'Edited Files Card'],
                  ['checksAndReview', 'Checks & Review'],
                  ['codeMap', 'Code Map & Impact'],
                  ['coverageMeter', 'Coverage Bar'],
                ] as const
              ).map(([key, label]) => {
                const active = config.sections[key];
                return (
                  <button
                    key={key}
                    type="button"
                    className={`canvas-pill ${active ? 'is-on' : ''}`}
                    aria-pressed={active}
                    onClick={() => toggleSection(key)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="wf-prop-row">
            <label className="wf-prop-label" htmlFor="wf-padding">
              Padding
            </label>
            <div className="wf-slider-wrap">
              <input
                id="wf-padding"
                type="range"
                min={8}
                max={28}
                step={2}
                value={config.cardPaddingPx}
                onChange={(e) => onChange({ cardPaddingPx: Number(e.target.value) })}
              />
              <span className="wf-unit mono">{config.cardPaddingPx}px</span>
            </div>
          </div>

          <div className="wf-prop-row">
            <label className="wf-prop-label" htmlFor="wf-gap">
              Card Gap
            </label>
            <div className="wf-slider-wrap">
              <input
                id="wf-gap"
                type="range"
                min={4}
                max={20}
                step={2}
                value={config.cardGapPx}
                onChange={(e) => onChange({ cardGapPx: Number(e.target.value) })}
              />
              <span className="wf-unit mono">{config.cardGapPx}px</span>
            </div>
          </div>

          <div className="wf-prop-row">
            <label className="wf-prop-label" htmlFor="wf-radius">
              Radius
            </label>
            <div className="wf-slider-wrap">
              <input
                id="wf-radius"
                type="range"
                min={0}
                max={28}
                step={2}
                value={config.cornerRadiusPx}
                onChange={(e) => onChange({ cornerRadiusPx: Number(e.target.value) })}
              />
              <span className="wf-unit mono">{config.cornerRadiusPx}px</span>
            </div>
          </div>
        </div>

        {/* Column 2: Backgrounds, Card Opacity, Blur & Borders */}
        <div className="wf-panel-group">
          <span className="wf-group-title">Surface &amp; Borders</span>

          <div className="wf-prop-row">
            <span className="wf-prop-label">Backdrop</span>
            <div className="wf-seg-row">
              {(['solid', 'gradient'] as const).map((mode: BackdropFillMode) => (
                <button
                  key={mode}
                  type="button"
                  className={`canvas-pill ${config.fillMode === mode ? 'is-on' : ''}`}
                  onClick={() => onChange({ fillMode: mode })}
                >
                  {mode === 'solid' ? 'Solid' : 'Gradient'}
                </button>
              ))}
            </div>
          </div>

          <div className="wf-prop-row">
            <label className="wf-prop-label" htmlFor="wf-bg-primary">
              Canvas Fill
            </label>
            <div className="wf-color-row">
              <input
                id="wf-bg-primary"
                type="color"
                className="wf-color-swatch"
                value={config.canvasBgPrimary}
                onChange={(e) => onChange({ canvasBgPrimary: e.target.value })}
              />
              <input
                type="text"
                className="wf-hex-input mono"
                value={config.canvasBgPrimary}
                onChange={(e) => onChange({ canvasBgPrimary: e.target.value })}
                aria-label="Canvas primary hex color"
              />
              {config.fillMode === 'gradient' && (
                <>
                  <input
                    type="color"
                    className="wf-color-swatch"
                    value={config.canvasBgSecondary}
                    onChange={(e) => onChange({ canvasBgSecondary: e.target.value })}
                    aria-label="Canvas secondary gradient color"
                  />
                  <input
                    type="number"
                    className="wf-angle-input mono"
                    min={0}
                    max={360}
                    value={config.canvasGradientAngle}
                    onChange={(e) => onChange({ canvasGradientAngle: Number(e.target.value) })}
                    aria-label="Gradient angle"
                    title="Gradient angle (deg)"
                  />
                </>
              )}
            </div>
          </div>

          <div className="wf-prop-row">
            <label className="wf-prop-label" htmlFor="wf-card-bg">
              Card Fill
            </label>
            <div className="wf-color-row">
              <input
                id="wf-card-bg"
                type="color"
                className="wf-color-swatch"
                value={config.cardBgColor}
                onChange={(e) => onChange({ cardBgColor: e.target.value })}
              />
              <input
                type="range"
                min={20}
                max={100}
                step={5}
                value={config.cardBgOpacity}
                onChange={(e) => onChange({ cardBgOpacity: Number(e.target.value) })}
                aria-label="Card fill opacity"
              />
              <span className="wf-unit mono">{config.cardBgOpacity}%</span>
            </div>
          </div>

          <div className="wf-prop-row">
            <label className="wf-prop-label" htmlFor="wf-blur">
              Glass Blur
            </label>
            <div className="wf-slider-wrap">
              <input
                id="wf-blur"
                type="range"
                min={0}
                max={32}
                step={2}
                value={config.cardBlurPx}
                onChange={(e) => onChange({ cardBlurPx: Number(e.target.value) })}
              />
              <span className="wf-unit mono">{config.cardBlurPx}px</span>
            </div>
          </div>

          <div className="wf-prop-row">
            <label className="wf-prop-label" htmlFor="wf-border-color">
              Border
            </label>
            <div className="wf-color-row">
              <input
                id="wf-border-color"
                type="color"
                className="wf-color-swatch"
                value={config.borderColor}
                onChange={(e) => onChange({ borderColor: e.target.value })}
              />
              <input
                type="range"
                min={0}
                max={2}
                step={0.5}
                value={config.borderWidthPx}
                onChange={(e) => onChange({ borderWidthPx: Number(e.target.value) })}
                aria-label="Border width"
              />
              <span className="wf-unit mono">{config.borderWidthPx}px</span>
            </div>
          </div>
        </div>

        {/* Column 3: Connectors & Typography */}
        <div className="wf-panel-group">
          <span className="wf-group-title">Connectors &amp; Typography</span>

          <div className="wf-prop-row">
            <span className="wf-prop-label">Curve Style</span>
            <div className="wf-seg-row">
              {(['bezier', 'step', 'straight'] as const).map((cStyle: ConnectorCurveStyle) => (
                <button
                  key={cStyle}
                  type="button"
                  className={`canvas-pill ${config.connectorStyle === cStyle ? 'is-on' : ''}`}
                  onClick={() => onChange({ connectorStyle: cStyle })}
                >
                  {cStyle === 'bezier' ? 'Bezier' : cStyle === 'step' ? 'Step' : 'Straight'}
                </button>
              ))}
            </div>
          </div>

          <div className="wf-prop-row">
            <label className="wf-prop-label" htmlFor="wf-conn-color">
              Line Stroke
            </label>
            <div className="wf-color-row">
              <input
                id="wf-conn-color"
                type="color"
                className="wf-color-swatch"
                value={config.connectorColor}
                onChange={(e) => onChange({ connectorColor: e.target.value })}
              />
              <input
                type="range"
                min={1}
                max={3}
                step={0.25}
                value={config.connectorWidthPx}
                onChange={(e) => onChange({ connectorWidthPx: Number(e.target.value) })}
                aria-label="Connector stroke width"
              />
              <span className="wf-unit mono">{config.connectorWidthPx}px</span>
            </div>
          </div>

          <div className="wf-prop-row">
            <label className="wf-prop-label" htmlFor="wf-text-color">
              Text &amp; Accent
            </label>
            <div className="wf-color-row">
              <input
                id="wf-text-color"
                type="color"
                className="wf-color-swatch"
                value={config.textColor}
                onChange={(e) =>
                  onChange({ textColor: e.target.value, headingColor: e.target.value })
                }
                title="Primary text and heading color"
              />
              <input
                type="color"
                className="wf-color-swatch"
                value={config.mutedTextColor}
                onChange={(e) => onChange({ mutedTextColor: e.target.value })}
                title="Muted metadata text color"
                aria-label="Muted text color"
              />
              <input
                type="color"
                className="wf-color-swatch"
                value={config.accentColor}
                onChange={(e) => onChange({ accentColor: e.target.value })}
                title="Accent highlight color"
                aria-label="Accent color"
              />
            </div>
          </div>

          <div className="wf-prop-row">
            <span className="wf-prop-label">Section Index</span>
            <div className="wf-seg-row">
              {(
                [
                  ['none', 'None'],
                  ['square', '■ Square'],
                  ['number', '01 Number'],
                ] as const
              ).map(([marker, label]: readonly [SectionMarkerStyle, string]) => (
                <button
                  key={marker}
                  type="button"
                  className={`canvas-pill ${config.sectionMarker === marker ? 'is-on' : ''}`}
                  onClick={() => onChange({ sectionMarker: marker })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
