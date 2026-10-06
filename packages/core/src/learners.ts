/**
 * The learned parts of the Reflex ladder. Everything here is small, fast and
 * pure TypeScript: no native dependencies, no model download.
 *
 *  Tier 2  DecisionCache   exact state → previously correct action
 *  Tier 3  PatternTable    coarse situation signature → action counts
 *  Tier 4  HashedHead      online multinomial logistic regression on hashed features
 *          DifficultyHead  P(step needs System 2)
 *          Familiarity     how much of this state has been seen before (OOD guard)
 */
import type { Candidate } from "./actions.ts";
import type { Features } from "./encoder.ts";
import { digest, fnv1a, sigmoid, softmax, stableStringify, tokenize, LRU } from "./util.ts";

export type Dist = Map<string, number>;

// ---------------------------------------------------------------- cache

interface CacheStats {
  n: number;
  s: number;
}

export interface DecisionCacheState {
  entries: [string, Record<string, CacheStats>][];
}

export class DecisionCache {
  private readonly map: LRU<string, Record<string, CacheStats>>;

  constructor(capacity = 50_000) {
    this.map = new LRU(capacity);
  }

  static keyFor(point: string, features: Features, candidates: readonly Candidate[]): string {
    const keys = candidates.map((candidate) => candidate.key).sort().join(",");
    return point + "|" + features.stateDigest + "|" + digest(keys);
  }

  lookup(cacheKey: string, candidates: readonly Candidate[]): { dist: Dist; support: number } | undefined {
    const entry = this.map.get(cacheKey);
    if (!entry) return undefined;
    let total = 0;
    for (const stats of Object.values(entry)) total += stats.n;
    if (total === 0) return undefined;
    const dist: Dist = new Map();
    for (const candidate of candidates) {
      const stats = entry[candidate.key];
      dist.set(candidate.key, stats ? (stats.s + 0.5) / (total + 1) : 0);
    }
    return { dist, support: total };
  }

  /** Record that `actionKey` was the right call in this exact state (label or success). */
  reward(cacheKey: string, actionKey: string, success: boolean): void {
    const entry = this.map.get(cacheKey) ?? {};
    const stats = entry[actionKey] ?? { n: 0, s: 0 };
    stats.n += 1;
    if (success) stats.s += 1;
    entry[actionKey] = stats;
    this.map.set(cacheKey, entry);
  }

  invalidate(cacheKey: string): void {
    this.map.delete(cacheKey);
  }

  get size(): number {
    return this.map.size;
  }

  toJSON(): DecisionCacheState {
    return { entries: [...this.map.entries()] };
  }

  static fromJSON(state: DecisionCacheState | undefined, capacity?: number): DecisionCache {
    const cache = new DecisionCache(capacity);
    for (const [key, value] of state?.entries ?? []) cache.map.set(key, value);
    return cache;
  }
}

// ---------------------------------------------------------------- patterns

export interface PatternState {
  counts: [string, Record<string, number>][];
}

export class PatternTable {
  private readonly counts = new Map<string, Record<string, number>>();

  private key(point: string, signature: string): string {
    return point + "|" + signature;
  }

  add(point: string, signature: string, actionId: string, weight = 1): void {
    const key = this.key(point, signature);
    const entry = this.counts.get(key) ?? {};
    entry[actionId] = Math.max(0, (entry[actionId] ?? 0) + weight);
    this.counts.set(key, entry);
  }

  lookup(point: string, signature: string, candidates: readonly Candidate[]): { dist: Dist; support: number } | undefined {
    const entry = this.counts.get(this.key(point, signature));
    if (!entry) return undefined;
    const ids = new Map<string, Candidate[]>();
    for (const candidate of candidates) {
      const list = ids.get(candidate.spec.id) ?? [];
      list.push(candidate);
      ids.set(candidate.spec.id, list);
    }
    let support = 0;
    for (const id of ids.keys()) support += entry[id] ?? 0;
    if (support === 0) return undefined;
    const alpha = 0.5;
    const denom = support + alpha * ids.size;
    const dist: Dist = new Map();
    for (const [id, list] of ids) {
      const p = ((entry[id] ?? 0) + alpha) / denom;
      // The pattern table only knows action ids; params are split evenly so they fall through.
      for (const candidate of list) dist.set(candidate.key, p / list.length);
    }
    return { dist, support };
  }

  toJSON(): PatternState {
    return { counts: [...this.counts.entries()] };
  }

  static fromJSON(state: PatternState | undefined): PatternTable {
    const table = new PatternTable();
    for (const [key, value] of state?.counts ?? []) table.counts.set(key, value);
    return table;
  }
}

// ---------------------------------------------------------------- hashed models

export interface SparseWeights {
  bits: number;
  idx: number[];
  w: number[];
  g: number[];
}

/** Hashed weight vector with AdaGrad state, serialized sparsely. */
class HashedWeights {
  readonly bits: number;
  readonly mask: number;
  readonly w: Float32Array;
  readonly g: Float32Array;

  constructor(bits: number) {
    this.bits = bits;
    this.mask = (1 << bits) - 1;
    this.w = new Float32Array(1 << bits);
    this.g = new Float32Array(1 << bits);
  }

  index(feature: string): number {
    return fnv1a(feature) & this.mask;
  }

  dot(idx: readonly number[], val: readonly number[]): number {
    let sum = 0;
    for (let i = 0; i < idx.length; i++) sum += (this.w[idx[i] as number] ?? 0) * (val[i] as number);
    return sum;
  }

  /** AdaGrad step on `-gradient`: w -= lr * grad / sqrt(G). */
  update(idx: readonly number[], val: readonly number[], gradient: number, lr: number): void {
    for (let i = 0; i < idx.length; i++) {
      const j = idx[i] as number;
      const grad = gradient * (val[i] as number);
      const g = (this.g[j] ?? 0) + grad * grad;
      this.g[j] = g;
      this.w[j] = (this.w[j] ?? 0) - (lr * grad) / Math.sqrt(g + 1e-8);
    }
  }

  toJSON(): SparseWeights {
    const idx: number[] = [];
    const w: number[] = [];
    const g: number[] = [];
    for (let i = 0; i < this.w.length; i++) {
      const weight = this.w[i] as number;
      if (weight !== 0) {
        idx.push(i);
        w.push(Math.round(weight * 1e6) / 1e6);
        g.push(Math.round((this.g[i] as number) * 1e4) / 1e4);
      }
    }
    return { bits: this.bits, idx, w, g };
  }

  static fromJSON(state: SparseWeights | undefined, bits: number): HashedWeights {
    const weights = new HashedWeights(state?.bits ?? bits);
    if (state) {
      for (let i = 0; i < state.idx.length; i++) {
        const j = state.idx[i] as number;
        weights.w[j] = state.w[i] as number;
        weights.g[j] = state.g[i] ?? 1;
      }
    }
    return weights;
  }
}

interface FeatureVector {
  idx: number[];
  val: number[];
}

function textTokens(features: Features): Set<string> {
  const out = new Set<string>();
  for (const token of features.tokens) {
    if (token.startsWith("o:") || token.startsWith("g:")) out.add(token.slice(2));
  }
  return out;
}

/** Tier 4: multinomial logistic regression over hashed (state token × action) features. */
export class HashedHead {
  private readonly weights: HashedWeights;
  lr: number;

  constructor(weights: HashedWeights, lr = 0.3) {
    this.weights = weights;
    this.lr = lr;
  }

  static create(bits = 18): HashedHead {
    return new HashedHead(new HashedWeights(bits));
  }

  private vectors(point: string, features: Features, candidates: readonly Candidate[]): FeatureVector[] {
    const scale = 1 / Math.sqrt(Math.max(1, features.tokens.length));
    const words = textTokens(features);
    return candidates.map((candidate) => {
      const { id, kind, params } = candidate.spec;
      const idx: number[] = [];
      const val: number[] = [];
      const add = (feature: string, value: number) => {
        idx.push(this.weights.index(feature));
        val.push(value);
      };
      add(`b|${point}|${id}`, 1);
      add(`k|${kind}`, 0.5);
      add(`sig|${features.signature}|${id}`, 1);
      for (const token of features.tokens) {
        add(`x|${token}|${id}`, scale);
        add(`xk|${token}|${kind}`, scale * 0.5);
      }
      if (params !== undefined) {
        const paramTokens = tokenize(stableStringify(params), 16);
        let overlap = 0;
        for (const token of paramTokens) if (words.has(token)) overlap++;
        const ratio = paramTokens.length ? overlap / paramTokens.length : 0;
        add(`po|${id}`, ratio);
        add("po|*", ratio);
        if (overlap === 0) add(`pn|${id}`, 1);
      }
      return { idx, val };
    });
  }

  predict(point: string, features: Features, candidates: readonly Candidate[]): Dist {
    const vectors = this.vectors(point, features, candidates);
    const probs = softmax(vectors.map((vector) => this.weights.dot(vector.idx, vector.val)));
    const dist: Dist = new Map();
    candidates.forEach((candidate, i) => dist.set(candidate.key, probs[i] ?? 0));
    return dist;
  }

  /** One SGD step towards `labelKey` (cross-entropy). */
  train(point: string, features: Features, candidates: readonly Candidate[], labelKey: string, weight = 1): void {
    const vectors = this.vectors(point, features, candidates);
    const probs = softmax(vectors.map((vector) => this.weights.dot(vector.idx, vector.val)));
    vectors.forEach((vector, i) => {
      const y = candidates[i]?.key === labelKey ? 1 : 0;
      const gradient = ((probs[i] ?? 0) - y) * weight;
      if (gradient !== 0) this.weights.update(vector.idx, vector.val, gradient, this.lr);
    });
  }

  /** Push probability mass away from `badKey` (negative outcome on an auto decision). */
  penalize(point: string, features: Features, candidates: readonly Candidate[], badKey: string, weight = 0.5): void {
    const vectors = this.vectors(point, features, candidates);
    const probs = softmax(vectors.map((vector) => this.weights.dot(vector.idx, vector.val)));
    const i = candidates.findIndex((candidate) => candidate.key === badKey);
    const vector = vectors[i];
    if (i < 0 || !vector) return;
    this.weights.update(vector.idx, vector.val, (probs[i] ?? 0) * weight, this.lr);
  }

  toJSON(): SparseWeights {
    return this.weights.toJSON();
  }

  static fromJSON(state: SparseWeights | undefined, bits = 18): HashedHead {
    return new HashedHead(HashedWeights.fromJSON(state, bits));
  }
}

/** P(this step needs System 2), from state tokens. Used for early escalation and hedging. */
export class DifficultyHead {
  private readonly weights: HashedWeights;
  lr = 0.2;
  examples = 0;

  constructor(weights: HashedWeights, examples = 0) {
    this.weights = weights;
    this.examples = examples;
  }

  static create(bits = 16): DifficultyHead {
    return new DifficultyHead(new HashedWeights(bits));
  }

  private vector(point: string, features: Features): FeatureVector {
    const scale = 1 / Math.sqrt(Math.max(1, features.tokens.length));
    const idx = [this.weights.index(`d|${point}`), this.weights.index(`ds|${point}|${features.signature}`)];
    const val = [1, 1];
    for (const token of features.tokens) {
      idx.push(this.weights.index(`d|${point}|${token}`));
      val.push(scale);
    }
    return { idx, val };
  }

  predict(point: string, features: Features): number {
    const vector = this.vector(point, features);
    return sigmoid(this.weights.dot(vector.idx, vector.val));
  }

  train(point: string, features: Features, hard: boolean): void {
    const vector = this.vector(point, features);
    const p = sigmoid(this.weights.dot(vector.idx, vector.val));
    this.weights.update(vector.idx, vector.val, p - (hard ? 1 : 0), this.lr);
    this.examples++;
  }

  toJSON(): SparseWeights & { examples: number } {
    return { ...this.weights.toJSON(), examples: this.examples };
  }

  static fromJSON(state: (SparseWeights & { examples?: number }) | undefined, bits = 16): DifficultyHead {
    return new DifficultyHead(HashedWeights.fromJSON(state, bits), state?.examples ?? 0);
  }
}

/** Tracks which (point, token) pairs have been seen. Low familiarity = out of distribution. */
export class Familiarity {
  private readonly seen: Uint8Array;
  private readonly mask: number;

  constructor(bits = 16, seen?: Uint8Array) {
    this.mask = (1 << bits) - 1;
    this.seen = seen ?? new Uint8Array(1 << bits);
  }

  private structural(features: Features): string[] {
    const structural = features.tokens.filter((token) => !token.startsWith("o:") && !token.startsWith("g:"));
    return structural.length ? structural : features.tokens;
  }

  add(point: string, features: Features): void {
    for (const token of this.structural(features)) {
      const j = fnv1a(point + "|" + token) & this.mask;
      if ((this.seen[j] ?? 0) < 255) this.seen[j] = (this.seen[j] ?? 0) + 1;
    }
  }

  score(point: string, features: Features): number {
    const tokens = this.structural(features);
    if (tokens.length === 0) return 1;
    let known = 0;
    for (const token of tokens) if ((this.seen[fnv1a(point + "|" + token) & this.mask] ?? 0) > 0) known++;
    return known / tokens.length;
  }

  toJSON(): { bits: number; idx: number[]; c: number[] } {
    const idx: number[] = [];
    const c: number[] = [];
    this.seen.forEach((count, i) => {
      if (count) {
        idx.push(i);
        c.push(count);
      }
    });
    return { bits: Math.log2(this.mask + 1), idx, c };
  }

  static fromJSON(state: { bits: number; idx: number[]; c: number[] } | undefined): Familiarity {
    const familiarity = new Familiarity(state?.bits ?? 16);
    if (state) state.idx.forEach((j, i) => (familiarity.seen[j] = state.c[i] ?? 1));
    return familiarity;
  }
}

// ---------------------------------------------------------------- calibration

/** Temperature scaling on probabilities: p_i ∝ p_i^(1/T). */
export function applyTemperature(dist: Dist, temperature: number): Dist {
  if (temperature === 1 || dist.size === 0) return dist;
  const keys = [...dist.keys()];
  const logits = keys.map((key) => Math.log(Math.max(dist.get(key) ?? 0, 1e-12)) / temperature);
  const probs = softmax(logits);
  const out: Dist = new Map();
  keys.forEach((key, i) => out.set(key, probs[i] ?? 0));
  return out;
}

export interface CalibrationSample {
  dist: Dist;
  label: string;
}

const TEMPERATURE_GRID = [0.25, 0.35, 0.5, 0.65, 0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5, 3, 4];

/** Pick the temperature that minimizes negative log-likelihood on held-out samples. */
export function fitTemperature(samples: readonly CalibrationSample[]): number {
  const usable = samples.filter((sample) => sample.dist.has(sample.label));
  if (usable.length < 10) return 1;
  let best = 1;
  let bestLoss = Infinity;
  for (const temperature of TEMPERATURE_GRID) {
    let loss = 0;
    for (const sample of usable) {
      const p = applyTemperature(sample.dist, temperature).get(sample.label) ?? 1e-12;
      loss -= Math.log(Math.max(p, 1e-12));
    }
    if (loss < bestLoss) {
      bestLoss = loss;
      best = temperature;
    }
  }
  return best;
}

/** Expected Calibration Error over (confidence, correct) pairs with equal-width bins. */
export function expectedCalibrationError(pairs: readonly { confidence: number; correct: boolean }[], bins = 10): number {
  if (pairs.length === 0) return 0;
  const buckets = Array.from({ length: bins }, () => ({ n: 0, conf: 0, acc: 0 }));
  for (const pair of pairs) {
    const b = buckets[Math.min(bins - 1, Math.floor(pair.confidence * bins))];
    if (!b) continue;
    b.n++;
    b.conf += pair.confidence;
    b.acc += pair.correct ? 1 : 0;
  }
  let ece = 0;
  for (const b of buckets) if (b.n) ece += (b.n / pairs.length) * Math.abs(b.acc / b.n - b.conf / b.n);
  return ece;
}

export function topOf(dist: Dist): { key: string; p: number; margin: number } | undefined {
  let firstKey: string | undefined;
  let first = -1;
  let second = 0;
  for (const [key, p] of dist) {
    if (p > first) {
      second = Math.max(first, 0);
      first = p;
      firstKey = key;
    } else if (p > second) {
      second = p;
    }
  }
  return firstKey === undefined ? undefined : { key: firstKey, p: first, margin: first - second };
}
