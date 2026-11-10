/**
 * Credential export / import between NarraFork instances (admin only). Export needs a
 * step-up grant from `authApi.stepUp`; the bundle comes back as a passphrase-sealed file.
 */
import { ApiError, authorizedFetch, readFetchError, request } from "./client";

export interface TransferableCredential {
	kind: string;
	id: string;
	label: string;
	archived?: boolean;
}

export interface CredentialImportPreviewItem {
	index: number;
	kind: string;
	label: string;
	existingId?: string;
	unsupported?: boolean;
}

export interface CredentialImportResult {
	added: number;
	replaced: number;
	skipped: number;
}

export const credentialTransferApi = {
	list: () =>
		request<{ credentials: TransferableCredential[] }>("/credential-transfer/credentials"),

	/** Download a sealed bundle; `selection` absent = everything. */
	export: async (input: {
		stepUpToken: string;
		passphrase: string;
		selection?: Array<{ kind: string; id: string }>;
	}): Promise<{ blob: Blob; filename: string }> => {
		const response = await authorizedFetch("/api/credential-transfer/export", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		});
		if (!response.ok) {
			const error = await readFetchError(response, "Export failed");
			throw new ApiError(error.message, response.status, error.data);
		}
		const disposition = response.headers.get("Content-Disposition") ?? "";
		const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "narrafork-credentials.json";
		return { blob: await response.blob(), filename };
	},

	previewImport: (bundle: string, passphrase: string) =>
		request<{ exportedAt: number; items: CredentialImportPreviewItem[] }>(
			"/credential-transfer/import/preview",
			{ method: "POST", body: JSON.stringify({ bundle, passphrase }) },
		),

	applyImport: (
		bundle: string,
		passphrase: string,
		choices: Array<{ index: number; action: "import" | "replace" }>,
	) =>
		request<CredentialImportResult>("/credential-transfer/import", {
			method: "POST",
			body: JSON.stringify({ bundle, passphrase, choices }),
		}),
};
