import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Dev-server proxy to the running daemon, so `pnpm --filter @salidium/ui dev` shows local sessions
 * with hot reload instead of needing a full build for every visual change. The daemon rejects a
 * cross-origin `Origin`, so the header is stripped on the way through — the request has already
 * crossed into a loopback-only process by then, and the bearer token still gates it.
 */
function daemon(): { port: number; token: string } | undefined {
  try {
    const home = process.env.SALIDIUM_HOME ?? join(homedir(), '.salidium');
    return JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as {
      port: number;
      token: string;
    };
  } catch {
    return undefined;
  }
}

const d = daemon();
const proxy = d
  ? {
      target: `http://127.0.0.1:${d.port}`,
      changeOrigin: true,
      configure: (p: {
        on: (e: string, fn: (req: { removeHeader(n: string): void }) => void) => void;
      }) => {
        p.on('proxyReq', (req) => {
          req.removeHeader('origin');
        });
      },
    }
  : undefined;

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['development'] },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, target: 'es2022' },
  server: {
    port: 5173,
    strictPort: true,
    proxy: proxy ? { '/api': proxy, '/hooks': proxy } : undefined,
  },
});
