import { appendFileSync } from "node:fs";

export function auditLog(
	path: string | null,
	entry: {
		host: string;
		command: string;
		ok: boolean;
		reason?: string;
		exitCode?: number | null;
		durationMs?: number;
		truncated?: boolean;
		timedOut?: boolean;
	},
): void {
	if (!path) return;
	try {
		const line =
			JSON.stringify({
				ts: new Date().toISOString(),
				...entry,
			}) + "\n";
		appendFileSync(path, line, "utf8");
	} catch {
		/* best-effort */
	}
}
