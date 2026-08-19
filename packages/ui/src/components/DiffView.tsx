import type { Hunk } from '@salidium/protocol';

/**
 * Minimal unified-diff renderer for the hunks Claude Code (jsdiff structuredPatch) and Codex
 * (unified diff) record. Diffs in agent sessions are small (median one hunk), so a plain,
 * accessible table beats a heavyweight diff library here; syntax highlighting can be layered on
 * later behind this component.
 */
export function DiffView({ hunks, maxLines = 400 }: { hunks: Hunk[]; maxLines?: number }) {
  let shown = 0;
  let truncated = false;
  return (
    <div className="diff">
      {hunks.map((h) => {
        if (truncated) return null;
        let oldNo = h.oldStart;
        let newNo = h.newStart;
        const rows: React.ReactNode[] = [];
        rows.push(
          <div
            className="diff-hunk"
            key={`h${h.oldStart}-${h.newStart}-${h.oldLines}-${h.newLines}`}
          >
            <span className="diff-gutter" />
            <span className="diff-gutter" />
            <span className="diff-code mono">
              @@ -{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
            </span>
          </div>,
        );
        for (let i = 0; i < h.lines.length; i++) {
          if (shown >= maxLines) {
            truncated = true;
            break;
          }
          const line = h.lines[i] ?? '';
          const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
          const o = kind === 'add' ? '' : String(oldNo++);
          const n = kind === 'del' ? '' : String(newNo++);
          shown++;
          rows.push(
            <div
              className={`diff-line diff-${kind}`}
              key={`${h.oldStart}-${h.newStart}-${o}-${n}-${i}`}
            >
              <span className="diff-gutter mono">{o}</span>
              <span className="diff-gutter mono">{n}</span>
              <span className="diff-code mono">
                <span className="diff-sign">
                  {kind === 'add' ? '+' : kind === 'del' ? '−' : ' '}
                </span>
                {line.slice(1)}
              </span>
            </div>,
          );
        }
        return rows;
      })}
      {truncated && (
        <div className="diff-more muted">
          … diff truncated at {maxLines} lines; open the source record for the full patch
        </div>
      )}
    </div>
  );
}
