/**
 * Test-only ZIP/DOCX writer.
 *
 * The production reader only READS archives, so tests must build their own containers to
 * exercise it. Store-mode entries (compression method 0) keep this writer small: no deflate,
 * but the reader's local-header/central-directory walk is still fully exercised.
 */

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < 256; index += 1) {
		let value = index;
		for (let bit = 0; bit < 8; bit += 1) {
			value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[index] = value >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipInput {
	name: string;
	data: string | Uint8Array;
}

/** Build a stored (uncompressed) ZIP archive in memory. */
export function buildZip(entries: ZipInput[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;

	for (const entry of entries) {
		const name = Buffer.from(entry.name, "utf8");
		const data =
			typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : Buffer.from(entry.data);
		const checksum = crc32(data);

		const local = Buffer.alloc(30 + name.length);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(0, 6); // flags
		local.writeUInt16LE(0, 8); // method: store
		local.writeUInt16LE(0, 10); // time
		local.writeUInt16LE(0, 12); // date
		local.writeUInt32LE(checksum, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);
		name.copy(local, 30);
		locals.push(local, data);

		const central = Buffer.alloc(46 + name.length);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4); // version made by
		central.writeUInt16LE(20, 6); // version needed
		central.writeUInt16LE(0, 8);
		central.writeUInt16LE(0, 10);
		central.writeUInt16LE(0, 12);
		central.writeUInt16LE(0, 14);
		central.writeUInt32LE(checksum, 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt16LE(0, 30); // extra
		central.writeUInt16LE(0, 32); // comment
		central.writeUInt16LE(0, 34); // disk
		central.writeUInt16LE(0, 36); // internal attrs
		central.writeUInt32LE(0, 38); // external attrs
		central.writeUInt32LE(offset, 42);
		name.copy(central, 46);
		centrals.push(central);

		offset += local.length + data.length;
	}

	const centralDirectory = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(0, 4);
	eocd.writeUInt16LE(0, 6);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralDirectory.length, 12);
	eocd.writeUInt32LE(offset, 16);
	eocd.writeUInt16LE(0, 20);

	return Buffer.concat([...locals, centralDirectory, eocd]);
}

/** A 1×1 PNG, so picture extraction has something real to find. */
export const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
	"base64",
);

export interface DocxOptions {
	/** Paragraph XML for `word/document.xml`'s body, inserted as-is. */
	bodyXml: string;
	/** Extra parts to add (images, extra rels). */
	extraParts?: ZipInput[];
	/** Relationship entries beyond the defaults (`rId1` → image1.png is always present). */
	extraRels?: Array<{ id: string; target: string; external?: boolean }>;
}

/** Build a minimal but structurally real DOCX package. */
export function buildDocx(options: DocxOptions): Buffer {
	const rels = [{ id: "rId1", target: "media/image1.png" }, ...(options.extraRels ?? [])];
	const relsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${rels
	.map(
		(rel) =>
			`<Relationship Id="${rel.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${rel.target}"${
				rel.external ? ' TargetMode="External"' : ""
			}/>`,
	)
	.join("\n")}
</Relationships>`;

	return buildZip([
		{
			name: "[Content_Types].xml",
			data: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
		},
		{ name: "_rels/.rels", data: '<?xml version="1.0" encoding="UTF-8"?><Relationships/>' },
		{
			name: "word/document.xml",
			data: `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<w:body>${options.bodyXml}</w:body>
</w:document>`,
		},
		{ name: "word/_rels/document.xml.rels", data: relsXml },
		{ name: "word/media/image1.png", data: TINY_PNG },
		...(options.extraParts ?? []),
		{
			name: "docProps/core.xml",
			data: '<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>设计说明</dc:title><dc:creator>Kether</dc:creator></cp:coreProperties>',
		},
	]);
}

/** A paragraph containing one picture (`rId1` by default). */
export function pictureParagraph(relId = "rId1"): string {
	return `<w:p><w:r><w:drawing><a:blip r:embed="${relId}"/></w:drawing></w:r></w:p>`;
}
