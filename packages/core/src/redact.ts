/** Secret and PII redaction applied before anything is stored or learned from. */

const BUILTIN_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /\b(api[_-]?key|access[_-]?token|secret|password|passwd|token)\s*[:=]\s*["']?[^\s"',;]{6,}/gi,
];

const DEFAULT_SECRET_KEYS = /^(password|passwd|secret|token|api[_-]?key|apikey|access[_-]?token|authorization|cookie|private[_-]?key)$/i;

export interface RedactionOptions {
  enabled?: boolean;
  patterns?: (string | RegExp)[];
  keys?: string[];
}

export class Redactor {
  private readonly enabled: boolean;
  private readonly patterns: RegExp[];
  private readonly keys: RegExp;

  constructor(options: RedactionOptions = {}) {
    this.enabled = options.enabled !== false;
    const extra = (options.patterns ?? []).map((pattern) =>
      typeof pattern === "string" ? new RegExp(pattern, "g") : pattern,
    );
    this.patterns = [...BUILTIN_PATTERNS, ...extra];
    this.keys = options.keys?.length
      ? new RegExp(DEFAULT_SECRET_KEYS.source.slice(0, -2) + "|" + options.keys.join("|") + ")$", "i")
      : DEFAULT_SECRET_KEYS;
  }

  /** True for field names that conventionally hold secrets (password, token, apiKey, …). */
  isSecretKey(key: string): boolean {
    return this.enabled && this.keys.test(key);
  }

  text(input: string): string {
    if (!this.enabled) return input;
    let output = input;
    for (const pattern of this.patterns) {
      pattern.lastIndex = 0;
      output = output.replace(pattern, "[REDACTED]");
    }
    return output;
  }

  value<T>(input: T): T {
    if (!this.enabled) return input;
    let nodes = 0;
    const seen = new Set<object>();
    const walk = (item: unknown, depth: number): unknown => {
      if (++nodes > 50_000) return "[truncated]";
      if (typeof item === "string") return this.text(item);
      if (typeof item === "bigint") return item.toString();
      if (!item || typeof item !== "object") return item;
      if (depth > 16) return "[depth]";
      if (seen.has(item)) return "[cycle]";
      seen.add(item);
      try {
        if (Array.isArray(item)) return item.map((child) => walk(child, depth + 1));
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
          out[key] = this.keys.test(key) ? "[REDACTED]" : walk(child, depth + 1);
        }
        return out;
      } finally {
        seen.delete(item);
      }
    };
    return walk(input, 0) as T;
  }
}
