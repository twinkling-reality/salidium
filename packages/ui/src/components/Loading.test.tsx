import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Loading } from './Loading.tsx';

describe('Loading', () => {
  it('uses the shared animated mark and accessible label for panel waits', () => {
    const html = renderToStaticMarkup(<Loading label="Loading model settings" block />);

    expect(html).toContain('class="loading is-sm is-block"');
    expect(html).toContain('role="status"');
    expect(html).toContain('Loading model settings');
    expect(html.match(/class="orb-dot"/g)).toHaveLength(3);
  });
});
