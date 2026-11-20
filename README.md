# Benchmark: bound getters in Rolldown's `__copyProps`

This benchmark measures how fast bundled code reads an export through a namespace object that Rolldown builds between CommonJS and ES modules. It compares the `__copyProps` runtime helper of Rolldown 1.3.3, which makes each getter a bound function, with the version from [this change](https://github.com/magurotuna/rolldown/commit/2677d6626c5da00614eeb63fb1f5872bedfbf1f9), which makes each getter a closure.

## Quick start (Node only)

You need Node 26 or later.

```sh
git clone https://github.com/magurotuna/rolldown-copyprops-bench
cd rolldown-copyprops-bench
npm ci
npm run bench
```

The last command prints a table like this one:

```
ns for one call of __hot() (cjsmix-1000, median of 5 processes, lower is better):

| Engine | before | after |
| --- | ---: | ---: |
| node | 111 | 2.94 |
```

## What the benchmark does

1. `make-app.mjs` generates an app of 1,000 modules in `out/cjsmix-1000/src/`.
   - The modules form a binary tree: module k imports modules 2k+1 and 2k+2.
   - Every third module is CommonJS. The other modules are ES modules.
   - An ES module imports its first child with a named import and its second child with `import * as`. A CommonJS module uses `require()`.
   - The entry defines `globalThis.__hot`. A call of `__hot` walks down the tree and reads exports through the namespace objects.
2. `make-app.mjs` bundles the app with Rolldown into one IIFE file, `before.js`.
3. `make-app.mjs` writes `after.js`: a copy of `before.js` in which `__copyProps` is replaced with the code from the change. Rolldown built from the change writes the same function; only the formatting differs.
4. `make-app.mjs` checks that `before.js` and `after.js` return the same values.
5. `run.mjs` starts a new process of `drive.js` for each measurement and prints the median.
   - `drive.js` calls `__hot` 2,000,000 times in each of 9 rounds, and prints the fastest round in ns per call.
   - Node and Bun load the bundle with `vm.runInThisContext`, so that every engine runs it as a classic script.
   - In each round, `run.mjs` runs the engine and bundle pairs in a shuffled order.

## Other engines

`install-engines.sh` downloads V8 (`d8`), JavaScriptCore (`jsc`), SpiderMonkey (`sm`), and Bun into `engines/`. It works only on Linux x64.

```sh
sh install-engines.sh
node run.mjs --cpu 7 node=$(command -v node) bun=engines/bin/bun d8=engines/bin/d8 sm=engines/bin/sm jsc=engines/bin/jsc
```

- Each engine is a `name=path` argument. The name must start with `node`, `bun`, `d8`, `jsc`, or `sm`, so that `run.mjs` knows how to pass the arguments. For example, `jsc-safari27=/path/to/jsc` is a JavaScriptCore shell.
- `--cpu 7` pins each process to CPU 7 with `taskset`. Remove it on a system without `taskset`.
- `--rounds N` sets the number of processes for each engine and bundle (default: 5).
- To use your own Rolldown build, run `node make-app.mjs --rolldown <path to packages/rolldown>`. The build must be from before the change, because `make-app.mjs` replaces the bound getters.

### Safari's JavaScriptCore

Safari 26 and Safari 27 do not have the JavaScriptCore change that inlines bound getters. To measure them, build a `jsc` shell from a Safari branch of WebKit. We used `safari-7625.2.8.18-branch` for Safari 27 and `safari-7624.5.1.11-branch` for Safari 26:

```sh
git clone --depth 1 --branch safari-7625.2.8.18-branch https://github.com/WebKit/WebKit
cd WebKit
cmake -S . -B build -G Ninja -DPORT=JSCOnly -DCMAKE_BUILD_TYPE=Release \
  -DENABLE_STATIC_JSC=ON -DDEVELOPER_MODE=OFF -DENABLE_TOOLS=OFF -DENABLE_API_TESTS=OFF \
  -DUSE_THIN_ARCHIVES=OFF -DCMAKE_C_COMPILER=gcc -DCMAKE_CXX_COMPILER=g++
ninja -C build jsc
```

Then pass `jsc-safari27=WebKit/build/bin/jsc` to `run.mjs`.

## Heap

```sh
node make-app.mjs --modules 10000
node run.mjs --modules 10000 --mode mem --rounds 3 node=$(command -v node) bun=engines/bin/bun sm=engines/bin/sm
```

The table shows how much the heap grows after the bundle loads and a full garbage collection runs. Only Node, Bun, and SpiderMonkey report heap counters.

## Results

We measured on a Linux VM with 16 vCPUs (AMD EPYC 9965), with each process pinned to one CPU, on 2026-11-20.

| Engine | Version |
| --- | --- |
| Node | 26.13.1 |
| Bun | 1.4.4 |
| V8 (`d8`) | 16.0.80 |
| SpiderMonkey | nightly of 2026-11-20 (JavaScript-C163.0a1) |
| JavaScriptCore | 327089@main |

ns for one call of `__hot()` (`cjsmix-1000`, median of 5 processes, lower is better):

| Engine | before | after |
| --- | ---: | ---: |
| node | 111 | 2.94 |
| bun | 9.75 | 1.69 |
| d8 | 117 | 2.78 |
| sm | 134 | 12.0 |
| jsc | 4.70 | 4.81 |

Heap growth after the load and a full GC (`cjsmix-10000`, median of 3 processes):

| Engine | Counter | before | after | Change |
| --- | --- | ---: | ---: | ---: |
| node | usedHeapSize | 31,333,472 | 30,100,912 | -3.9% |
| bun | heapSize | 17,832,809 | 16,390,828 | -8.1% |
| sm | gcBytes | 18,796,544 | 17,432,576 | -7.3% |

## Files

| File | Contents |
| --- | --- |
| `make-app.mjs` | Generates the app and writes `before.js` and `after.js` |
| `drive.js` | Loads one bundle in one engine and prints one measurement |
| `run.mjs` | Runs `drive.js` for each engine and bundle, and prints the table |
| `install-engines.sh` | Downloads the engine shells (Linux x64) |

## License

MIT
