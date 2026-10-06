import type { Candidate } from "./actions.ts";
import type { ActionSpec, DecisionState } from "./types.ts";
import type { TaskSnapshot } from "./tasks.ts";
import { getPath, globToRegExp } from "./util.ts";

export interface RuleContext {
  point: string;
  workload: string;
  state: DecisionState;
  task?: TaskSnapshot;
  action?: ActionSpec;
  params?: unknown;
}

/** Declarative condition. Paths resolve against the RuleContext, e.g. `state.lastObservation.type`. */
export type Condition =
  | {
      path: string;
      equals?: unknown;
      in?: unknown[];
      matches?: string;
      flags?: string;
      gte?: number;
      lte?: number;
      exists?: boolean;
    }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | ((ctx: RuleContext) => boolean);

interface RuleBase {
  id?: string;
  /** Decision points this rule applies to (globs). Default: all. */
  points?: string[];
}

export type Rule =
  | (RuleBase & { type: "deny"; actions?: string[]; when?: Condition })
  | (RuleBase & { type: "allowOnly"; actions: string[]; when?: Condition })
  | (RuleBase & { type: "force"; action: string; when: Condition })
  | (RuleBase & { type: "requireEscalation"; when: Condition; reason?: string });

export interface RuleResult {
  candidates: Candidate[];
  forced?: { candidate: Candidate; ruleId: string };
  escalate?: { ruleId: string; reason: string };
  applied: string[];
}

const regexCache = new Map<string, RegExp>();
function cachedRegExp(source: string, flags = ""): RegExp {
  const key = flags + "/" + source;
  let re = regexCache.get(key);
  if (!re) {
    re = new RegExp(source, flags);
    regexCache.set(key, re);
  }
  return re;
}

function matchesGlobs(value: string, globs: readonly string[] | undefined): boolean {
  if (!globs || globs.length === 0) return true;
  return globs.some((glob) => cachedRegExp(globToRegExp(glob).source).test(value));
}

export function evaluateCondition(condition: Condition | undefined, ctx: RuleContext): boolean {
  if (condition === undefined) return true;
  if (typeof condition === "function") return Boolean(condition(ctx));
  if ("all" in condition) return condition.all.every((item) => evaluateCondition(item, ctx));
  if ("any" in condition) return condition.any.some((item) => evaluateCondition(item, ctx));
  if ("not" in condition) return !evaluateCondition(condition.not, ctx);
  const value = getPath(ctx, condition.path);
  if (condition.exists !== undefined && (value !== undefined && value !== null) !== condition.exists) return false;
  if ("equals" in condition && condition.equals !== undefined && value !== condition.equals) return false;
  if (condition.in && !condition.in.includes(value)) return false;
  if (condition.matches !== undefined) {
    const text = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
    if (!cachedRegExp(condition.matches, condition.flags ?? "").test(text)) return false;
  }
  if (condition.gte !== undefined && !(typeof value === "number" && value >= condition.gte)) return false;
  if (condition.lte !== undefined && !(typeof value === "number" && value <= condition.lte)) return false;
  return true;
}

function ruleId(rule: Rule, index: number): string {
  return rule.id ?? `${rule.type}#${index}`;
}

/**
 * Apply deterministic rules. Order of precedence:
 * requireEscalation > deny/allowOnly filtering > force.
 */
export function applyRules(rules: readonly Rule[], base: RuleContext, input: Candidate[]): RuleResult {
  let candidates = input;
  const applied: string[] = [];
  let forced: RuleResult["forced"];
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (!rule || !matchesGlobs(base.point, rule.points)) continue;
    const id = ruleId(rule, i);
    switch (rule.type) {
      case "requireEscalation":
        if (evaluateCondition(rule.when, base)) {
          applied.push(id);
          return { candidates, applied, escalate: { ruleId: id, reason: rule.reason ?? id } };
        }
        break;
      case "deny": {
        const before = candidates.length;
        candidates = candidates.filter((candidate) => {
          if (!matchesGlobs(candidate.spec.id, rule.actions)) return true;
          const ctx = { ...base, action: candidate.spec, params: candidate.spec.params };
          return !evaluateCondition(rule.when, ctx);
        });
        if (candidates.length !== before) applied.push(id);
        break;
      }
      case "allowOnly":
        if (evaluateCondition(rule.when, base)) {
          const before = candidates.length;
          candidates = candidates.filter((candidate) => matchesGlobs(candidate.spec.id, rule.actions));
          if (candidates.length !== before) applied.push(id);
        }
        break;
      case "force":
        if (!forced && evaluateCondition(rule.when, base)) {
          const target = candidates.find(
            (candidate) => candidate.spec.id === rule.action || candidate.key === rule.action,
          );
          if (target) forced = { candidate: target, ruleId: id };
        }
        break;
    }
  }
  if (forced) {
    // A later deny may have removed the forced action; only honour it if it survived.
    const survived = candidates.some((candidate) => candidate.key === forced?.candidate.key);
    if (survived) applied.push(forced.ruleId);
    else forced = undefined;
  }
  return forced ? { candidates, applied, forced } : { candidates, applied };
}
