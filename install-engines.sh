#!/bin/sh
# Downloads the JavaScript engine shells into ./engines (Linux x64 only) and writes launchers
# into ./engines/bin: d8 (V8), jsc (JavaScriptCore trunk), sm (SpiderMonkey), and bun.
# Needs curl, unzip, and sha256sum.
set -eu
cd "$(dirname "$0")"
E=$PWD/engines
mkdir -p "$E/bin" "$E/tmp"
cd "$E/tmp"

V8=16.0.80          # V8 canary build
JSC=327089@main     # JavaScriptCore trunk, built by the WebKitGTK project
BUN=1.4.4

if [ ! -x "$E/v8/d8" ]; then
  curl -fsSLO "https://storage.googleapis.com/chromium-v8/official/canary/v8-linux64-rel-$V8.zip"
  mkdir -p "$E/v8" && unzip -q -o "v8-linux64-rel-$V8.zip" -d "$E/v8" && rm "v8-linux64-rel-$V8.zip"
fi
printf '#!/bin/sh\nexec "%s/v8/d8" --snapshot_blob="%s/v8/snapshot_blob.bin" "$@"\n' "$E" "$E" > "$E/bin/d8"

if [ ! -x "$E/jsc/jsc" ]; then
  curl -fsSL -o jsc.zip "https://webkitgtk.org/jsc-built-products/x86_64/release/$JSC.zip"
  curl -fsSL -o jsc.sha "https://webkitgtk.org/jsc-built-products/x86_64/release/$JSC.sha256sum"
  echo "$(cut -d' ' -f1 jsc.sha)  jsc.zip" | sha256sum -c -
  mkdir -p "$E/jsc" && unzip -q -o jsc.zip -d "$E/jsc" && rm jsc.zip jsc.sha
fi
printf '#!/bin/sh\nexec "%s/jsc/jsc" "$@"\n' "$E" > "$E/bin/jsc"

# Mozilla keeps only the latest nightly at this URL, so the version changes over time.
if [ ! -x "$E/sm/js" ]; then
  curl -fsSL -o js.zip https://archive.mozilla.org/pub/firefox/nightly/latest-mozilla-central/jsshell-linux-x86_64.zip
  mkdir -p "$E/sm" && unzip -q -o js.zip -d "$E/sm" && rm js.zip
fi
printf '#!/bin/sh\nLD_LIBRARY_PATH="%s/sm" exec "%s/sm/js" "$@"\n' "$E" "$E" > "$E/bin/sm"

if [ ! -x "$E/bun/bun" ]; then
  curl -fsSLO "https://github.com/oven-sh/bun/releases/download/bun-v$BUN/bun-linux-x64.zip"
  curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v$BUN/SHASUMS256.txt" | grep ' bun-linux-x64.zip$' | sha256sum -c -
  unzip -q -o bun-linux-x64.zip && rm bun-linux-x64.zip && rm -rf "$E/bun" && mv bun-linux-x64 "$E/bun"
fi
ln -sfn "$E/bun/bun" "$E/bin/bun"
chmod +x "$E/bin/d8" "$E/bin/jsc" "$E/bin/sm"
cd "$E" && rmdir tmp 2>/dev/null || true

echo "d8   $("$E/bin/d8" -e 'print(version())')"
echo "jsc  $JSC"
echo "sm   $("$E/bin/sm" --version 2>&1 | head -1)"
echo "bun  $("$E/bin/bun" --version)"
