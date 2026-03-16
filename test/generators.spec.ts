import { describe, it, expect } from 'vitest';
import { cliffordAttractor, flowField, hyperbolicTessellation, moireInterference, STYLES, STYLE_KEYS } from '../src/generators';

describe('generative art', () => {
	it('all styles are registered', () => {
		expect(STYLE_KEYS).toContain('attractor');
		expect(STYLE_KEYS).toContain('flow');
		expect(STYLE_KEYS).toContain('hyperbolic');
		expect(STYLE_KEYS).toContain('moire');
		expect(STYLE_KEYS.length).toBe(4);
	});

	for (const key of STYLE_KEYS) {
		describe(key, () => {
			it('produces valid SVG', () => {
				const svg = STYLES[key].fn(42);
				expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
				expect(svg).toMatch(/<\/svg>$/);
				expect(svg.length).toBeGreaterThan(1000);
			});

			it('is deterministic (same seed → same output)', () => {
				const a = STYLES[key].fn(12345);
				const b = STYLES[key].fn(12345);
				expect(a).toBe(b);
			});

			it('varies with different seeds', () => {
				const a = STYLES[key].fn(1);
				const b = STYLES[key].fn(2);
				expect(a).not.toBe(b);
			});

			it('generates quickly (< 500ms)', () => {
				const start = performance.now();
				STYLES[key].fn(99);
				const elapsed = performance.now() - start;
				expect(elapsed).toBeLessThan(500);
			});
		});
	}
});
