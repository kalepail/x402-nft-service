/**
 * Mulberry32 — fast, seedable 32-bit PRNG.
 * Returns a function that yields floats in [0, 1).
 */
export function mulberry32(seed: number): () => number {
	return function () {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Simple 2D value noise from integer hash. */
export function noise2D(x: number, y: number, seed: number): number {
	const ix = Math.floor(x),
		iy = Math.floor(y);
	const fx = x - ix,
		fy = y - iy;
	const sx = fx * fx * (3 - 2 * fx);
	const sy = fy * fy * (3 - 2 * fy);

	const hash = (hx: number, hy: number) => {
		let h = ((hx * 374761393 + hy * 668265263 + seed * 1274126177) | 0) >>> 0;
		h = (((h ^ (h >> 13)) >>> 0) * 1274126177) >>> 0;
		return (h & 0x7fffffff) / 0x7fffffff;
	};

	const n00 = hash(ix, iy);
	const n10 = hash(ix + 1, iy);
	const n01 = hash(ix, iy + 1);
	const n11 = hash(ix + 1, iy + 1);

	const nx0 = n00 + sx * (n10 - n00);
	const nx1 = n01 + sx * (n11 - n01);
	return nx0 + sy * (nx1 - nx0);
}
