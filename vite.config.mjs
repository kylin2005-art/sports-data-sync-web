import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  base: './',
  plugins: [vue()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  worker: {
    rolldownOptions: { output: { entryFileNames: 'ride-map-worker.js' } },
  },
  build: {
    outDir: 'public/ui',
    emptyOutDir: true,
    copyPublicDir: false,
    cssCodeSplit: true,
    lib: {
      entry: { 'workspace-ui': 'ui/main.js', 'ride-map': 'ui/ride-map.js' },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
  },
});
