#!/bin/bash
# 追魅 / 昕达控制器 构建脚本
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
TOOLS="${ANDROID_TOOLS:-$ROOT/tools}"
BT="${BUILD_TOOLS_DIR:-$TOOLS/build-tools/android-16}"
AAPT2="$TOOLS/aapt2"
AJAR="${ANDROID_JAR:-$TOOLS/platform/android-36/android.jar}"
KS="${KEYSTORE:-$ROOT/debug.keystore}"
STORE_PASS="${STORE_PASS:-android}"
KEY_PASS="${KEY_PASS:-$STORE_PASS}"
APP="$ROOT/app"
BUILD="$ROOT/build"
OUT="${1:-$ROOT/dist/xinda-controller.apk}"

for f in "$AAPT2" "$AJAR" "$BT/d8" "$BT/apksigner" "$BT/zipalign"; do
  [ -x "$f" ] || { echo "缺少构建工具: $f （设置 ANDROID_TOOLS 或放到 tools/）" >&2; exit 1; }
done

if [ ! -f "$KS" ]; then
  echo "==> 生成调试签名"
  keytool -genkeypair -keystore "$KS" -storepass "$STORE_PASS" -keypass "$KEY_PASS" \
    -alias debug -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Debug, O=xinda-controller, C=CN" >/dev/null 2>&1
fi

rm -rf "$BUILD"
mkdir -p "$(dirname "$OUT")" "$BUILD/gen" "$BUILD/classes" "$BUILD/dex" "$BUILD/res"

echo "==> aapt2 compile"
"$AAPT2" compile --dir "$APP/res" -o "$BUILD/res.zip"
echo "==> aapt2 link"
"$AAPT2" link -o "$BUILD/base.apk" -I "$AJAR" \
  --manifest "$APP/AndroidManifest.xml" -A "$APP/assets" \
  --java "$BUILD/gen" --min-sdk-version 21 --target-sdk-version 34 "$BUILD/res.zip"

echo "==> javac"
find "$APP/java" "$BUILD/gen" -name '*.java' > "$BUILD/sources.txt"
javac -encoding UTF-8 -source 8 -target 8 -nowarn -bootclasspath "$AJAR" \
  -d "$BUILD/classes" @"$BUILD/sources.txt" 2>&1 | grep -v 'bootstrap class path' || true

echo "==> d8"
find "$BUILD/classes" -name '*.class' > "$BUILD/classes.txt"
"$BT/d8" --lib "$AJAR" --min-api 21 --output "$BUILD/dex" @"$BUILD/classes.txt"

echo "==> package / zipalign / sign"
cp "$BUILD/base.apk" "$BUILD/unsigned.apk"
( cd "$BUILD/dex" && zip -q "$BUILD/unsigned.apk" classes.dex )
zipalign -f 4 "$BUILD/unsigned.apk" "$BUILD/aligned.apk"
"$BT/apksigner" sign --ks "$KS" --ks-pass "pass:$STORE_PASS" --key-pass "pass:$KEY_PASS" \
  --min-sdk-version 21 --out "$OUT" "$BUILD/aligned.apk"
ls -lh "$OUT"
