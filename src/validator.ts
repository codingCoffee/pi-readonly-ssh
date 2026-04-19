import { parse as shellParse } from "shell-quote";
import type { CommandRule, Config } from "./config.js";

export interface ValidationOk {
	ok: true;
	/** argv as finally resolved (e.g. sudo prefix stripped? no — we keep it as-is and just validate) */
	argv: string[];
}
export interface ValidationErr {
	ok: false;
	reason: string;
}
export type ValidationResult = ValidationOk | ValidationErr;

// Metacharacters that must never appear unescaped in the input string.
// We scan the raw string BEFORE parsing so even quoted-weirdness gets flagged.
const RAW_FORBIDDEN_PATTERNS: { re: RegExp; label: string }[] = [
	{ re: /\n|\r/, label: "newline" },
	{ re: /\|/, label: "pipe '|'" },
	{ re: /&/, label: "ampersand '&'" },
	{ re: /;/, label: "semicolon ';'" },
	{ re: />/, label: "redirect '>'" },
	{ re: /</, label: "redirect '<'" },
	{ re: /`/, label: "backtick" },
	{ re: /\$\(/, label: "command substitution '$('" },
	{ re: /\$\{/, label: "parameter expansion '${'" },
	{ re: /<\(/, label: "process substitution '<('" },
	{ re: />\(/, label: "process substitution '>('" },
];

const GLOB_CHARS = /[*?]|\{[^}]*,[^}]*\}/;

function hasUnsafeGlob(token: string): boolean {
	if (token.startsWith("~")) return true;
	return GLOB_CHARS.test(token);
}

function basename(p: string): string {
	const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
	return i >= 0 ? p.slice(i + 1) : p;
}

function findRule(cmdName: string, rules: CommandRule[]): CommandRule | undefined {
	return rules.find((r) => r.name === cmdName);
}

/**
 * Validate one argv (already parsed) against the allowlist. Used directly and
 * also recursively for `sudo`.
 */
function validateArgv(argv: string[], cfg: Config, depth = 0): ValidationResult {
	if (depth > 2) return { ok: false, reason: "too many nested prefix commands" };
	if (argv.length === 0) return { ok: false, reason: "empty command" };

	const head = basename(argv[0]);
	const rule = findRule(head, cfg.commands);
	if (!rule) {
		return { ok: false, reason: `command '${head}' is not in the allowlist` };
	}

	// Recursive handling for `sudo`
	if (head === "sudo") {
		// First pass: check sudo's own banned flags on args that are flags (start with '-')
		// before the inner command starts.
		let i = 1;
		const innerStart = (() => {
			while (i < argv.length) {
				const tok = argv[i];
				if (!tok.startsWith("-")) return i;
				if (rule.banned_flags?.includes(tok)) {
					return -1; // sentinel: banned
				}
				// sudo options that take a value: -u/--user, -g/--group, -C, -p, -T, -r, -t, -U
				if (["-u", "--user", "-g", "--group", "-C", "-p", "-T", "-r", "-t", "-U"].includes(tok)) {
					i += 2;
					continue;
				}
				i++;
			}
			return i;
		})();
		if (innerStart === -1) {
			return { ok: false, reason: `sudo flag is not allowed` };
		}
		const inner = argv.slice(innerStart);
		if (inner.length === 0) {
			return { ok: false, reason: "sudo requires a command to run" };
		}
		return validateArgv(inner, cfg, depth + 1);
	}

	// Subcommand check
	if (rule.subcommands && rule.subcommands.length > 0) {
		if (argv.length < 2) {
			return { ok: false, reason: `'${head}' requires a subcommand (one of: ${rule.subcommands.join(", ")})` };
		}
		if (!rule.subcommands.includes(argv[1])) {
			return {
				ok: false,
				reason: `'${head} ${argv[1]}' subcommand not allowed. Allowed: ${rule.subcommands.join(", ")}`,
			};
		}
	}

	// max_args
	if (typeof rule.max_args === "number" && argv.length > rule.max_args) {
		return { ok: false, reason: `'${head}' accepts at most ${rule.max_args} tokens, got ${argv.length}` };
	}

	// banned_flags: exact match against any argv[1..] token
	if (rule.banned_flags && rule.banned_flags.length > 0) {
		for (let j = 1; j < argv.length; j++) {
			if (rule.banned_flags.includes(argv[j])) {
				return { ok: false, reason: `'${head}' does not allow flag '${argv[j]}'` };
			}
			// Also catch "--flag=value" form when banlist contains "--flag"
			const eq = argv[j].indexOf("=");
			if (eq > 0) {
				const head2 = argv[j].slice(0, eq);
				if (rule.banned_flags.includes(head2)) {
					return { ok: false, reason: `'${head}' does not allow flag '${head2}'` };
				}
			}
		}
	}

	// banned_args_regex
	if (rule.banned_args_regex && rule.banned_args_regex.length > 0) {
		const regexes = rule.banned_args_regex.map((r) => new RegExp(r));
		for (let j = 1; j < argv.length; j++) {
			for (const re of regexes) {
				if (re.test(argv[j])) {
					return { ok: false, reason: `'${head}' argument '${argv[j]}' matches banned pattern ${re}` };
				}
			}
		}
	}

	// Globs
	const allowGlobs = rule.allow_globs ?? cfg.settings.allow_globs;
	if (!allowGlobs) {
		for (let j = 1; j < argv.length; j++) {
			if (hasUnsafeGlob(argv[j])) {
				return {
					ok: false,
					reason: `'${head}' argument '${argv[j]}' contains a glob/tilde; enumerate paths explicitly or enable allow_globs`,
				};
			}
		}
	}

	return { ok: true, argv };
}

/**
 * Validate a full command string. This is the entry point the tool calls.
 */
export function validateCommand(command: string, cfg: Config): ValidationResult {
	const input = command.trim();
	if (!input) return { ok: false, reason: "empty command" };

	// Normalize a leading '@' (some models prepend it to paths; we just reject it here
	// at the string level — it's never meaningful as a shell prefix).
	if (input.startsWith("@")) {
		return { ok: false, reason: "command must not start with '@'" };
	}

	// Step 1: raw-string metacharacter scan. Zero tolerance.
	for (const { re, label } of RAW_FORBIDDEN_PATTERNS) {
		if (re.test(input)) {
			return { ok: false, reason: `${label} is not allowed; ssh_exec does not run shell pipelines` };
		}
	}
	if (input.includes("<<") || input.includes("<<<")) {
		return { ok: false, reason: "heredoc is not allowed" };
	}

	// Step 2: parse with shell-quote. Reject any non-string token (operators, comments, globs-as-AST).
	let parsed: ReturnType<typeof shellParse>;
	try {
		parsed = shellParse(input);
	} catch (e) {
		return { ok: false, reason: `failed to parse command: ${(e as Error).message}` };
	}

	const argv: string[] = [];
	for (const tok of parsed) {
		if (typeof tok === "string") {
			argv.push(tok);
		} else if (tok && typeof tok === "object") {
			// shell-quote yields objects for operators, comments, globs, etc.
			const kind =
				"op" in tok
					? `operator '${(tok as any).op}'`
					: "comment" in tok
						? "comment"
						: "pattern" in tok
							? `glob pattern '${(tok as any).pattern}'`
							: `token '${JSON.stringify(tok)}'`;
			return { ok: false, reason: `${kind} is not allowed` };
		}
	}

	if (argv.length === 0) return { ok: false, reason: "no command after parsing" };

	return validateArgv(argv, cfg);
}
