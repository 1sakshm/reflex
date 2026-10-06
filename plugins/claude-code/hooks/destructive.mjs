/**
 * Destructive-command detection for shell (bash/zsh), PowerShell and cmd.
 *
 * A small parser rather than one big regex: commands are split into segments,
 * tokenized with quote awareness, and each segment is checked by what it actually
 * invokes. Text inside quotes (commit messages, grep patterns, echo) is never
 * treated as a command, except for SQL handed to a database client.
 */

/** Split a command line into segments on ; && || | and newlines, outside quotes. */
export function segments(command) {
  const out = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote && command[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      out.push(current);
      current = "";
      i++;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n") {
      out.push(current);
      current = ch === "|" ? "|" : "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((segment) => segment.trim()).filter(Boolean);
}

/** Quote-aware tokenizer; returns unquoted token values. */
export function tokens(segment) {
  const out = [];
  let current = "";
  let quote = null;
  let started = false;
  for (const ch of segment) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || current) out.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started || current) out.push(current);
  return out;
}

/** Remove quoted substrings (for checks that must ignore message/pattern text). */
export function stripQuoted(text) {
  return text.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''");
}

const BROAD_TARGET =
  /^(\/|\/\*|~|~\/|~\/\*|\.|\.\/|\.\/\*|\.\.|\.\.\/|\.\.\/\*|\*|\$HOME|\$\{HOME\}|\$HOME\/\*?|%USERPROFILE%|[A-Za-z]:[\\/]?\*?|\/[A-Za-z]\/?|\/(usr|etc|bin|sbin|var|home|Users|System|opt|lib|boot|root)\/?\*?|[A-Za-z]:[\\/](Windows|Users|Program Files)[\\/]?\*?)$/i;

function commandWords(segment) {
  let words = tokens(segment.replace(/^\|/, "").trim());
  // Skip wrappers: sudo, env VAR=1, time, nohup, doas, command, exec, xargs
  while (words.length && (/^(sudo|doas|time|nohup|command|exec|xargs|nice)$/.test(words[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || words[0] === "env")) {
    words = words.slice(1);
  }
  return words;
}

const SQL_CLIENT = /^(psql|mysql|mariadb|sqlite3|sqlcmd|duckdb|clickhouse(-client)?|bq|mongosh|mongo|snowsql|cockroach|pgcli|mycli|usql)$/i;
const SQL_DESTRUCTIVE = [
  [/\b(drop|truncate)\s+(table|database|schema|keyspace|collection)\b/i, "destroys database objects"],
  [/\bdelete\s+from\s+[\w."`[\]]+\s*(;|$)/i, "DELETE without WHERE"],
  [/\bupdate\s+[\w."`[\]]+\s+set\b(?![\s\S]*\bwhere\b)/i, "UPDATE without WHERE"],
  [/\.drop\(\s*\)|\bdropDatabase\(\s*\)/, "drops a MongoDB collection/database"],
];

function checkSegment(segment, raw) {
  const words = commandWords(segment);
  if (!words.length) return undefined;
  const cmd = words[0].replace(/^.*[\\/]/, "").toLowerCase().replace(/\.exe$/, "");
  const args = words.slice(1);
  const lowerArgs = args.map((arg) => arg.toLowerCase());

  // rm (POSIX)
  if (cmd === "rm") {
    const flags = args.filter((arg) => arg.startsWith("-"));
    const recursive = flags.some((flag) => /^-[a-zA-Z]*[rR]/.test(flag) || flag === "--recursive");
    const targets = args.filter((arg) => !arg.startsWith("-"));
    if (recursive && targets.some((target) => BROAD_TARGET.test(target))) return "recursive delete of a broad path";
    if (flags.includes("--no-preserve-root")) return "rm --no-preserve-root";
  }

  // PowerShell Remove-Item / rm / del / rd aliases with -Recurse
  if (/^(remove-item|ri|rmdir|rd|del|erase)$/.test(cmd) || (cmd === "rm" && args.some((arg) => /^-recurse$/i.test(arg)))) {
    const recurse = lowerArgs.some((arg) => arg === "-recurse" || arg === "-r" || arg === "/s");
    // Targets: everything that isn't a PowerShell parameter (-Force) or a cmd switch (/s, /q).
    const targets = args.filter((arg) => !arg.startsWith("-") && !/^\/[a-zA-Z]$/.test(arg));
    if (recurse && targets.some((target) => BROAD_TARGET.test(target))) {
      return "recursive delete of a broad path";
    }
    if ((cmd === "rd" || cmd === "rmdir" || cmd === "del" || cmd === "erase") && lowerArgs.includes("/s") && lowerArgs.includes("/q")) {
      return "silent recursive delete (cmd)";
    }
  }
  if (cmd === "format" && args.some((arg) => /^[a-z]:$/i.test(arg))) return "formats a drive";
  if (cmd === "diskpart" || cmd === "format-volume" || cmd === "clear-disk") return "modifies disks/partitions";

  // git
  if (cmd === "git") {
    const sub = lowerArgs.find((arg) => !arg.startsWith("-"));
    const rest = args.slice(args.findIndex((arg) => arg.toLowerCase() === sub) + 1);
    if (sub === "push" && (rest.some((arg) => arg === "--force" || arg === "-f" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg)) || rest.some((arg) => /^\+/.test(arg)) || rest.includes("--mirror") || rest.includes("--delete"))) {
      return "force push / remote ref deletion";
    }
    if (sub === "reset" && rest.includes("--hard")) return "hard reset discards local changes";
    if (sub === "clean" && rest.some((arg) => /^-[a-zA-Z]*f/.test(arg) || arg === "--force")) return "git clean deletes untracked files";
    if (sub === "branch" && rest.some((arg) => arg === "-D" || (arg === "--delete" && rest.includes("--force")))) return "force-deletes a branch";
    if ((sub === "checkout" || sub === "restore") && rest.length && rest.every((arg) => arg === "--" || arg === "." || arg === ":/" || arg === "--staged" || arg === "--worktree" || arg === "-W" || arg === "-S")) {
      return "discards all local changes";
    }
    if (sub === "stash" && (rest[0] === "clear" || rest[0] === "drop")) return "deletes stashed work";
    if (sub === "filter-branch" || sub === "filter-repo") return "rewrites history";
  }

  // SQL, only when actually sent to a database client (or via heredoc into one).
  if (SQL_CLIENT.test(cmd)) {
    for (const [pattern, reason] of SQL_DESTRUCTIVE) if (pattern.test(raw)) return reason;
  }

  const unquoted = stripQuoted(segment);
  if (/^mkfs(\.\w+)?$/.test(cmd)) return "creates a filesystem (erases a device)";
  if (cmd === "dd" && args.some((arg) => /^of=\/dev\//.test(arg))) return "writes directly to a device";
  if (cmd === "chmod" && lowerArgs.includes("-r") && args.some((arg) => /^0?777$/.test(arg))) return "makes a tree world-writable";
  if (cmd === "chown" && lowerArgs.includes("-r") && args.some((arg) => BROAD_TARGET.test(arg))) return "recursive chown of a broad path";
  if ((cmd === "kubectl" && lowerArgs[0] === "delete") || (cmd === "terraform" && lowerArgs[0] === "destroy") || (cmd === "helm" && /^(uninstall|delete)$/.test(lowerArgs[0] ?? "")) || (cmd === "pulumi" && lowerArgs[0] === "destroy")) {
    return "deletes infrastructure";
  }
  if ((cmd === "aws" && lowerArgs[0] === "s3" && (lowerArgs[1] === "rb" || (lowerArgs[1] === "rm" && lowerArgs.includes("--recursive")))) || (cmd === "gsutil" && /^(rm|rb)$/.test(lowerArgs[0] ?? "") && lowerArgs.includes("-r"))) {
    return "deletes cloud storage";
  }
  if ((cmd === "npm" || cmd === "pnpm" || cmd === "yarn") && lowerArgs[0] === "publish") return "publishes a package";
  if ((cmd === "cargo" && lowerArgs[0] === "publish") || (cmd === "twine" && lowerArgs[0] === "upload") || (cmd === "gem" && lowerArgs[0] === "push")) {
    return "publishes a package";
  }
  if (/:\(\)\s*\{\s*:\|:&\s*\};:/.test(unquoted)) return "fork bomb";
  if (/^(shutdown|reboot|halt|poweroff)$/.test(cmd) || (cmd === "stop-computer" || cmd === "restart-computer")) return "shuts down or reboots the machine";
  return undefined;
}

/** Returns a human-readable reason when the command looks destructive, else undefined. */
export function destructiveReason(command) {
  if (typeof command !== "string" || !command.trim()) return undefined;
  // Piping a download straight into a shell is risky regardless of segment boundaries.
  const unquoted = stripQuoted(command);
  if (/\b(curl|wget|iwr|invoke-webrequest|irm|invoke-restmethod)\b[^\n]*\|\s*(sudo\s+)?((ba|z|da|k)?sh|iex|invoke-expression|python3?|node)\b/i.test(unquoted)) {
    return "pipes a download into an interpreter";
  }
  if (/\biex\s*\(\s*(new-object|iwr|irm|invoke-webrequest)/i.test(unquoted)) return "executes downloaded code";
  for (const segment of segments(command)) {
    const reason = checkSegment(segment, segment);
    if (reason) return reason;
  }
  // SQL through a heredoc: `psql <<SQL ... DROP TABLE ...`
  if (/\b(psql|mysql|sqlite3|sqlcmd|duckdb)\b[^\n]*<</i.test(command)) {
    for (const [pattern, reason] of SQL_DESTRUCTIVE) if (pattern.test(command)) return reason;
  }
  return undefined;
}
