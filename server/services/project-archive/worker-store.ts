import type { ArchiveRow, ArchiveValue } from "./main-store";
import type { ArchiveTable } from "./manifest";

/** Narrow SQL capability for dedicated project archive workers, never shared HTTP handles. */
export interface ArchiveSqlConnection {
	byteLength(column: string): string;
	query(text: string, values?: ArchiveValue[]): Promise<ArchiveRow[]>;
	transaction<T>(write: boolean, action: (tx: ArchiveSqlConnection) => Promise<T>): Promise<T>;
	columns(table: ArchiveTable): Promise<string[]>;
}

export function quoteArchiveIdentifier(value: string): string {
	if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw new Error("Invalid archive identifier");
	return `"${value}"`;
}
