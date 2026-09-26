import { defineConfig } from 'vite';

// base: './' keeps every asset path relative, so the build works on GitHub Pages
// (any repo name) or when opened from a sub-directory.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
