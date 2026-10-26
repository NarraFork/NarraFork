import { z } from "zod";

const date = z.iso.date().refine((value) => {
	const timestamp = Date.parse(`${value}T00:00:00.000Z`);
	return (
		Number.isFinite(timestamp) &&
		new Date(timestamp).toISOString().slice(0, 10) === value &&
		value < "9999-12-31"
	);
}, "Invalid UTC calendar date");

export const tokenRecalculationRangeSchema = z
	.object({
		startDate: date.optional(),
		endDate: date.optional(),
	})
	.strict()
	.refine((range) => !range.startDate || !range.endDate || range.startDate <= range.endDate, {
		message: "startDate must not be later than endDate",
		path: ["endDate"],
	});
