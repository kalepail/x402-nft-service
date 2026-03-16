import { mulberry32, noise2D } from './rng';

const SIZE = 800;
const TAU = Math.PI * 2;

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

function svgWrap(bg: string, content: string): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}"><rect width="${SIZE}" height="${SIZE}" fill="${bg}"/>${content}</svg>`;
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

export function cliffordAttractor(seed: number): string {
	const rng = mulberry32(seed);
	const base = KNOWN_GOOD_PARAMS[Math.floor(rng() * KNOWN_GOOD_PARAMS.length)];
	const jitter = 0.15;
	const a = base[0] + (rng() - 0.5) * jitter;
	const b = base[1] + (rng() - 0.5) * jitter;
	const c = base[2] + (rng() - 0.5) * jitter;
	const d = base[3] + (rng() - 0.5) * jitter;
	const hueBase = rng() * 360;
	const ITERS = 500_000;
	const GRID = 400; // density grid resolution
	const PX = SIZE / GRID; // pixel size

	// Iterate and accumulate density
	const density = new Float32Array(GRID * GRID);
	let x = 0.1,
		y = 0.1;
	let minX = Infinity,
		maxX = -Infinity,
		minY = Infinity,
		maxY = -Infinity;

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

	// Find max for normalization
	let maxD = 0;
	for (let i = 0; i < density.length; i++) {
		if (density[i] > maxD) maxD = density[i];
	}

	// Render: each occupied cell becomes a small colored rect
	// Color mapped by density: sparse = cool blue/purple, dense = hot pink/white
	let rects = '';
	const logMax = Math.log(maxD + 1);
	for (let gy = 0; gy < GRID; gy++) {
		for (let gx = 0; gx < GRID; gx++) {
			const d = density[gy * GRID + gx];
			if (d === 0) continue;
			const t = Math.log(d + 1) / logMax; // 0..1, log-scaled
			// Color ramp: dark blue → cyan → green → yellow → hot pink
			const hue = (hueBase + 260 - t * 260) % 360;
			const sat = 70 + t * 25;
			const lit = 15 + t * 65;
			const sx = gx * PX;
			const sy = gy * PX;
			rects += `<rect x="${sx.toFixed(1)}" y="${sy.toFixed(1)}" width="${PX}" height="${PX}" fill="${hsl(hue, sat, lit)}"/>`;
		}
	}

	return svgWrap('#0a0a0e', rects);
}

// ─── 2. Flow Field ("Neural Flow") ─────────────────────────────────────────

export function flowField(seed: number): string {
	const rng = mulberry32(seed);
	const noiseSeed = (seed * 7919) | 0;
	const scale = 0.005 + rng() * 0.01;
	const turbulence = 2 + rng() * 3;
	const colors = palette(rng, 5);
	const PARTICLES = 600;
	const STEPS = 120;
	const STEP_SIZE = 2;

	let out = '';
	for (let p = 0; p < PARTICLES; p++) {
		let px = rng() * SIZE;
		let py = rng() * SIZE;
		const pts: string[] = [`M${px.toFixed(1)} ${py.toFixed(1)}`];

		for (let s = 0; s < STEPS; s++) {
			const n1 = noise2D(px * scale, py * scale, noiseSeed);
			const n2 = noise2D(px * scale * 2, py * scale * 2, noiseSeed + 1000);
			const angle = (n1 + n2 * 0.5) * Math.PI * turbulence;
			px += Math.cos(angle) * STEP_SIZE;
			py += Math.sin(angle) * STEP_SIZE;
			if (px < -10 || px > SIZE + 10 || py < -10 || py > SIZE + 10) break;
			pts.push(`L${px.toFixed(1)} ${py.toFixed(1)}`);
		}
		if (pts.length < 4) continue;

		const ci = p % colors.length;
		const width = 1.0 + rng() * 1.5;
		out += `<path d="${pts.join(' ')}" fill="none" stroke="${colors[ci]}" stroke-width="${width.toFixed(1)}" stroke-opacity="0.7" stroke-linecap="round"/>`;
	}

	return svgWrap('#080810', out);
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

export function hyperbolicTessellation(seed: number): string {
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
	const MAX_DEPTH = 4;
	const R = SIZE * 0.45;
	const O = SIZE / 2;

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
	out += `<circle cx="${O}" cy="${O}" r="${R + 2}" fill="url(#dg)" stroke="${hsl(hueBase, 40, 30)}" stroke-width="1.5"/>`;

	for (const { verts, depth } of polys) {
		const first = verts[0];
		let d = `M${(O + first[0] * R).toFixed(1)} ${(O + first[1] * R).toFixed(1)}`;
		for (let i = 1; i <= verts.length; i++) {
			const prev = verts[(i - 1) % verts.length];
			const curr = verts[i % verts.length];
			d += geodesicArcSVG(prev, curr, R, O);
		}
		d += 'Z';
		const fillOpacity = 0.65 - depth * 0.06;
		const strokeColor = hsl((hueBase + depth * 55 + 20) % 360, 60, 75);
		out += `<path d="${d}" fill="${depthColors[depth % depthColors.length]}" fill-opacity="${fillOpacity.toFixed(2)}" stroke="${strokeColor}" stroke-width="0.8" stroke-opacity="0.85"/>`;
	}

	return svgWrap('#06060e', out);
}

// ─── 4. Moire Interference ("Phase Shift") ─────────────────────────────────

export function moireInterference(seed: number): string {
	const rng = mulberry32(seed);
	const hueBase = rng() * 360;
	let out = '';
	const mid = SIZE / 2;

	// Two sets of concentric circles — offset centers create moire fringes
	const offset = 70 + rng() * 100;
	const offsetAngle = rng() * TAU;
	const centers: [number, number][] = [
		[mid + Math.cos(offsetAngle) * offset * 0.5, mid + Math.sin(offsetAngle) * offset * 0.5],
		[mid - Math.cos(offsetAngle) * offset * 0.5, mid - Math.sin(offsetAngle) * offset * 0.5],
	];

	const spacing = 5 + rng() * 3;
	const maxR = SIZE * 0.8;

	// Use just two circle layers for cleaner interference
	const hues = [(hueBase) % 360, (hueBase + 180) % 360];
	for (let layer = 0; layer < 2; layer++) {
		const [cx, cy] = centers[layer];
		const rings = Math.floor(maxR / spacing);

		for (let i = 1; i <= rings; i++) {
			const r = i * spacing;
			out += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="none" stroke="${hsl(hues[layer], 90, 75)}" stroke-width="2.2" stroke-opacity="0.8"/>`;
		}
	}

	return svgWrap('#000000', out);
}

// ─── Registry ───────────────────────────────────────────────────────────────

export const STYLES = {
	attractor: { name: 'Strange Attractor', fn: cliffordAttractor, description: 'De Jong strange attractor -- chaotic orbital trajectories' },
	flow: { name: 'Neural Flow', fn: flowField, description: 'Perlin noise flow field -- organic particle traces' },
	hyperbolic: { name: 'Infinite Mirror', fn: hyperbolicTessellation, description: 'Poincare disk hyperbolic tessellation -- non-Euclidean geometry' },
	moire: { name: 'Phase Shift', fn: moireInterference, description: 'Warped moire interference -- optical illusion patterns' },
} as const;

export type StyleKey = keyof typeof STYLES;
export const STYLE_KEYS = Object.keys(STYLES) as StyleKey[];
