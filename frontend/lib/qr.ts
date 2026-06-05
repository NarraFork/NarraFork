const QR_L_BLOCKS: Record<number, { data: number[]; ecc: number; align: number[] }> = {
	1: { data: [19], ecc: 7, align: [] },
	2: { data: [34], ecc: 10, align: [6, 18] },
	3: { data: [55], ecc: 15, align: [6, 22] },
	4: { data: [80], ecc: 20, align: [6, 26] },
	5: { data: [108], ecc: 26, align: [6, 30] },
	6: { data: [68, 68], ecc: 18, align: [6, 34] },
	7: { data: [78, 78], ecc: 20, align: [6, 22, 38] },
	8: { data: [97, 97], ecc: 24, align: [6, 24, 42] },
	9: { data: [116, 116], ecc: 30, align: [6, 26, 46] },
	10: { data: [68, 68, 69, 69], ecc: 18, align: [6, 28, 50] },
};

const GF_EXP = new Array<number>(512);
const GF_LOG = new Array<number>(256);
let gfReady = false;

function initGF(): void {
	if (gfReady) return;
	let x = 1;
	for (let i = 0; i < 255; i++) {
		GF_EXP[i] = x;
		GF_LOG[x] = i;
		x <<= 1;
		if (x & 0x100) x ^= 0x11d;
	}
	for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
	gfReady = true;
}

function gfMul(a: number, b: number): number {
	if (a === 0 || b === 0) return 0;
	return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGenerator(degree: number): number[] {
	initGF();
	let poly = [1];
	for (let i = 0; i < degree; i++) {
		const next = new Array<number>(poly.length + 1).fill(0);
		for (let j = 0; j < poly.length; j++) {
			next[j] ^= poly[j];
			next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
		}
		poly = next;
	}
	return poly.slice(1);
}

function rsRemainder(data: number[], degree: number): number[] {
	const gen = rsGenerator(degree);
	const rem = new Array<number>(degree).fill(0);
	for (const value of data) {
		const factor = value ^ (rem.shift() ?? 0);
		rem.push(0);
		if (factor === 0) continue;
		for (let i = 0; i < degree; i++) rem[i] ^= gfMul(gen[i], factor);
	}
	return rem;
}

class BitBuffer {
	private bits: number[] = [];

	append(value: number, length: number): void {
		for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
	}

	appendBytes(bytes: Uint8Array): void {
		for (const b of bytes) this.append(b, 8);
	}

	get length(): number {
		return this.bits.length;
	}

	toCodewords(): number[] {
		const out: number[] = [];
		for (let i = 0; i < this.bits.length; i += 8) {
			let value = 0;
			for (let j = 0; j < 8; j++) value = (value << 1) | (this.bits[i + j] ?? 0);
			out.push(value);
		}
		return out;
	}
}

function makeDataCodewords(text: string, version: number, capacity: number): number[] {
	const bytes = new TextEncoder().encode(text);
	const countBits = version < 10 ? 8 : 16;
	if (bytes.length >= 1 << countBits) throw new Error("QR payload is too long");
	const bb = new BitBuffer();
	bb.append(0b0100, 4);
	bb.append(bytes.length, countBits);
	bb.appendBytes(bytes);
	const capacityBits = capacity * 8;
	if (bb.length > capacityBits) throw new Error("QR payload is too long");
	bb.append(0, Math.min(4, capacityBits - bb.length));
	while (bb.length % 8 !== 0) bb.append(0, 1);
	const data = bb.toCodewords();
	for (let pad = 0xec; data.length < capacity; pad = pad === 0xec ? 0x11 : 0xec) data.push(pad);
	return data;
}

function interleaveBlocks(data: number[], blockSizes: number[], eccLen: number): number[] {
	const blocks: number[][] = [];
	let offset = 0;
	for (const size of blockSizes) {
		blocks.push(data.slice(offset, offset + size));
		offset += size;
	}
	const eccBlocks = blocks.map((block) => rsRemainder(block, eccLen));
	const out: number[] = [];
	const maxDataLen = Math.max(...blockSizes);
	for (let i = 0; i < maxDataLen; i++) {
		for (const block of blocks) if (i < block.length) out.push(block[i]);
	}
	for (let i = 0; i < eccLen; i++) {
		for (const block of eccBlocks) out.push(block[i]);
	}
	return out;
}

function makeMatrix(size: number): { modules: boolean[][]; reserved: boolean[][] } {
	return {
		modules: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
		reserved: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
	};
}

function setModule(
	modules: boolean[][],
	reserved: boolean[][],
	row: number,
	col: number,
	dark: boolean,
): void {
	if (row < 0 || col < 0 || row >= modules.length || col >= modules.length) return;
	modules[row][col] = dark;
	reserved[row][col] = true;
}

function drawFinder(modules: boolean[][], reserved: boolean[][], row: number, col: number): void {
	for (let y = -1; y <= 7; y++) {
		for (let x = -1; x <= 7; x++) {
			const r = row + y;
			const c = col + x;
			if (r < 0 || c < 0 || r >= modules.length || c >= modules.length) continue;
			const dark =
				x >= 0 &&
				x <= 6 &&
				y >= 0 &&
				y <= 6 &&
				(x === 0 || x === 6 || y === 0 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4));
			setModule(modules, reserved, r, c, dark);
		}
	}
}

function drawAlignment(
	modules: boolean[][],
	reserved: boolean[][],
	row: number,
	col: number,
): void {
	for (let y = -2; y <= 2; y++) {
		for (let x = -2; x <= 2; x++) {
			const dark = Math.max(Math.abs(x), Math.abs(y)) !== 1;
			setModule(modules, reserved, row + y, col + x, dark);
		}
	}
}

function drawFunctionPatterns(
	modules: boolean[][],
	reserved: boolean[][],
	version: number,
	align: number[],
): void {
	const size = modules.length;
	drawFinder(modules, reserved, 0, 0);
	drawFinder(modules, reserved, 0, size - 7);
	drawFinder(modules, reserved, size - 7, 0);
	for (let i = 8; i < size - 8; i++) {
		setModule(modules, reserved, 6, i, i % 2 === 0);
		setModule(modules, reserved, i, 6, i % 2 === 0);
	}
	for (const r of align) {
		for (const c of align) {
			const overlapsFinder =
				(r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8);
			if (!overlapsFinder) drawAlignment(modules, reserved, r, c);
		}
	}
	setModule(modules, reserved, 4 * version + 9, 8, true);
	reserveFormatAreas(reserved);
	if (version >= 7) drawVersionBits(modules, reserved, version);
}

function reserveFormatAreas(reserved: boolean[][]): void {
	const size = reserved.length;
	for (let i = 0; i <= 8; i++) {
		if (i !== 6) {
			reserved[8][i] = true;
			reserved[i][8] = true;
		}
	}
	for (let i = 0; i < 8; i++) reserved[size - 1 - i][8] = true;
	for (let i = 0; i < 7; i++) reserved[8][size - 1 - i] = true;
}

function formatBits(): number {
	const errorCorrectionL = 1;
	const mask = 0;
	const data = (errorCorrectionL << 3) | mask;
	let bits = data << 10;
	const generator = 0x537;
	for (let i = 14; i >= 10; i--) if (((bits >>> i) & 1) !== 0) bits ^= generator << (i - 10);
	return (((data << 10) | (bits & 0x3ff)) ^ 0x5412) & 0x7fff;
}

function drawFormatBits(modules: boolean[][]): void {
	const size = modules.length;
	const bits = formatBits();
	const get = (i: number) => ((bits >>> i) & 1) !== 0;
	for (let i = 0; i <= 5; i++) modules[8][i] = get(i);
	modules[8][7] = get(6);
	modules[8][8] = get(7);
	modules[7][8] = get(8);
	for (let i = 9; i < 15; i++) modules[14 - i][8] = get(i);
	for (let i = 0; i < 8; i++) modules[size - 1 - i][8] = get(i);
	for (let i = 8; i < 15; i++) modules[8][size - 15 + i] = get(i);
	modules[8][size - 8] = true;
}

function versionBits(version: number): number {
	let rem = version;
	const generator = 0x1f25;
	for (let i = 0; i < 12; i++) {
		rem = (rem << 1) ^ (((rem >>> 11) & 1) * generator);
	}
	return (version << 12) | (rem & 0xfff);
}

function drawVersionBits(modules: boolean[][], reserved: boolean[][], version: number): void {
	const size = modules.length;
	const bits = versionBits(version);
	for (let i = 0; i < 18; i++) {
		const dark = ((bits >>> i) & 1) !== 0;
		const row = Math.floor(i / 3);
		const col = size - 11 + (i % 3);
		setModule(modules, reserved, row, col, dark);
		setModule(modules, reserved, col, row, dark);
	}
}

function drawData(modules: boolean[][], reserved: boolean[][], codewords: number[]): void {
	const size = modules.length;
	let bitIndex = 0;
	let upward = true;
	for (let right = size - 1; right >= 1; right -= 2) {
		if (right === 6) right--;
		for (let vert = 0; vert < size; vert++) {
			const row = upward ? size - 1 - vert : vert;
			for (let j = 0; j < 2; j++) {
				const col = right - j;
				if (reserved[row][col]) continue;
				const byte = codewords[bitIndex >>> 3] ?? 0;
				const bit = ((byte >>> (7 - (bitIndex & 7))) & 1) !== 0;
				const mask = (row + col) % 2 === 0;
				modules[row][col] = bit !== mask;
				bitIndex++;
			}
		}
		upward = !upward;
	}
}

function chooseVersion(text: string): number {
	const bytes = new TextEncoder().encode(text);
	for (let version = 1; version <= 10; version++) {
		const spec = QR_L_BLOCKS[version];
		const capacity = spec.data.reduce((sum, n) => sum + n, 0);
		const countBits = version < 10 ? 8 : 16;
		if (4 + countBits + bytes.length * 8 <= capacity * 8) return version;
	}
	throw new Error("QR payload is too long");
}

export function createQrSvg(text: string, options?: { scale?: number; quiet?: number }): string {
	const version = chooseVersion(text);
	const spec = QR_L_BLOCKS[version];
	const size = 17 + version * 4;
	const capacity = spec.data.reduce((sum, n) => sum + n, 0);
	const data = makeDataCodewords(text, version, capacity);
	const codewords = interleaveBlocks(data, spec.data, spec.ecc);
	const { modules, reserved } = makeMatrix(size);
	drawFunctionPatterns(modules, reserved, version, spec.align);
	drawData(modules, reserved, codewords);
	drawFormatBits(modules);
	const quiet = options?.quiet ?? 4;
	const scale = options?.scale ?? 4;
	const svgSize = (size + quiet * 2) * scale;
	const rects: string[] = [];
	for (let r = 0; r < size; r++) {
		for (let c = 0; c < size; c++) {
			if (modules[r][c]) {
				rects.push(
					`<rect x="${(c + quiet) * scale}" y="${(r + quiet) * scale}" width="${scale}" height="${scale}"/>`,
				);
			}
		}
	}
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgSize} ${svgSize}" width="${svgSize}" height="${svgSize}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects.join("")}</g></svg>`;
}

export function createQrDataUrl(
	text: string,
	options?: { scale?: number; quiet?: number },
): string {
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(createQrSvg(text, options))}`;
}
