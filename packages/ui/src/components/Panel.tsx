import { useEffect, useRef, useState } from 'react';
import { useModalFocus } from '../lib/useModalFocus.ts';
import { useStaysMounted } from '../lib/useStaysMounted.ts';
import { type PanelId, useAppStore } from '../store/appStore.ts';
import { Icon } from './Icon.tsx';

/**
 * A section of the report, summoned over the page instead of living in it.
 *
 * The page used to carry every section at once and let one control decide how many were present.
 * That produced several screens of evidence with the main diagram sharing the page with blocks
 * nobody had asked for. Depth was the wrong instrument: a reader does
 * not want *more of the document*, they want one answer, and then to put it away.
 *
 * So the document is the diagram, and each of the other sections is a thing you open. The panel
 * behaves as a modal dialog for the same reasons the raw drawer does: focus moves into it, Tab
 * cycles inside it, Escape and the backdrop close it, and focus returns to whatever opened it —
 * which here is the badge that states the fact the panel is about.
 */
export interface PanelSection {
  key: string;
  /** The word on the rail. One noun, not a sentence. */
  label: string;
  /** The count that makes the word worth reading before you open it. */
  count?: number;
  render: () => React.ReactNode;
}

export function Panel({
  id,
  title,
  children,
  sections,
}: {
  id: PanelId;
  title: string;
  children?: React.ReactNode;
  /**
   * When a panel holds several unrelated things, they are chosen from a rail rather than stacked.
   * Evidence was four of them in one scroll — a proportion bar, a lane chart, a churn list and a
   * turn log — and the reader had to work out which was which on the way past. The rail shows all
   * four with their counts, so choosing one is reading, not hunting.
   */
  sections?: PanelSection[];
}) {
  const open = useAppStore((s) => s.panel) === id;
  const closePanel = useAppStore((s) => s.closePanel);
  const cardRef = useRef<HTMLDivElement>(null);
  const [section, setSection] = useState<string | undefined>();
  const current = sections?.some((candidate) => candidate.key === section)
    ? section
    : sections?.[0]?.key;
  const active = sections?.find((s) => s.key === current) ?? sections?.[0];

  useModalFocus({ active: open, containerRef: cardRef, onClose: closePanel });
  const mounted = useStaysMounted(open);

  // Live events and rewind both replace the section descriptors. Never retain a selection whose
  // renderer has disappeared; the first surviving section becomes the concrete selection.
  useEffect(() => {
    if (!open) return;
    if (current !== section) setSection(current);
  }, [open, current, section]);

  /*
   * Not `!open`: the scrim fades out rather than disappearing, and a subtree React has already
   * removed has nothing left to fade. It stays from the first time it is opened.
   */
  if (!mounted) return null;
  return (
    <div className={`panel-scrim arrives ${open ? 'is-open' : ''}`}>
      {/* The close control is inside the dialog. The backdrop is pointer affordance only, so it
          stays out of the tab order and the modal has exactly one keyboard boundary. */}
      <div className="panel-backdrop" aria-hidden="true" onClick={closePanel} />
      <div
        className="panel-card"
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="panel-head">
          <h2 className="panel-title">{title}</h2>
          <button type="button" className="panel-close" onClick={closePanel} title="Close (Esc)">
            <Icon name="close" />
          </button>
        </div>
        {sections && sections.length > 0 ? (
          <div className="panel-split">
            <nav className="panel-rail" aria-label={`${title} sections`}>
              {sections.map((sec) => (
                <button
                  type="button"
                  key={sec.key}
                  className={`panel-rail-item ${sec.key === current ? 'is-on' : ''}`}
                  aria-current={sec.key === current ? 'true' : undefined}
                  onClick={() => setSection(sec.key)}
                >
                  <span className="panel-rail-label">{sec.label}</span>
                  {sec.count !== undefined && (
                    <span className="panel-rail-count num">{sec.count}</span>
                  )}
                </button>
              ))}
            </nav>
            <div className="panel-body">{active?.render()}</div>
          </div>
        ) : (
          <div className="panel-body">{children}</div>
        )}
      </div>
    </div>
  );
}
