import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

/** The add-on's version is the hub's version; Home Assistant offers an update when it changes. */
const version = /^version:\s*"?([0-9][^"\s]*)"?/m.exec(readFileSync(new URL('../hjem-hub/config.yaml', import.meta.url), 'utf8'))?.[1];
if (!version) throw new Error('hjem-hub/config.yaml has no version.');

export default defineConfig({
  define: { __HUB_VERSION__: JSON.stringify(version) },
  build: {
    ssr: 'hub/main.ts',
    outDir: 'hjem-hub/dist',
    emptyOutDir: true,
    target: 'node22',
    rollupOptions: { output: { entryFileNames: 'hub.mjs' } },
  },
  // One file with everything in it, so the image needs no node_modules.
  ssr: { noExternal: true },
});
