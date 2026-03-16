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

/** Render an SVG string to a PNG Uint8Array (800x800). */
export async function svgToPng(svg: string): Promise<Uint8Array> {
	await ensureInit();
	const resvg = new Resvg(svg, {
		fitTo: { mode: 'width', value: 800 },
	});
	const rendered = resvg.render();
	return rendered.asPng();
}
