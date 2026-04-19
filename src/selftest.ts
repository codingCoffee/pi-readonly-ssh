import type { Config } from "./config.js";
import { validateCommand } from "./validator.js";

/**
 * Runs a set of invariant tests against the loaded config.
 * Returns a list of failures (empty = all good).
 */
export function runSelfTests(cfg: Config): string[] {
	const failures: string[] = [];

	const mustReject: [string, string][] = [
		["ls | tee /etc/passwd", "pipe"],
		["ls > /tmp/x", "redirect >"],
		["ls >> /tmp/x", "redirect >"],
		["ls < /tmp/x", "redirect <"],
		["ls; rm -rf /", "semicolon"],
		["ls && rm -rf /", "ampersand"],
		["ls || rm -rf /", "pipe"],
		["ls & ", "ampersand"],
		["echo `rm -rf /`", "backtick"],
		["echo $(rm -rf /)", "command substitution"],
		["bash -c 'ls'", "bash not in allowlist"],
		["sh -c ls", "sh not in allowlist"],
		["sudo bash", "sudo recursive rejects bash"],
		["sudo -s", "sudo -s"],
		["sudo -i", "sudo -i"],
		["find . -delete", "find -delete"],
		["find . -exec rm {} +", "find -exec"],
		["tail -f /var/log/syslog", "tail -f"],
		["journalctl -f", "journalctl -f"],
		["kubectl delete pod foo", "kubectl delete"],
		["kubectl get pods -w", "kubectl -w"],
		["docker rm foo", "docker rm"],
		["docker exec -it foo bash", "docker exec"],
		["git commit -m hi", "git commit not in subcmds"],
		["git config --unset user.email", "git --unset"],
		["cat /etc/passwd\nrm -rf /", "newline"],
		["cat <<EOF\nhi\nEOF", "heredoc"],
		["@ls", "leading @"],
		["env FOO=bar ls", "env prefix"],
	];

	const mustAccept: string[] = [
		"ls -la /var/log",
		"cat /etc/hostname",
		"grep -r error /var/log/nginx",
		"systemctl status nginx",
		"journalctl -u nginx -n 100",
		"sudo systemctl status nginx",
		"sudo journalctl -u nginx -n 50",
		"git status",
		"git log --oneline -n 20",
		"kubectl get pods -n default",
		"docker ps -a",
		"find /var/log -name '*.log' -type f",
		"df -h",
		"ps auxf",
	];

	for (const [cmd, label] of mustReject) {
		const r = validateCommand(cmd, cfg);
		if (r.ok) failures.push(`should REJECT (${label}): ${cmd}`);
	}
	for (const cmd of mustAccept) {
		const r = validateCommand(cmd, cfg);
		if (!r.ok) failures.push(`should ACCEPT: ${cmd}  [got: ${r.reason}]`);
	}

	return failures;
}
