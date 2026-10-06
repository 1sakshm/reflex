import type { Candidate } from "./actions.ts";
import type { Features } from "./encoder.ts";
import type { Risk } from "./types.ts";
import {
  DecisionCache,
  DifficultyHead,
  Familiarity,
  HashedHead,
  PatternTable,
  type DecisionCacheState,
  type PatternState,
  type SparseWeights,
} from "./learners.ts";

export interface PolicyMetrics {
  examples: number;
  validation: number;
  coverage: number;
  precision: number;
  ece: number;
  byTier: Record<string, { auto: number; correct: number }>;
}

/** On-disk policy format. Versioned, self-contained, diffable JSON. */
export interface PolicyFile {
  format: 1;
  workload: string;
  version: string;
  parent?: string;
  createdAt: string;
  note?: string;
  labeled: Record<string, number>;
  calibration: Record<string, number>;
  thresholds: Partial<Record<Risk, number>>;
  head: SparseWeights;
  difficulty: SparseWeights & { examples: number };
  patterns: PatternState;
  cache: DecisionCacheState;
  familiarity: { bits: number; idx: number[]; c: number[] };
  metrics?: PolicyMetrics;
}

interface PolicyInit {
  workload: string;
  version: string;
  parent?: string;
  labeled?: Record<string, number>;
  calibration?: Record<string, number>;
  thresholds?: Partial<Record<Risk, number>>;
  metrics?: PolicyMetrics;
  head: HashedHead;
  difficulty: DifficultyHead;
  patterns: PatternTable;
  cache: DecisionCache;
  familiarity: Familiarity;
}

/** The live, learnable policy: every learned tier plus calibration and thresholds. */
export class PolicyRuntime {
  workload: string;
  version: string;
  parent: string | undefined;
  labeled: Record<string, number>;
  calibration: Record<string, number>;
  thresholds: Partial<Record<Risk, number>>;
  metrics: PolicyMetrics | undefined;
  readonly head: HashedHead;
  readonly difficulty: DifficultyHead;
  readonly patterns: PatternTable;
  readonly cache: DecisionCache;
  readonly familiarity: Familiarity;

  private constructor(init: PolicyInit) {
    this.workload = init.workload;
    this.version = init.version;
    this.parent = init.parent;
    this.labeled = init.labeled ?? {};
    this.calibration = init.calibration ?? {};
    this.thresholds = init.thresholds ?? {};
    this.metrics = init.metrics;
    this.head = init.head;
    this.difficulty = init.difficulty;
    this.patterns = init.patterns;
    this.cache = init.cache;
    this.familiarity = init.familiarity;
  }

  static empty(workload: string, version = "base"): PolicyRuntime {
    return new PolicyRuntime({
      workload,
      version,
      head: HashedHead.create(),
      difficulty: DifficultyHead.create(),
      patterns: new PatternTable(),
      cache: new DecisionCache(),
      familiarity: new Familiarity(),
    });
  }

  static fromJSON(file: PolicyFile): PolicyRuntime {
    if (file.format !== 1) throw new Error(`Unsupported policy format ${String(file.format)}`);
    const init: PolicyInit = {
      workload: file.workload,
      version: file.version,
      labeled: file.labeled,
      calibration: file.calibration,
      thresholds: file.thresholds,
      head: HashedHead.fromJSON(file.head),
      difficulty: DifficultyHead.fromJSON(file.difficulty),
      patterns: PatternTable.fromJSON(file.patterns),
      cache: DecisionCache.fromJSON(file.cache),
      familiarity: Familiarity.fromJSON(file.familiarity),
    };
    if (file.parent) init.parent = file.parent;
    if (file.metrics) init.metrics = file.metrics;
    return new PolicyRuntime(init);
  }

  toJSON(note?: string): PolicyFile {
    const file: PolicyFile = {
      format: 1,
      workload: this.workload,
      version: this.version,
      createdAt: new Date().toISOString(),
      labeled: this.labeled,
      calibration: this.calibration,
      thresholds: this.thresholds,
      head: this.head.toJSON(),
      difficulty: this.difficulty.toJSON(),
      patterns: this.patterns.toJSON(),
      cache: this.cache.toJSON(),
      familiarity: this.familiarity.toJSON(),
    };
    if (this.parent) file.parent = this.parent;
    if (note) file.note = note;
    if (this.metrics) file.metrics = this.metrics;
    return file;
  }

  /** True once offline training has fitted a temperature for this tier (at this point or globally). */
  isCalibrated(tier: string, point: string): boolean {
    return `${tier}:${point}` in this.calibration || `${tier}:*` in this.calibration;
  }

  temperature(tier: string, point: string): number {
    return this.calibration[`${tier}:${point}`] ?? this.calibration[`${tier}:*`] ?? 1;
  }

  labeledCount(point: string): number {
    return this.labeled[point] ?? 0;
  }

  /**
   * Learn from a reference choice (frontier/human/rule) at a decision point.
   * `labelKey` is undefined when the reference did something outside the action space.
   */
  learnLabel(
    point: string,
    features: Features,
    candidates: readonly Candidate[],
    labelKey: string | undefined,
    reasoning: boolean,
    cacheKey: string,
  ): void {
    this.familiarity.add(point, features);
    this.labeled[point] = (this.labeled[point] ?? 0) + 1;
    this.difficulty.train(point, features, reasoning || labelKey === undefined);
    if (labelKey === undefined) return;
    const label = candidates.find((candidate) => candidate.key === labelKey);
    if (!label) return;
    this.patterns.add(point, features.signature, label.spec.id);
    this.cache.reward(cacheKey, labelKey, true);
    this.head.train(point, features, candidates, labelKey);
  }

  /** Learn from the observed result of an action Reflex chose itself. */
  learnOutcome(
    point: string,
    features: Features,
    candidates: readonly Candidate[],
    key: string,
    success: boolean,
    cacheKey: string,
  ): void {
    const chosen = candidates.find((candidate) => candidate.key === key);
    if (!chosen) return;
    if (success) {
      this.cache.reward(cacheKey, key, true);
      this.patterns.add(point, features.signature, chosen.spec.id, 0.5);
      this.head.train(point, features, candidates, key, 0.5);
    } else {
      this.cache.reward(cacheKey, key, false);
      this.patterns.add(point, features.signature, chosen.spec.id, -1);
      this.head.penalize(point, features, candidates, key);
    }
  }
}
