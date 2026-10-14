/**
 * Import for its side effects, from any test file that waits on real timers or
 * real async work (waitFor / findBy*, a debounce, a fetch chain).
 *
 * These suites pass in ~10 s alone, but a loaded CI runner (several jobs or
 * workers sharing cores) stretches every wait by 5-10x: a 300 ms search
 * debounce, a 100-row render and Testing Library's 1 s waitFor default all
 * landed over their limits in a 6-way parallel run. The limits below only
 * change how long a *genuinely* stuck test takes to fail, never what passes.
 * Cost that is fixable (role queries over a 100-row sheet, say) is fixed in
 * the test; this file is the headroom for what is not.
 */
import { vi } from 'vitest';
import { configure } from '@testing-library/react';

// Vitest's 5 s default is a test's whole budget; give a slow runner 6x.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
// Testing Library's waitFor / findBy* default is 1 s.
configure({ asyncUtilTimeout: 10_000 });
