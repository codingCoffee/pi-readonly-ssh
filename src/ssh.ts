import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface SshRunOptions {
	host: string;            // ssh target (user@host or alias)
	argv: string[];          // already-validated argv vector
	timeoutSec: number;
	maxBytes: number;
	signal?: AbortSignal;
	onData?: (chunk: Buffer) => void;
}

export interface SshRunResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
	truncated: boolean;
	/** wall-clock ms */
	durationMs: number;
}

/**
 * Single-quote a token so that when ssh's remote shell runs `$SHELL -c <string>`
 * the token is passed literally with zero expansion.
 */
function shQuote(s: string): string {
	// Wrap in single quotes; inside, ' becomes '\''
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

function controlPath(): string {
	// %r %h %p resolved by ssh. Keep path short for socket length limits.
	return resolve(homedir(), ".ssh", "pi-ro-%r@%h:%p");
}

export async function runSsh(opts: SshRunOptions): Promise<SshRunResult> {
	const remoteCmd = opts.argv.map(shQuote).join(" ");
	const sshArgs = [
		"-o", "BatchMode=yes",
		"-o", "StrictHostKeyChecking=accept-new",
		"-o", "ConnectTimeout=10",
		"-o", "ControlMaster=auto",
		"-o", `ControlPath=${controlPath()}`,
		"-o", "ControlPersist=60s",
		"-T",
		opts.host,
		"--",
		remoteCmd,
	];

	const start = Date.now();
	return new Promise<SshRunResult>((resolvePromise) => {
		const child = spawn("ssh", sshArgs, { stdio: ["ignore", "pipe", "pipe"] });

		let stdoutBuf = "";
		let stderrBuf = "";
		let totalBytes = 0;
		let truncated = false;
		let timedOut = false;
		let settled = false;

		const timer = setTimeout(() => {
			timedOut = true;
			try {
				child.kill("SIGKILL");
			} catch { /* ignore */ }
		}, opts.timeoutSec * 1000);

		const onAbort = () => {
			try {
				child.kill("SIGKILL");
			} catch { /* ignore */ }
		};
		opts.signal?.addEventListener("abort", onAbort, { once: true });

		const handle = (chunk: Buffer, which: "stdout" | "stderr") => {
			if (truncated) return;
			opts.onData?.(chunk);
			const remaining = opts.maxBytes - totalBytes;
			if (remaining <= 0) {
				truncated = true;
				try { child.kill("SIGKILL"); } catch { /* ignore */ }
				return;
			}
			const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
			totalBytes += slice.length;
			const text = slice.toString("utf8");
			if (which === "stdout") stdoutBuf += text;
			else stderrBuf += text;
			if (chunk.length > remaining) {
				truncated = true;
				try { child.kill("SIGKILL"); } catch { /* ignore */ }
			}
		};

		child.stdout.on("data", (c: Buffer) => handle(c, "stdout"));
		child.stderr.on("data", (c: Buffer) => handle(c, "stderr"));

		const finish = (exitCode: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			resolvePromise({
				stdout: stdoutBuf,
				stderr: stderrBuf,
				exitCode,
				timedOut,
				truncated,
				durationMs: Date.now() - start,
			});
		};

		child.on("error", (err) => {
			stderrBuf += `\n[ssh spawn error] ${err.message}`;
			finish(null);
		});
		child.on("close", (code) => finish(code));
	});
}
