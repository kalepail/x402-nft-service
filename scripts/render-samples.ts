import { STYLES } from '../src/generators';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';

async function main() {
	const wasmBytes = readFileSync('node_modules/@resvg/resvg-wasm/index_bg.wasm');
	await initWasm(wasmBytes);

	const dir = '/tmp/nft-seeds';
	mkdirSync(dir, { recursive: true });

	for (const [style, { fn }] of Object.entries(STYLES)) {
		for (const seed of [42, 777, 12345]) {
			const svg = fn(seed);
			const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: 800 } });
			const png = resvg.render().asPng();
			writeFileSync(`${dir}/${style}_${seed}.png`, png);
			console.log(`${style}_${seed}.png  ${png.length} bytes`);
		}
	}
}

main().catch(console.error);
