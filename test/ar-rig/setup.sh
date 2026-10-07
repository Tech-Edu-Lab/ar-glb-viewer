#!/usr/bin/env bash
# AR検証リグの準備（管理者権限は不要）。
# ヘッドレスChromiumと、その実行に足りない共有ライブラリを ~/.cache/material-ar-rig に用意する。
# リポジトリの外に置くので、何度消えても ./setup.sh で作り直せる。
set -euo pipefail
RIG="${AR_RIG_HOME:-$HOME/.cache/material-ar-rig}"
mkdir -p "$RIG/libs" && cd "$RIG"

[ -f package.json ] || npm init -y >/dev/null
[ -d node_modules/playwright-core ] || npm install --silent playwright-core@1.63.0
npx --yes playwright-core@1.63.0 install chromium >/dev/null

CHROME=$(ls -d "$HOME"/.cache/ms-playwright/chromium-*/chrome-linux64/chrome | tail -1)
if LD_LIBRARY_PATH="$RIG/libs/usr/lib/x86_64-linux-gnu" ldd "$CHROME" | grep -q "not found"; then
  # sudo なしで .deb を取得して展開するだけ（システムには何も入れない）
  (cd libs && apt-get download libnss3 libnspr4 libasound2t64 >/dev/null && for f in *.deb; do dpkg-deb -x "$f" .; done && rm -f *.deb)
fi
if LD_LIBRARY_PATH="$RIG/libs/usr/lib/x86_64-linux-gnu" ldd "$CHROME" | grep "not found"; then
  echo "Chromium に必要なライブラリがまだ足りません（上の一覧）。" >&2; exit 1
fi
echo "準備できました: $RIG"
echo "  chrome: $CHROME"
