// Runs drive.js on before.js and after.js, one process for each measurement, and prints a table.
//
// Usage: node run.mjs [--modules N] [--mode hot|startup|mem] [--rounds R] [--cpu C] [name=path ...]
//
// Each name=path is a JavaScript engine. The name starts with node, bun, d8, jsc, or sm, so that
// run.mjs knows how to pass the arguments (for example `d8=~/.jsvu/bin/v8`, `jsc-safari27=./jsc`).
// Without engines, run.mjs uses the Node that runs it.
// In each round, the engine and bundle pairs run in a shuffled order. The table shows the median of
// the rounds. --cpu pins each process to one CPU with taskset (Linux only).
// Each result is also appended to results.jsonl.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
let modules = 1000, mode = "hot", rounds = 5, cpu = null;
const engines = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--modules") modules = Number(args[++i]);
  else if (a === "--mode") mode = args[++i];
  else if (a === "--rounds") rounds = Number(args[++i]);
  else if (a === "--cpu") cpu = args[++i];
  else if (a.includes("=")) {
    const [name, bin] = [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)];
    const kind = ["node", "bun", "d8", "jsc", "sm"].find((k) => name.startsWith(k));
    if (!kind) throw new Error(`the engine name must start with node, bun, d8, jsc, or sm: ${name}`);
    engines.push({ name, kind, bin: bin.replace(/^~(?=\/)/, process.env.HOME) });
  } else throw new Error(`unknown argument: ${a}`);
}
if (!["hot", "startup", "mem"].includes(mode)) throw new Error(`unknown mode: ${mode}`);
if (!engines.length) engines.push({ name: "node", kind: "node", bin: process.execPath });
// drive.js reads heap counters only in Node, Bun, and the SpiderMonkey shell.
const used = mode === "mem" ? engines.filter((e) => ["node", "bun", "sm"].includes(e.kind)) : engines;

const dir = path.join(here, "out", `cjsmix-${modules}`);
const bundles = ["before", "after"];
for (const b of bundles) {
  if (!fs.existsSync(path.join(dir, `${b}.js`))) throw new Error(`missing ${b}.js: run node make-app.mjs --modules ${modules}`);
}
const drive = path.join(here, "drive.js");
const argvOf = (e, bundle) => {
  const rest = [mode, path.join(dir, `${bundle}.js`)];
  if (e.kind === "node") return [e.bin, "--expose-gc", drive, ...rest];
  if (e.kind === "d8" || e.kind === "jsc") return [e.bin, drive, "--", ...rest];
  return [e.bin, drive, ...rest];
};

// A small seeded shuffle, so that a run is repeatable.
function shuffle(list, seed) {
  let s = (seed + 1) * 2654435761 >>> 0 || 1;
  for (let i = list.length - 1; i > 0; i--) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    const j = s % (i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

const results = [];
const log = fs.openSync(path.join(here, "results.jsonl"), "a");
const total = rounds * used.length * bundles.length;
let done = 0;
for (let r = 0; r < rounds; r++) {
  const jobs = shuffle(used.flatMap((e) => bundles.map((b) => ({ e, b }))), r);
  for (const { e, b } of jobs) {
    let argv = argvOf(e, b);
    if (cpu !== null) argv = ["taskset", "-c", cpu, ...argv];
    const p = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 600_000 });
    const text = (p.stdout || "") + (p.stderr || "") + (p.error ? String(p.error) : "");
    const m = /^(?:hot ([\d.]+) ns|startup ([\d.]+) ms|mem (\{.*\}))/m.exec(text);
    if (!m) throw new Error(`${e.name} ${b}.js failed:\n${text.slice(-800)}`);
    const rec = { modules, mode, round: r, engine: e.name, bundle: b };
    if (m[3]) rec.mem = JSON.parse(m[3]);
    else rec.value = Number(m[1] || m[2]);
    results.push(rec);
    fs.writeSync(log, JSON.stringify(rec) + "\n");
    if (process.stderr.isTTY) process.stderr.write(`\r${++done}/${total}`);
  }
}
if (process.stderr.isTTY) process.stderr.write("\n");

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
const fmt = (v) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
const pick = (e, b) => results.filter((x) => x.engine === e.name && x.bundle === b);
if (mode === "mem") {
  console.log(`\nHeap growth after the load and a full GC (cjsmix-${modules}, median of ${rounds} processes):\n`);
  console.log("| Engine | Counter | before | after | Change |\n| --- | --- | ---: | ---: | ---: |");
  for (const e of used) {
    for (const k of Object.keys(pick(e, "before")[0].mem)) {
      const v0 = median(pick(e, "before").map((x) => x.mem[k])), v1 = median(pick(e, "after").map((x) => x.mem[k]));
      console.log(`| ${e.name} | ${k} | ${v0.toLocaleString("en-US")} | ${v1.toLocaleString("en-US")} | ${(100 * (v1 / v0 - 1)).toFixed(1)}% |`);
    }
  }
} else {
  const unit = mode === "hot" ? "ns for one call of __hot()" : "ms for one load of the bundle";
  console.log(`\n${unit} (cjsmix-${modules}, median of ${rounds} processes, lower is better):\n`);
  console.log("| Engine | before | after |\n| --- | ---: | ---: |");
  for (const e of used) {
    console.log(`| ${e.name} | ${fmt(median(pick(e, "before").map((x) => x.value)))} | ${fmt(median(pick(e, "after").map((x) => x.value)))} |`);
  }
}
