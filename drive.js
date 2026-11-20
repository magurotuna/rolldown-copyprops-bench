// Loads one bundle and prints one measurement. run.mjs starts one process for each measurement.
//
//   <engine> drive.js [--] <mode> <bundle>
//
// mode:
//   hot      calls globalThis.__hot in a loop; prints the best of 9 rounds in ns per call
//   startup  prints the time of one load of the bundle in ms
//   mem      loads the bundle, collects garbage, and prints the heap growth (engine-specific counters)
// d8 and jsc need `--` before the arguments. The SpiderMonkey shell, Node, and Bun do not.
// drive.js first loads globals.js from the directory of the bundle.
var isNodeLike = typeof process !== "undefined" && !!process.argv;
var args = isNodeLike ? process.argv.slice(2)
  : (typeof scriptArgs !== "undefined" && scriptArgs) || (typeof arguments !== "undefined" && arguments) || [];
var __print = typeof print === "function" ? print : function (s) { console.log(s); };
var now = typeof preciseTime === "function" ? function () { return preciseTime() * 1e3; } : function () { return performance.now(); };
var mode = args[0], bundle = args[1];
var readFile = function (f) { return require("fs").readFileSync(f, "utf8"); };
// Node and Bun compile the bundle as a classic script with vm.runInThisContext; the shells use load().
var runScript = isNodeLike
  ? function (src, f) { require("vm").runInThisContext(src, { filename: f }); }
  : function (src, f) { load(f); };
var dir = bundle.replace(/\/[^\/]*$/, "");
var src = isNodeLike ? readFile(bundle) : null;
runScript(isNodeLike ? readFile(dir + "/globals.js") : null, dir + "/globals.js");

var __K = new Array(1024).fill(0), __ki = 0;
function __sink(v) { __K[__ki = (__ki + 1) & 1023] = v; }

function fullGC() {
  if (typeof gc === "function") { gc(); gc(); return; }
  if (isNodeLike && typeof Bun !== "undefined") { Bun.gc(true); Bun.gc(true); return; }
  throw new Error("no gc(): run Node with --expose-gc");
}
function heap() {
  if (isNodeLike && typeof Bun !== "undefined") {
    var s = require("bun:jsc").heapStats();
    return { heapSize: s.heapSize, objectCount: s.objectCount };
  }
  if (isNodeLike) {
    var v8 = require("v8");
    var h = v8.getHeapStatistics();
    return { usedHeapSize: h.used_heap_size };
  }
  if (typeof gcparam === "function") return { gcBytes: gcparam("gcBytes") };
  return {};
}
function nodeObjectCount() {
  // Counts the nodes of a V8 heap snapshot (objects, strings, code, and so on).
  var v8 = require("v8");
  var f = v8.writeHeapSnapshot(require("path").join(require("os").tmpdir(), "hs-" + process.pid + ".heapsnapshot"));
  var fd = require("fs").openSync(f, "r"), buf = Buffer.alloc(4096);
  require("fs").readSync(fd, buf, 0, 4096, 0);
  require("fs").closeSync(fd);
  require("fs").unlinkSync(f);
  return +/"node_count":(\d+)/.exec(buf.toString("utf8"))[1];
}

if (mode === "startup") {
  var t0 = now();
  runScript(src, bundle);
  var t1 = now();
  __sink(__hot(1));
  __print("startup " + (t1 - t0).toFixed(3) + " ms");
} else if (mode === "hot") {
  runScript(src, bundle);
  var hot = globalThis.__hot, N = 2000000;
  for (var i = 0; i < N / 4; i++) __sink(hot(i & 1023));
  var best = Infinity;
  for (var r = 0; r < 9; r++) {
    var t0 = now();
    for (var i = 0; i < N; i++) __sink(hot(i & 1023));
    best = Math.min(best, (now() - t0) * 1e6 / N);
  }
  __print("hot " + best.toFixed(3) + " ns " + (__K[5] & 1));
} else if (mode === "mem") {
  fullGC();
  var before = heap(), objBefore = isNodeLike && typeof Bun === "undefined" ? nodeObjectCount() : 0;
  runScript(src, bundle);
  __sink(__hot(1));
  fullGC();
  var after = heap(), out = {};
  for (var k in after) out[k] = after[k] - before[k];
  if (isNodeLike && typeof Bun === "undefined") out.snapshotNodes = nodeObjectCount() - objBefore;
  __print("mem " + JSON.stringify(out));
} else {
  throw new Error("unknown mode " + mode);
}
