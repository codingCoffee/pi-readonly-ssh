import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { auditLog } from "./audit.js";
import type { Config } from "./config.js";
import { runSsh } from "./ssh.js";
import { validateCommand } from "./validator.js";

export function registerSshExecTool(pi: ExtensionAPI, getConfig: () => Config) {
	pi.registerTool({
		name: "ssh_exec",
		label: "SSH (read-only)",
		description:
			"Run a single read-only command on an allow-listed remote host over SSH. " +
			"The 'command' argument is NOT a shell string: pipes, redirects, " +
			"command substitution, background, and here-docs are all rejected. " +
			"Only commands on the server-side allowlist are accepted. " +
			"Use /ssh-allowed and /ssh-hosts to inspect the current policy.",
		promptSnippet:
			"Run read-only diagnostic commands on remote hosts over SSH (no pipes, no writes).",
		promptGuidelines: [
			"Use ssh_exec for remote diagnostics only. Never attempt writes, edits, or state changes.",
			"The 'command' argument is passed as a single program+args; do NOT use '|', '>', ';', '&&', '$(...)', backticks, or heredocs. Split logic across multiple ssh_exec calls instead.",
			"The 'host' argument must be one of the aliases configured in the readonly-ssh allowlist.",
			"If a command is rejected, read the error, pick a different allow-listed command, or ask the user to add it to commands.yaml.",
		],
		parameters: Type.Object({
			host: Type.String({
				description:
					"Host to target. Either a named alias from the readonly-ssh allowlist " +
					"(see /ssh-hosts), or — if settings.allow_any_host is true — any ssh " +
					"target string (user@host, host, or an alias from ~/.ssh/config).",
			}),
			command: Type.String({
				description:
					"Single program + arguments. Example: 'systemctl status nginx'. No shell operators.",
			}),
			timeout_sec: Type.Optional(
				Type.Number({ description: "Override default timeout, in seconds." }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const cfg = getConfig();

			// Resolve host. Named aliases from `hosts:` always win. If the input
			// doesn't match a named alias and `allow_any_host` is enabled, fall back
			// to treating the input as a raw ssh target.
			const hostEntry = cfg.hosts.find((h) => h.name === params.host);
			let sshTarget: string;
			if (hostEntry) {
				sshTarget = hostEntry.ssh;
			} else if (cfg.settings.allow_any_host) {
				// Basic sanity: reject whitespace/metacharacters that could smuggle ssh
				// options. Allow common chars for user@host, IPv6 in brackets, and ports.
				if (!/^[A-Za-z0-9._@:\-\[\]]+$/.test(params.host)) {
					const reason = `host '${params.host}' contains disallowed characters`;
					auditLog(cfg.settings.audit_log, {
						host: params.host,
						command: params.command,
						ok: false,
						reason,
					});
					return {
						content: [{ type: "text", text: `REJECTED: ${reason}` }],
						details: { rejected: true, reason },
						isError: true,
					};
				}
				if (params.host.startsWith("-")) {
					const reason = `host '${params.host}' must not start with '-'`;
					auditLog(cfg.settings.audit_log, {
						host: params.host,
						command: params.command,
						ok: false,
						reason,
					});
					return {
						content: [{ type: "text", text: `REJECTED: ${reason}` }],
						details: { rejected: true, reason },
						isError: true,
					};
				}
				sshTarget = params.host;
			} else {
				const available = cfg.hosts.map((h) => h.name).join(", ") || "(none configured)";
				const reason =
					`host '${params.host}' is not in the allowlist. Available: ${available}. ` +
					`Set settings.allow_any_host: true in commands.yaml to permit arbitrary hosts.`;
				auditLog(cfg.settings.audit_log, {
					host: params.host,
					command: params.command,
					ok: false,
					reason,
				});
				return {
					content: [{ type: "text", text: `REJECTED: ${reason}` }],
					details: { rejected: true, reason },
					isError: true,
				};
			}

			// Validate command
			const v = validateCommand(params.command, cfg);
			if (!v.ok) {
				auditLog(cfg.settings.audit_log, {
					host: params.host,
					command: params.command,
					ok: false,
					reason: v.reason,
				});
				return {
					content: [
						{
							type: "text",
							text:
								`REJECTED by readonly-ssh guard: ${v.reason}\n\n` +
								`Original command: ${params.command}\n` +
								`Tip: run /ssh-allowed to see what's permitted.`,
						},
					],
					details: { rejected: true, reason: v.reason, command: params.command },
					isError: true,
				};
			}

			const timeoutSec =
				typeof params.timeout_sec === "number" && params.timeout_sec > 0
					? Math.min(params.timeout_sec, 600)
					: cfg.settings.default_timeout_sec;

			const result = await runSsh({
				host: sshTarget,
				argv: v.argv,
				timeoutSec,
				maxBytes: cfg.settings.max_output_bytes,
				signal,
			});

			auditLog(cfg.settings.audit_log, {
				host: params.host,
				command: params.command,
				ok: true,
				exitCode: result.exitCode,
				durationMs: result.durationMs,
				truncated: result.truncated,
				timedOut: result.timedOut,
			});

			const status =
				result.timedOut
					? `TIMED OUT after ${timeoutSec}s`
					: result.exitCode === 0
						? `exit 0`
						: `exit ${result.exitCode}`;

			const parts: string[] = [];
			parts.push(`[${params.host}] ${params.command}`);
			parts.push(`status: ${status}${result.truncated ? " (output truncated)" : ""}`);
			if (result.stdout) {
				parts.push("--- stdout ---");
				parts.push(result.stdout.replace(/\s+$/, ""));
			}
			if (result.stderr) {
				parts.push("--- stderr ---");
				parts.push(result.stderr.replace(/\s+$/, ""));
			}
			if (!result.stdout && !result.stderr) {
				parts.push("(no output)");
			}

			return {
				content: [{ type: "text", text: parts.join("\n") }],
				details: {
					host: params.host,
					command: params.command,
					exitCode: result.exitCode,
					durationMs: result.durationMs,
					truncated: result.truncated,
					timedOut: result.timedOut,
				},
				isError: result.exitCode !== 0 || result.timedOut,
			};
		},
	});
}
