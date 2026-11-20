// Generates the test app, bundles it with Rolldown, and writes two bundles:
//
//   out/cjsmix-<N>/before.js  the bundle as Rolldown wrote it (`__copyProps` with bound getters)
//   out/cjsmix-<N>/after.js   the same bundle, with `__copyProps` replaced by the code of the PR
//
// Usage: node make-app.mjs [--modules N] [--rolldown <path to the rolldown package>]
//
// Without --rolldown, the script uses the `rolldown` package from node_modules.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
let modules = 1000, rolldownDir = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--modules") modules = Number(args[++i]);
  else if (args[i] === "--rolldown") rolldownDir = path.resolve(args[++i]);
  else throw new Error(`unknown argument: ${args[i]}`);
}

// `__copyProps` from rolldown/rolldown#11826 (crates/rolldown/src/runtime/runtime-base.js).
const PR_COPY_PROPS = `(to, from, except, desc) => {
  if ((from && typeof from === 'object') || typeof from === 'function') {
    for (let key of __getOwnPropNames(from)) {
      if (!__hasOwnProp.call(to, key) && key !== except) {
        desc = __getOwnPropDesc(from, key);
        __defProp(to, key, {
          get: desc && desc.get && !desc.configurable ? desc.get : () => from[key],
          enumerable: !desc || desc.enumerable,
        });
      }
    }
  }
  return to;
}`;

// Globals that the modules use. `__register` keeps its arguments alive, so Rolldown keeps every
// module, and the heap measurement sees every namespace object. drive.js loads this file first.
const GLOBALS = "var __seed = 1; var __registry = []; function __register() { for (var i = 0; i < arguments.length; i++) __registry.push(arguments[i]); }\n";

// A binary tree of N modules: module k imports modules 2k+1 and 2k+2. Every third module is
// CommonJS. An ES module imports its first child with a named import and its second child with
// `import * as`. A CommonJS module uses `require()` for both children.
function writeApp(dir, N) {
  const isCjs = (k) => k % 3 === 2, ext = (k) => (isCjs(k) ? "cjs" : "js");
  for (let k = N - 1; k >= 0; k--) {
    const c1 = 2 * k + 1 < N ? 2 * k + 1 : -1, c2 = 2 * k + 2 < N ? 2 * k + 2 : -1, kk = k & 1023;
    const lines = [];
    if (isCjs(k)) {
      if (c1 >= 0) lines.push(`const ch1 = require("./m${c1}.${ext(c1)}");`);
      if (c2 >= 0) lines.push(`const ch2 = require("./m${c2}.${ext(c2)}");`);
      lines.push(`exports.c_${k} = (${kk} + __seed${c1 >= 0 ? ` + ch1.c_${c1}` : ""}) & 1023;`);
      lines.push(`exports.g_${k} = function (x) { return (x + exports.c_${k}${c2 >= 0 ? ` + ch2.g_${c2}(x)` : ""}) | 0; };`);
      lines.push(`__register(exports.g_${k});`);
      fs.writeFileSync(path.join(dir, `m${k}.cjs`), lines.join("\n") + "\n");
      continue;
    }
    if (c1 >= 0) lines.push(`import { g_${c1}, c_${c1} } from "./m${c1}.${ext(c1)}";`);
    if (c2 >= 0) lines.push(`import * as ns_${c2} from "./m${c2}.${ext(c2)}";`);
    const fBody = `${kk}${c1 >= 0 ? ` + g_${c1}(x)` : ""}${c2 >= 0 ? ` + ns_${c2}.g_${c2}(x)` : ""}`;
    lines.push(
      `export const c_${k} = (${kk} + __seed${c1 >= 0 ? ` + c_${c1}` : ""}) & 1023;`,
      `export let n_${k} = 0;`,
      `export function g_${k}(x) { return (x + c_${k}) | 0; }`,
      `export function f_${k}(x) { n_${k}++; return (${fBody}) | 0; }`,
      `export class C_${k} { constructor(x) { this.x = x; } m() { return this.x + c_${k}; } }`,
      `__register(f_${k}, C_${k});`,
    );
    fs.writeFileSync(path.join(dir, `m${k}.js`), lines.join("\n") + "\n");
  }
  const esmNear = (j) => { while (j >= 0 && isCjs(j)) j--; return j; };
  const mid = esmNear(Math.floor(N / 2)), q = esmNear(Math.floor(N / 4));
  // The hot function that drive.js calls.
  fs.writeFileSync(path.join(dir, "entry.js"), [
    `import { f_0 } from "./m0.js";`,
    `import * as ns_mid from "./m${mid}.js";`,
    `import { C_${q} } from "./m${q}.js";`,
    `globalThis.__hot = function (x) { return (f_0(x) + ns_mid.g_${mid}(x) + new C_${q}(x).m()) | 0; };`,
  ].join("\n") + "\n");
}

// Replaces `var <name> = <expr>;` in the bundle. The expression ends at the `;` that closes its brackets.
function replaceHelper(code, name, expr) {
  const m = new RegExp(`(^|\\n)([ \\t]*)var ${name} = `).exec(code);
  if (!m) throw new Error(`no var ${name} in the bundle`);
  const start = m.index + m[0].length;
  let depth = 0, i = start, quote = null;
  for (; i < code.length; i++) {
    const c = code[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === ";" && depth === 0) break;
  }
  return code.slice(0, start) + expr.replace(/\n/g, "\n" + m[2]) + code.slice(i);
}

// Runs a bundle in a new context and returns the values of __hot for three inputs.
function valuesOf(code) {
  const ctx = vm.createContext({});
  vm.runInContext(GLOBALS, ctx);
  vm.runInContext(code, ctx);
  return [ctx.__hot(1), ctx.__hot(7), ctx.__hot(100)].join(",");
}

const entry = rolldownDir ? pathToFileURL(path.join(rolldownDir, "dist/index.mjs")).href : "rolldown";
const { build, VERSION } = await import(entry);
const out = path.join(here, "out", `cjsmix-${modules}`);
const src = path.join(out, "src");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(src, { recursive: true });
writeApp(src, modules);
fs.writeFileSync(path.join(out, "globals.js"), GLOBALS);

const before = path.join(out, "before.js");
await build({ input: path.join(src, "entry.js"), logLevel: "silent", output: { file: before, format: "iife" } });
const code = fs.readFileSync(before, "utf8");
if (!code.includes(".bind(null, key)")) {
  throw new Error(`Rolldown ${VERSION} does not use bound getters in __copyProps. Use a Rolldown version from before the PR.`);
}
const after = replaceHelper(code, "__copyProps", PR_COPY_PROPS);
fs.writeFileSync(path.join(out, "after.js"), after);

const want = valuesOf(code), got = valuesOf(after);
if (want !== got) throw new Error(`before.js and after.js compute different values: ${want} vs ${got}`);
console.log(`Rolldown ${VERSION}: wrote ${path.relative(here, out)}/before.js and after.js (${modules} modules, ${(code.match(/__toESM\(/g) || []).length} __toESM calls)`);
