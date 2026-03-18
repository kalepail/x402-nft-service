import { mulberry32, noise2D } from './rng';

const DEFAULT_SIZE = 800;
const TAU = Math.PI * 2;

/** Clamp requested size to valid range. */
export function clampSize(s: number | undefined): number {
	if (!s || isNaN(s)) return DEFAULT_SIZE;
	return Math.max(32, Math.min(DEFAULT_SIZE, Math.round(s)));
}

// ─── Color helpers ──────────────────────────────────────────────────────────

function hsl(h: number, s: number, l: number, a = 1): string {
	return a < 1 ? `hsla(${h | 0},${s | 0}%,${l | 0}%,${a})` : `hsl(${h | 0},${s | 0}%,${l | 0}%)`;
}

/** Generate a vibrant palette for dark backgrounds. */
function palette(rng: () => number, count: number): string[] {
	const base = rng() * 360;
	const spread = 30 + rng() * 60; // 30-90 degree spread per step
	return Array.from({ length: count }, (_, i) => hsl((base + i * spread) % 360, 80 + rng() * 15, 62 + rng() * 16));
}

function svgWrap(bg: string, content: string, size: number): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="${bg}"/>${content}</svg>`;
}

/** Coordinate formatter — use integers for small sizes, 1 decimal for large. */
function fmt(v: number, size: number): string {
	return size <= 200 ? String(Math.round(v)) : v.toFixed(1);
}

// ─── 1. De Jong Attractor ("Strange Attractor") ────────────────────────────
// Uses curated parameter sets that reliably produce rich structure,
// with auto-centering and auto-scaling so the output always fills the canvas.

const KNOWN_GOOD_PARAMS: [number, number, number, number][] = [
	[-2.24, 0.43, -0.65, -2.43],
	[2.01, -2.53, 1.61, -0.33],
	[-2.7, -0.09, -0.86, -2.2],
	[-0.827, -1.637, 1.659, -0.943],
	[-1.4, 1.6, 1.0, 0.7],
	[1.7, 1.7, 0.6, 1.2],
	[-1.24, -1.25, -1.81, -1.91],
	[2.75, -1.12, -1.37, 2.39],
	[-2.0, -2.0, -1.2, 2.0],
	[1.41, 1.56, 1.4, -6.56],
	[-2.5, -2.4, 2.1, 0.7],
	[1.1, -1.32, 2.04, 1.54],
];

export function cliffordAttractor(seed: number, size = DEFAULT_SIZE): string {
	const rng = mulberry32(seed);
	const hueBase = rng() * 360;
	const scale = size / DEFAULT_SIZE;
	const GRID = Math.max(20, Math.round(200 * scale)); // density grid resolution
	const ITERS = Math.max(5_000, Math.round(200_000 * scale * scale)); // scale with area
	const PX = size / GRID; // pixel size
	const MIN_FILLED_CELLS = Math.max(50, Math.round(500 * scale * scale));

	// Try parameter sets until we find one that fills enough cells
	let density: Float32Array;
	let maxD: number;
	let attempts = 0;

	do {
		const baseIdx = (Math.floor(rng() * KNOWN_GOOD_PARAMS.length) + attempts) % KNOWN_GOOD_PARAMS.length;
		const base = KNOWN_GOOD_PARAMS[baseIdx];
		// Reduce jitter on retries to stay closer to known-good params
		const jitter = attempts === 0 ? 0.15 : 0.02;
		const a = base[0] + (rng() - 0.5) * jitter;
		const b = base[1] + (rng() - 0.5) * jitter;
		const c = base[2] + (rng() - 0.5) * jitter;
		const d = base[3] + (rng() - 0.5) * jitter;

		density = new Float32Array(GRID * GRID);
		let x = 0.1, y = 0.1;
		let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

		// First pass: find bounds
		for (let i = 0; i < 10000; i++) {
			const nx = Math.sin(a * y) - Math.cos(b * x);
			const ny = Math.sin(c * x) - Math.cos(d * y);
			x = nx;
			y = ny;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
		const rangeX = maxX - minX || 1;
		const rangeY = maxY - minY || 1;
		const pad = 0.05;

		// Second pass: accumulate density
		x = 0.1;
		y = 0.1;
		for (let i = 0; i < ITERS; i++) {
			const nx = Math.sin(a * y) - Math.cos(b * x);
			const ny = Math.sin(c * x) - Math.cos(d * y);
			x = nx;
			y = ny;
			const gx = Math.floor(((x - minX) / rangeX * (1 - pad * 2) + pad) * GRID);
			const gy = Math.floor(((y - minY) / rangeY * (1 - pad * 2) + pad) * GRID);
			if (gx >= 0 && gx < GRID && gy >= 0 && gy < GRID) {
				density[gy * GRID + gx]++;
			}
		}

		maxD = 0;
		for (let i = 0; i < density.length; i++) {
			if (density[i] > maxD) maxD = density[i];
		}

		// Count filled cells
		let filled = 0;
		for (let i = 0; i < density.length; i++) {
			if (density[i] > 0) filled++;
		}

		attempts++;
		if (filled >= MIN_FILLED_CELLS || attempts >= KNOWN_GOOD_PARAMS.length) break;
	} while (true);

	// Render: each occupied cell becomes a small colored rect
	let rects = '';
	const logMax = Math.log(maxD + 1);
	const pw = size <= 200 ? Math.round(PX) : +PX.toFixed(1);
	for (let gy = 0; gy < GRID; gy++) {
		for (let gx = 0; gx < GRID; gx++) {
			const d = density[gy * GRID + gx];
			if (d === 0) continue;
			const t = Math.log(d + 1) / logMax; // 0..1, log-scaled
			const hue = (hueBase + 260 - t * 260) % 360;
			const sat = 70 + t * 25;
			const lit = 15 + t * 65;
			const sx = gx * PX;
			const sy = gy * PX;
			rects += `<rect x="${fmt(sx, size)}" y="${fmt(sy, size)}" width="${pw}" height="${pw}" fill="${hsl(hue, sat, lit)}"/>`;
		}
	}

	return svgWrap('#0a0a0e', rects, size);
}

// ─── 2. Flow Field ("Neural Flow") ─────────────────────────────────────────

export function flowField(seed: number, size = DEFAULT_SIZE): string {
	const rng = mulberry32(seed);
	const noiseSeed = (seed * 7919) | 0;
	const sc = size / DEFAULT_SIZE;
	const noiseScale = 0.005 + rng() * 0.01;
	const turbulence = 2 + rng() * 3;
	const colors = palette(rng, 5);
	const PARTICLES = Math.max(30, Math.round(600 * sc * sc));
	const STEPS = Math.max(20, Math.round(120 * sc));
	const STEP_SIZE = 2 * sc;

	let out = '';
	for (let p = 0; p < PARTICLES; p++) {
		let px = rng() * size;
		let py = rng() * size;
		const pts: string[] = [`M${fmt(px, size)} ${fmt(py, size)}`];

		for (let s = 0; s < STEPS; s++) {
			// Scale coordinates back to 800-space for consistent noise
			const nx = px / sc, ny = py / sc;
			const n1 = noise2D(nx * noiseScale, ny * noiseScale, noiseSeed);
			const n2 = noise2D(nx * noiseScale * 2, ny * noiseScale * 2, noiseSeed + 1000);
			const angle = (n1 + n2 * 0.5) * Math.PI * turbulence;
			px += Math.cos(angle) * STEP_SIZE;
			py += Math.sin(angle) * STEP_SIZE;
			if (px < -10 || px > size + 10 || py < -10 || py > size + 10) break;
			pts.push(`L${fmt(px, size)} ${fmt(py, size)}`);
		}
		if (pts.length < 4) continue;

		const ci = p % colors.length;
		const width = (1.0 + rng() * 1.5) * sc;
		out += `<path d="${pts.join(' ')}" fill="none" stroke="${colors[ci]}" stroke-width="${fmt(width, size)}" stroke-opacity="0.7" stroke-linecap="round"/>`;
	}

	return svgWrap('#080810', out, size);
}

// ─── 3. Hyperbolic Tessellation ("Infinite Mirror") ────────────────────────

type C = [number, number]; // complex number [re, im]

function cAbs(a: C): number {
	return Math.sqrt(a[0] * a[0] + a[1] * a[1]);
}
function cSub(a: C, b: C): C {
	return [a[0] - b[0], a[1] - b[1]];
}
function cAdd(a: C, b: C): C {
	return [a[0] + b[0], a[1] + b[1]];
}
function cScale(a: C, s: number): C {
	return [a[0] * s, a[1] * s];
}
function cDiv(a: C, b: C): C {
	const d = b[0] * b[0] + b[1] * b[1];
	return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
}

/** Reflect z through the geodesic (Poincare disk) between p1 and p2. */
function reflectThroughGeodesic(z: C, p1: C, p2: C): C {
	const cross = p1[0] * p2[1] - p1[1] * p2[0];
	if (Math.abs(cross) < 1e-10) {
		const dx = p2[0] - p1[0],
			dy = p2[1] - p1[1];
		const len2 = dx * dx + dy * dy;
		const dot = ((z[0] - p1[0]) * dx + (z[1] - p1[1]) * dy) / len2;
		return [2 * (p1[0] + dot * dx) - z[0], 2 * (p1[1] + dot * dy) - z[1]];
	}
	const d = 2 * cross;
	const s1 = p1[0] * p1[0] + p1[1] * p1[1];
	const s2 = p2[0] * p2[0] + p2[1] * p2[1];
	const cx = ((s1 + 1) * p2[1] - (s2 + 1) * p1[1]) / d;
	const cy = ((s2 + 1) * p1[0] - (s1 + 1) * p2[0]) / d;
	const r2 = (p1[0] - cx) ** 2 + (p1[1] - cy) ** 2;
	const dz: C = [z[0] - cx, z[1] - cy];
	const dist2 = dz[0] * dz[0] + dz[1] * dz[1];
	return [cx + (r2 * dz[0]) / dist2, cy + (r2 * dz[1]) / dist2];
}

function geodesicArcSVG(z1: C, z2: C, s: number, o: number): string {
	const cross = z1[0] * z2[1] - z1[1] * z2[0];
	const x2 = o + z2[0] * s,
		y2 = o + z2[1] * s;

	if (Math.abs(cross) < 1e-6) {
		return `L${x2.toFixed(1)} ${y2.toFixed(1)}`;
	}
	const d = 2 * cross;
	const s1 = z1[0] * z1[0] + z1[1] * z1[1];
	const s2 = z2[0] * z2[0] + z2[1] * z2[1];
	const cx = ((s1 + 1) * z2[1] - (s2 + 1) * z1[1]) / d;
	const cy = ((s2 + 1) * z1[0] - (s1 + 1) * z2[0]) / d;
	const r = Math.sqrt((z1[0] - cx) ** 2 + (z1[1] - cy) ** 2) * s;
	const sweep = cross > 0 ? 1 : 0;
	return `A${r.toFixed(1)} ${r.toFixed(1)} 0 0 ${sweep} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}

export function hyperbolicTessellation(seed: number, size = DEFAULT_SIZE): string {
	const rng = mulberry32(seed);
	const pairs: [number, number][] = [
		[5, 4],
		[7, 3],
		[4, 5],
		[3, 8],
		[6, 4],
		[4, 6],
		[5, 5],
		[8, 3],
	];
	const [p, q] = pairs[Math.floor(rng() * pairs.length)];
	const hueBase = rng() * 360;
	const rotation = rng() * TAU;
	const sc = size / DEFAULT_SIZE;
	const MAX_DEPTH = sc < 0.25 ? 2 : sc < 0.5 ? 3 : 4;
	const R = size * 0.45;
	const O = size / 2;

	// Jewel-tone palette — high saturation, moderate-high lightness
	const depthColors = Array.from({ length: 6 }, (_, i) => hsl((hueBase + i * 55) % 360, 75 + rng() * 20, 50 + i * 5));

	const cosA = Math.cos(Math.PI * (1 / p + 1 / q));
	const cosB = Math.cos(Math.PI * (1 / p - 1 / q));
	const vr = Math.sqrt(cosA / cosB);

	function centralVerts(): C[] {
		return Array.from({ length: p }, (_, k) => {
			const angle = (TAU * k) / p + rotation;
			return [vr * Math.cos(angle), vr * Math.sin(angle)] as C;
		});
	}

	const polys: { verts: C[]; depth: number }[] = [];
	const visited = new Set<string>();

	function polyKey(verts: C[]): string {
		const cx = verts.reduce((s, v) => s + v[0], 0) / verts.length;
		const cy = verts.reduce((s, v) => s + v[1], 0) / verts.length;
		return `${(cx * 1000) | 0},${(cy * 1000) | 0}`;
	}

	function addPoly(verts: C[], depth: number) {
		const key = polyKey(verts);
		if (visited.has(key)) return;
		const center = cScale(verts.reduce((a, v) => cAdd(a, v), [0, 0] as C), 1 / verts.length);
		if (cAbs(center) > 0.97) return;
		visited.add(key);
		polys.push({ verts, depth });
		if (depth >= MAX_DEPTH) return;
		for (let e = 0; e < verts.length; e++) {
			const e2 = (e + 1) % verts.length;
			const reflected = verts.map((v) => reflectThroughGeodesic(v, verts[e], verts[e2]));
			addPoly(reflected, depth + 1);
		}
	}

	addPoly(centralVerts(), 0);

	// Draw — outer ring glow + disk background
	let out = '';
	out += `<defs><radialGradient id="dg"><stop offset="0%" stop-color="#181830"/><stop offset="85%" stop-color="#0e0e1c"/><stop offset="100%" stop-color="#06060e"/></radialGradient></defs>`;
	out += `<circle cx="${O}" cy="${O}" r="${R + 2}" fill="url(#dg)" stroke="${hsl(hueBase, 40, 30)}" stroke-width="${fmt(1.5 * sc, size)}"/>`;

	for (const { verts, depth } of polys) {
		const first = verts[0];
		let d = `M${fmt(O + first[0] * R, size)} ${fmt(O + first[1] * R, size)}`;
		for (let i = 1; i <= verts.length; i++) {
			const prev = verts[(i - 1) % verts.length];
			const curr = verts[i % verts.length];
			d += geodesicArcSVG(prev, curr, R, O);
		}
		d += 'Z';
		const fillOpacity = 0.65 - depth * 0.06;
		const strokeColor = hsl((hueBase + depth * 55 + 20) % 360, 60, 75);
		out += `<path d="${d}" fill="${depthColors[depth % depthColors.length]}" fill-opacity="${fillOpacity.toFixed(2)}" stroke="${strokeColor}" stroke-width="${fmt(0.8 * sc, size)}" stroke-opacity="0.85"/>`;
	}

	return svgWrap('#06060e', out, size);
}

// ─── 4. Moire Interference ("Phase Shift") ─────────────────────────────────

export function moireInterference(seed: number, size = DEFAULT_SIZE): string {
	const rng = mulberry32(seed);
	const hueBase = rng() * 360;
	let out = '';
	const sc = size / DEFAULT_SIZE;
	const mid = size / 2;

	// Two sets of concentric circles — offset centers create moire fringes
	const offset = (70 + rng() * 100) * sc;
	const offsetAngle = rng() * TAU;
	const centers: [number, number][] = [
		[mid + Math.cos(offsetAngle) * offset * 0.5, mid + Math.sin(offsetAngle) * offset * 0.5],
		[mid - Math.cos(offsetAngle) * offset * 0.5, mid - Math.sin(offsetAngle) * offset * 0.5],
	];

	// Increase spacing for small sizes to keep ring count reasonable
	const baseSpacing = 5 + rng() * 3;
	const spacing = sc < 0.25 ? baseSpacing * 3 : sc < 0.5 ? baseSpacing * 2 : baseSpacing;
	const maxR = size * 0.8;

	// Use just two circle layers for cleaner interference
	const hues = [(hueBase) % 360, (hueBase + 180) % 360];
	const sw = fmt(2.2 * sc, size);
	for (let layer = 0; layer < 2; layer++) {
		const [cx, cy] = centers[layer];
		const rings = Math.floor(maxR / spacing);

		for (let i = 1; i <= rings; i++) {
			const r = i * spacing;
			out += `<circle cx="${fmt(cx, size)}" cy="${fmt(cy, size)}" r="${fmt(r, size)}" fill="none" stroke="${hsl(hues[layer], 90, 75)}" stroke-width="${sw}" stroke-opacity="0.8"/>`;
		}
	}

	return svgWrap('#000000', out, size);
}

// ─── Registry ───────────────────────────────────────────────────────────────

export const STYLES: Record<string, { name: string; fn: (seed: number, size?: number) => string; description: string }> = {
	attractor: { name: 'Strange Attractor', fn: cliffordAttractor, description: 'De Jong strange attractor -- chaotic orbital trajectories' },
	flow: { name: 'Neural Flow', fn: flowField, description: 'Perlin noise flow field -- organic particle traces' },
	hyperbolic: { name: 'Infinite Mirror', fn: hyperbolicTessellation, description: 'Poincare disk hyperbolic tessellation -- non-Euclidean geometry' },
	moire: { name: 'Phase Shift', fn: moireInterference, description: 'Warped moire interference -- optical illusion patterns' },
};

export type StyleKey = keyof typeof STYLES;
export const STYLE_KEYS = Object.keys(STYLES) as StyleKey[];
