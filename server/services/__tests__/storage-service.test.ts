import { describe, expect, test } from "bun:test";
import { buildReferencedUploadOwnerIds } from "../storage-service";

describe("buildReferencedUploadOwnerIds", () => {
	test("preserves active narrators and deleted owners with surviving image messages", () => {
		const ownerIds = buildReferencedUploadOwnerIds(
			["active-narrator"],
			[
				{
					narratorId: "deleted-image-owner",
					contentJson: [
						{ type: "image", imageId: "img_1", filename: "shot.png", mediaType: "image/png" },
					],
				},
				{
					narratorId: "deleted-text-owner",
					contentJson: [{ type: "text", text: "no images here" }],
				},
			],
		);

		expect([...ownerIds].sort()).toEqual(["active-narrator", "deleted-image-owner"]);
	});
});
