import { formatFileSize } from "@shared/text-file-types";
import type { TextFileRef } from "./uploads";

/** Build the provider-visible hint appended to prompts with text-file attachments. */
export function buildAttachedFilesHint(textFiles: TextFileRef[]): string {
	if (textFiles.length === 0) return "";
	const lines = textFiles.map(
		(file) => `- ${file.filePath} (${file.filename}, ${formatFileSize(file.size)})`,
	);
	return (
		"\n\n<attached_files>\n" +
		"The user has attached the following files for your reference. " +
		"Use the Read tool to access their contents when needed.\n" +
		`${lines.join("\n")}\n` +
		"</attached_files>"
	);
}
