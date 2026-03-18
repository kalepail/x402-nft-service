import { initWasm, Resvg } from '@resvg/resvg-wasm';
// @ts-expect-error — wrangler bundles .wasm imports correctly
import wasmModule from '@resvg/resvg-wasm/index_bg.wasm';

let ready: Promise<void> | null = null;

function ensureInit(): Promise<void> {
	if (!ready) {
		ready = initWasm(wasmModule);
	}
	return ready;
}

/** Render an SVG string to a PNG Uint8Array at the SVG's native size. */
export async function svgToPng(svg: string): Promise<Uint8Array<ArrayBuffer>> {
	await ensureInit();
	const resvg = new Resvg(svg);
	const rendered = resvg.render();
	return rendered.asPng() as Uint8Array<ArrayBuffer>;
}
