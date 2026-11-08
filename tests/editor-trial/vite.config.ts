// Builds the trial screen in place of the app's page. Run from the repository root. Output is
// outside `dist/` so that a normal build and this one never pick up each other's files.
import { mergeConfig } from 'vite';
import base from '../../vite.config';

export default mergeConfig(base, {
  root: 'tests/editor-trial',
  build: {
    // Relative to `root`.
    outDir: '../../test-results-native/editor-trial-dist',
    emptyOutDir: true,
  },
});
