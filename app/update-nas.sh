#!/bin/bash
# ══════════════════════════════════════════════════════════════════════
#  furniture-cad NAS 一键更新脚本（群晖 Docker）
#
#  第一次（只需做一次）：
#    curl -sSL https://raw.githubusercontent.com/otscup/furniture-cad/master/app/update-nas.sh \
#      -o /volume1/docker/update-cad.sh && chmod +x /volume1/docker/update-cad.sh
#
#  以后每次 GitHub 有更新，在 NAS 上跑一次：
#    bash /volume1/docker/update-cad.sh
#
#  脚本会：备份 data/ → 从 GitHub 拉最新代码 → 清理旧源码 →
#          重建镜像 → 重启容器 → 验收（健康 + data 可写）。
#  data/（账号库/审计/记忆/.env）一个字节都不动。
#
#  幂等：SSH 断线/中途失败，直接重跑一次即可。
#  回滚：停容器 → 把 _backup-<时间>/data 拷回 → docker compose up -d
# ══════════════════════════════════════════════════════════════════════
set -euo pipefail

D=/volume1/docker/furniture-cad          # 部署目录（根目录布局 = 仓库 app/ 的内容）
DOCKER="sudo -n /usr/local/bin/docker"  # 群晖上必须全路径，简写不在 PATH
REPO="otscup/furniture-cad"
BRANCH="master"
IMG="furniture-cad-furniture-cad:latest"
PORT=8787
SELF_URL="https://raw.githubusercontent.com/$REPO/$BRANCH/app/update-nas.sh"

log() { echo "[$(date +%H:%M:%S)] $*"; }
die() { echo "❌ $*" >&2; exit 1; }

# ── 0. 脚本自更新（更新逻辑本身也要与时俱进） ──
TMP_SELF="$(mktemp)"
if curl -sSL --fail -o "$TMP_SELF" "$SELF_URL" 2>/dev/null; then
  if ! cmp -s "$TMP_SELF" "$0" 2>/dev/null; then
    log "脚本有新版，切换到新版继续…"
    exec bash "$TMP_SELF" "$@"
  fi
fi
rm -f "$TMP_SELF"

[ -d "$D" ] || die "部署目录不存在：$D"
[ -d "$D/data" ] || die "$D/data 不存在 —— 卷数据没了？先别动，人工检查"

# ── 1. 备份（data/ + compose） ──
TS="$(date +%Y%m%d-%H%M%S)"
BK="$D/_backup-$TS"
log "备份 → $BK"
mkdir -p "$BK"
cp -a "$D/data" "$BK/" || die "备份 data/ 失败"
cp -a "$D/docker-compose.yml" "$BK/" 2>/dev/null || true
cp -a "$D/docker-compose.override.yml" "$BK/" 2>/dev/null || true

# ── 2. 从 GitHub 拉最新代码 ──
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
log "下载 $REPO@$BRANCH…"
curl -sSL --fail -o "$TMP/src.tar.gz" \
  "https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz" || die "下载失败（检查 NAS 外网）"
tar xzf "$TMP/src.tar.gz" -C "$TMP"
SRC="$TMP/furniture-cad-$BRANCH/app"
[ -f "$SRC/docker-compose.yml" ] || die "解包结构不对，缺 docker-compose.yml"

# ── 3. 清理 root 属主的旧源码目录 ──
# 旧部署留下的 src/ server/ 等是 root 所有，直接覆盖会 tar 报错。
# sudo 只放行 docker，所以让容器自己动手（deploy-nas.md 第二节）。
log "清理旧源码目录…"
# shellcheck disable=SC2086
$DOCKER run --rm -u 0 -v "$D:/srv" "$IMG" \
  sh -c 'rm -rf /srv/src /srv/public /srv/py /srv/server /srv/shared /srv/scripts /srv/dist' \
  2>/dev/null || log "（旧镜像不存在，跳过容器清理）"

# ── 4. 同步新代码（data/ 不在同步范围，它是卷） ──
log "同步新代码…"
(cd "$SRC" && tar cf - --exclude=data .) | (cd "$D" && tar xf -)

# ── 4.5 权限归一（2026-10-03 生产事故教训） ──
# 宿主机文件可能因 umask/tar 解压变成 700，Docker COPY 会把权限原样带进镜像，
# 而容器以 node（UID 1000）运行 → EACCES crash-loop。
# Dockerfile 里已有 `chown -R node:node /app` 兜底，这里再把宿主机侧的可读位补上，
# 双保险（且让宿主机上的文件本身也可读，方便排查）。
log "归一化代码目录权限…"
for d in server src shared py scripts dist public; do
  [ -d "$D/$d" ] && chmod -R a+rX "$D/$d"
done
# 注意：绝不碰 data/（里面有 .env 密钥，a+r 会让它宿主机全局可读）

# ── 5. 重建镜像并重启 ──
cd "$D"
OLD_IMG_ID="$($DOCKER images -q "$IMG" 2>/dev/null | head -1 || true)"
log "构建镜像…（几分钟，别关会话）"
# shellcheck disable=SC2086
$DOCKER compose up -d --build || die "构建失败"
sleep 3
# 补一次不带 --build 的（SSH 断线坑：构建完容器可能停在 Created，见 deploy-nas.md）
# shellcheck disable=SC2086
$DOCKER compose up -d || die "启动失败"
NEW_IMG_ID="$($DOCKER images -q "$IMG" 2>/dev/null | head -1 || true)"
if [ -n "$OLD_IMG_ID" ] && [ "$OLD_IMG_ID" = "$NEW_IMG_ID" ]; then
  log "⚠️ 镜像 ID 没变 —— 代码可能没变化，或构建用了缓存"
else
  log "镜像已更新：${OLD_IMG_ID:-无} → ${NEW_IMG_ID:-未知}"
fi

# ── 6. 验收 ──
log "等服务启动…"
ok=0
for _ in $(seq 1 30); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/health" 2>/dev/null)" = "200" ]; then
    ok=1; break
  fi
  sleep 2
done
[ "$ok" = "1" ] || die "服务 60 秒没起来，看 docker logs"
HEALTH="$(curl -s "http://127.0.0.1:$PORT/api/health")"
echo "$HEALTH" | grep -q '"ok":true' || die "健康检查 ok≠true"

# 四之一的坑：data/ 变成 root 属主会导致"一切正常但写不进盘"
if echo "$HEALTH" | grep -q '"dataWritable":true'; then
  log "data/ 可写 ✅"
else
  echo "⚠️ data/ 不可写！修完再走（deploy-nas.md「四之一」）："
  echo "  sudo -n /usr/local/bin/docker run --rm -u 0 -v $D:/srv alpine \\"
  echo "    sh -c 'chown -R 1000:1000 /srv/data && chmod -R u+rwX /srv/data'"
  exit 1
fi

C="$($DOCKER ps --filter name=furniture-cad --format '{{.Names}}' | head -1)"
log "容器：$C"
echo ""
log "✅ 更新完成。备份在 $BK（保留 7 天内的即可，旧的可删）"
