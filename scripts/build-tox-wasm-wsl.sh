#!/bin/sh
# Reproducible c-toxcore WebAssembly build for the Windows/WSL developer flow.
set -eu

TOX_COMMIT=da26052603369045dceb5dfc8c89919b222d0ce0
SODIUM_VERSION=1.0.20
SODIUM_SHA256=ebb65ef6ca439333c2bb41a0c1990587288da07f6c7fd07cb3a18cc18d30ce19
EMSDK_VERSION=4.0.3

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WORK="$ROOT/work/tox-wasm"
PREFIX="$WORK/prefix"
SODIUM_ARCHIVE="$WORK/libsodium-$SODIUM_VERSION.tar.gz"
SODIUM_SOURCE="$WORK/libsodium-$SODIUM_VERSION"
TOX_SOURCE="$ROOT/vendor/c-toxcore"
TOX_BUILD="$WORK/c-toxcore-build"
EM_CONFIG_FILE="$WORK/emscripten.config"

mkdir -p "$WORK" "$PREFIX" "$ROOT/public/tox"

if [ ! -d /opt/emsdk/.git ]; then
  echo 'Install emsdk 4.0.3 in /opt/emsdk before running this script.' >&2
  exit 1
fi

cat > "$EM_CONFIG_FILE" <<'EOF'
NODE_JS = '/opt/emsdk/node/20.18.0_64bit/bin/node'
LLVM_ROOT = '/opt/emsdk/upstream/bin'
BINARYEN_ROOT = '/opt/emsdk/upstream'
EMSCRIPTEN_ROOT = '/opt/emsdk/upstream/emscripten'
EOF
export EM_CONFIG="$EM_CONFIG_FILE"
export PATH="/opt/emsdk:/opt/emsdk/upstream/emscripten:$PATH"
export EMSDK=/opt/emsdk
export EMSDK_NODE=/opt/emsdk/node/20.18.0_64bit/bin/node

if ! emcc --version | grep -q "$EMSDK_VERSION"; then
  echo "Expected Emscripten $EMSDK_VERSION." >&2
  emcc --version >&2 || true
  exit 1
fi

if [ ! -d "$TOX_SOURCE/.git" ]; then
  mkdir -p "$ROOT/vendor"
  git clone https://github.com/TokTok/c-toxcore.git "$TOX_SOURCE"
fi
git -C "$TOX_SOURCE" fetch --depth 1 origin "$TOX_COMMIT"
git -C "$TOX_SOURCE" checkout --detach "$TOX_COMMIT"
git -C "$TOX_SOURCE" submodule update --init --depth 1 third_party/cmp

if [ ! -f "$PREFIX/lib/libsodium.a" ]; then
  if [ ! -f "$SODIUM_ARCHIVE" ]; then
    curl -fsSL "https://github.com/jedisct1/libsodium/releases/download/$SODIUM_VERSION-RELEASE/libsodium-$SODIUM_VERSION.tar.gz" -o "$SODIUM_ARCHIVE"
  fi
  echo "$SODIUM_SHA256  $SODIUM_ARCHIVE" | sha256sum -c -
  rm -rf "$SODIUM_SOURCE"
  tar -xzf "$SODIUM_ARCHIVE" -C "$WORK"
  (
    cd "$SODIUM_SOURCE"
    emconfigure ./configure \
      --prefix="$PREFIX" \
      --enable-static \
      --disable-shared \
      --without-pthreads \
      --disable-ssp \
      --disable-asm \
      --disable-pie \
      --host=wasm32-unknown-emscripten
    emmake make -j"$(getconf _NPROCESSORS_ONLN)"
    emmake make install
  )
fi

export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
emcmake cmake -S "$TOX_SOURCE" -B "$TOX_BUILD" -GNinja \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$PREFIX" \
  -DCMAKE_C_FLAGS='-O3 -flto -fPIC' \
  -DCMAKE_UNITY_BUILD=ON \
  -DBUILD_TOXAV=OFF \
  -DENABLE_SHARED=OFF \
  -DENABLE_STATIC=ON \
  -DBOOTSTRAP_DAEMON=OFF \
  -DDHT_BOOTSTRAP=OFF \
  -DUNITTEST=OFF \
  -DAUTOTEST=OFF \
  -DMIN_LOGGER_LEVEL=WARNING
emmake cmake --build "$TOX_BUILD"
emmake cmake --install "$TOX_BUILD"

EXPORTED_FUNCTIONS='["_malloc","_free","_relay_tox_new","_relay_tox_kill","_relay_tox_iterate","_relay_tox_interval","_relay_tox_address","_relay_tox_savedata_size","_relay_tox_savedata","_relay_tox_set_name","_relay_tox_set_status","_relay_tox_add_friend","_relay_tox_accept_friend","_relay_tox_remove_friend","_relay_tox_send_message","_relay_tox_bootstrap","_relay_tox_add_relay","_relay_tox_friend_count","_relay_tox_friend_numbers","_relay_tox_friend_public_key"]'

emcc "$ROOT/native/tox-wasm/relayless_tox_bridge.c" \
  -I"$TOX_SOURCE" \
  -O3 -flto \
  -s ASSERTIONS=0 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s ENVIRONMENT=worker \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createToxCore \
  -s EXPORTED_FUNCTIONS="$EXPORTED_FUNCTIONS" \
  -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAP32"]' \
  -s FILESYSTEM=0 \
  -s INCOMING_MODULE_JS_API='["locateFile"]' \
  -s MALLOC=emmalloc \
  -s MODULARIZE=1 \
  -s STRICT=1 \
  --no-entry \
  "$PREFIX/lib/libtoxcore.a" \
  "$PREFIX/lib/libsodium.a" \
  -o "$ROOT/public/tox/toxcore.mjs"

test -s "$ROOT/public/tox/toxcore.mjs"
test -s "$ROOT/public/tox/toxcore.wasm"
(cd "$ROOT/public/tox" && sha256sum toxcore.mjs toxcore.wasm > SHA256SUMS)
ls -lh "$ROOT/public/tox/toxcore.mjs" "$ROOT/public/tox/toxcore.wasm"
