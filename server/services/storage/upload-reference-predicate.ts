import { type SQLWrapper, sql } from "drizzle-orm";

/** Exact top-level image-element check; only owner IDs cross the Worker boundary. */
export function uploadReferencePredicate(contentJson: SQLWrapper, dialect: "sqlite" | "postgres") {
	return dialect === "postgres"
		? sql`CASE WHEN ${contentJson} LIKE '%"type":"image"%' THEN CASE WHEN jsonb_typeof(${contentJson}::jsonb) = 'array' THEN EXISTS (SELECT 1 FROM jsonb_array_elements(${contentJson}::jsonb) AS upload_block(value) WHERE upload_block.value->>'type' = 'image' AND jsonb_typeof(upload_block.value->'imageId') = 'string') ELSE FALSE END ELSE FALSE END`
		: sql`CASE WHEN ${contentJson} LIKE '%"type":"image"%' AND json_valid(${contentJson}) THEN CASE WHEN json_type(${contentJson}) = 'array' THEN EXISTS (SELECT 1 FROM json_each(${contentJson}) AS upload_block WHERE CASE WHEN upload_block.type = 'object' THEN json_extract(upload_block.value, '$.type') = 'image' AND json_type(upload_block.value, '$.imageId') = 'text' ELSE 0 END) ELSE 0 END ELSE 0 END`;
}
