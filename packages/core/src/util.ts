/** Small, dependency-free helpers shared across the runtime. */

/** 32-bit FNV-1a hash. Fast and good enough for feature hashing. */
export function fnv1a(input: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 64-bit hex digest built from two independent FNV-1a passes. Not cryptographic. */
export function digest(input: string): string {
  return (
    fnv1a(input).toString(16).padStart(8, "0") +
    fnv1a(input, 0x9747b28c).toString(16).padStart(8, "0")
  );
}

/**
 * Deterministic JSON serialization with sorted object keys. Always returns valid JSON and
 * always terminates: cycles become "[cycle]", BigInt becomes a string, and output is cut
 * off after `maxNodes` values so hostile inputs cannot stall the decision path.
 */
export function stableStringify(value: unknown, maxNodes = 50_000): string {
  let nodes = 0;
  const ancestors = new Set<object>();
  const walk = (item: unknown, depth: number): string => {
    if (++nodes > maxNodes) return '"[truncated]"';
    if (item === null || typeof item !== "object") {
      if (item === undefined || typeof item === "function" || typeof item === "symbol") return "null";
      if (typeof item === "bigint") return JSON.stringify(item.toString());
      if (typeof item === "number" && !Number.isFinite(item)) return "null";
      return JSON.stringify(item);
    }
    if (depth > 32) return '"[depth]"';
    if (ancestors.has(item)) return '"[cycle]"';
    ancestors.add(item);
    try {
      if (Array.isArray(item)) return "[" + item.map((child) => walk(child, depth + 1)).join(",") + "]";
      const record = item as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined && typeof record[key] !== "function")
        .sort();
      return "{" + keys.map((key) => JSON.stringify(key) + ":" + walk(record[key], depth + 1)).join(",") + "}";
    } finally {
      ancestors.delete(item);
    }
  };
  return walk(value, 0);
}

const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
let idCounter = 0;

/** Sortable, unique-enough identifier: 10 chars of time + 4 chars counter + 6 random. */
export function newId(): string {
  let time = Date.now();
  let timePart = "";
  for (let i = 0; i < 10; i++) {
    timePart = ID_ALPHABET[time % 32] + timePart;
    time = Math.floor(time / 32);
  }
  idCounter = (idCounter + 1) % 1048576;
  let counterPart = "";
  let counter = idCounter;
  for (let i = 0; i < 4; i++) {
    counterPart = ID_ALPHABET[counter % 32] + counterPart;
    counter = Math.floor(counter / 32);
  }
  let randomPart = "";
  for (let i = 0; i < 6; i++) randomPart += ID_ALPHABET[Math.floor(Math.random() * 32)];
  return timePart + counterPart + randomPart;
}

export function now(): number {
  return performance.now();
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Numerically stable softmax. */
export function softmax(logits: readonly number[]): number[] {
  if (logits.length === 0) return [];
  let max = -Infinity;
  for (const logit of logits) if (logit > max) max = logit;
  const exps = logits.map((logit) => Math.exp(logit - max));
  const sum = exps.reduce((acc, value) => acc + value, 0);
  return exps.map((value) => value / sum);
}

export function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = clamp(Math.ceil((p / 100) * sorted.length) - 1, 0, sorted.length - 1);
  return sorted[index] ?? 0;
}

/** Minimal LRU cache built on Map insertion order. */
export class LRU<K, V> {
  private readonly map = new Map<K, V>();
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  peek(key: K): V | undefined {
    return this.map.get(key);
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }

  entries(): IterableIterator<[K, V]> {
    return this.map.entries();
  }
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have", "in", "is",
  "it", "its", "of", "on", "or", "that", "the", "this", "to", "was", "were", "will", "with",
]);

const tokenCache = new LRU<string, string[]>(4096);

/**
 * Lowercased word tokens. Paths and dotted names also contribute their parts,
 * so `src/utils/date.ts` yields `src/utils/date.ts`, `date.ts`, `date`, `ts`...
 */
export function tokenize(text: string, max = 64): string[] {
  if (!text) return [];
  const cacheKey = max + "\u0000" + text;
  const cached = tokenCache.get(cacheKey);
  if (cached) return cached;
  const out = new Set<string>();
  const matches = text.toLowerCase().match(/[a-z0-9_]+(?:[./\\-][a-z0-9_]+)*/g) ?? [];
  for (const match of matches) {
    if (out.size >= max) break;
    if (match.length < 2 || STOPWORDS.has(match)) continue;
    out.add(match);
    if (/[./\\-]/.test(match)) {
      const parts = match.split(/[/\\]/);
      const base = parts[parts.length - 1];
      if (base && base.length > 1) out.add(base);
      for (const piece of match.split(/[./\\-]/)) {
        if (out.size >= max) break;
        if (piece.length > 1 && !STOPWORDS.has(piece)) out.add(piece);
      }
    }
  }
  const tokens = [...out].slice(0, max);
  tokenCache.set(cacheKey, tokens);
  return tokens;
}

export function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars - 1) + "…";
}

/** Resolve a dotted path such as `state.lastObservation.type` against an object. */
export function getPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const part of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Glob with `*` wildcards only, matched against the whole string. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + escaped + "$");
}

export function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_");
}
