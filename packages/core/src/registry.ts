import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PolicyRuntime, type PolicyFile, type PolicyMetrics } from "./policy.ts";
import { sanitizeName } from "./util.ts";

export interface PolicyVersionInfo {
  id: string;
  parent?: string;
  createdAt: string;
  note?: string;
  metrics?: PolicyMetrics;
}

interface Manifest {
  workload: string;
  current?: string;
  /** Promotion history, most recent last. Used by rollback. */
  history: string[];
  versions: PolicyVersionInfo[];
}

function writeAtomic(path: string, content: string): void {
  const tmp = path + ".tmp-" + process.pid;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/** Versioned policies per workload under `<dataDir>/policies/<workload>/`. */
export class PolicyRegistry {
  readonly dir: string;
  readonly workload: string;

  constructor(dataDir: string, workload: string) {
    this.workload = workload;
    this.dir = join(dataDir, "policies", sanitizeName(workload));
  }

  private manifestPath(): string {
    return join(this.dir, "manifest.json");
  }

  manifest(): Manifest {
    const path = this.manifestPath();
    if (!existsSync(path)) return { workload: this.workload, history: [], versions: [] };
    return JSON.parse(readFileSync(path, "utf8")) as Manifest;
  }

  private writeManifest(manifest: Manifest): void {
    mkdirSync(this.dir, { recursive: true });
    writeAtomic(this.manifestPath(), JSON.stringify(manifest, null, 2));
  }

  list(): PolicyVersionInfo[] {
    return this.manifest().versions;
  }

  current(): string | undefined {
    return this.manifest().current;
  }

  load(version: string): PolicyRuntime {
    const path = join(this.dir, `${sanitizeName(version)}.json`);
    return PolicyRuntime.fromJSON(JSON.parse(readFileSync(path, "utf8")) as PolicyFile);
  }

  loadCurrent(): PolicyRuntime | undefined {
    const current = this.current();
    return current ? this.load(current) : undefined;
  }

  /** Save a policy as a new candidate version (not promoted). */
  save(policy: PolicyRuntime, note?: string): string {
    const manifest = this.manifest();
    const numbers = manifest.versions.map((version) => Number(version.id.replace(/^v/, ""))).filter(Number.isFinite);
    const id = `v${(numbers.length ? Math.max(...numbers) : 0) + 1}`;
    policy.parent = manifest.current;
    policy.version = id;
    const file = policy.toJSON(note);
    mkdirSync(this.dir, { recursive: true });
    writeAtomic(join(this.dir, `${id}.json`), JSON.stringify(file));
    const info: PolicyVersionInfo = { id, createdAt: file.createdAt };
    if (file.parent) info.parent = file.parent;
    if (note) info.note = note;
    if (file.metrics) info.metrics = file.metrics;
    manifest.versions.push(info);
    this.writeManifest(manifest);
    return id;
  }

  promote(version: string): void {
    const manifest = this.manifest();
    if (!manifest.versions.some((info) => info.id === version)) {
      throw new Error(`Unknown policy version ${version} for workload ${this.workload}`);
    }
    manifest.current = version;
    manifest.history.push(version);
    this.writeManifest(manifest);
  }

  /** Re-promote the previously promoted version. Returns it, or undefined if there is none. */
  rollback(): string | undefined {
    const manifest = this.manifest();
    if (manifest.history.length < 2) {
      manifest.current = undefined;
      manifest.history = [];
      this.writeManifest(manifest);
      return undefined;
    }
    manifest.history.pop();
    manifest.current = manifest.history[manifest.history.length - 1];
    this.writeManifest(manifest);
    return manifest.current;
  }

  versionsOnDisk(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((name) => /^v\d+\.json$/.test(name))
      .map((name) => name.replace(/\.json$/, ""));
  }
}
