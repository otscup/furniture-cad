#!/usr/bin/env bash
# Phase 0 Spike 一键复现：语义模型 → 板件模型 → DXF → 验证 → 预览图
#
#   bash spike/run.sh
#
set -euo pipefail

NODE="${NODE:-C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe}"
PY="${PY:-$(cd "$(dirname "$0")/.." && pwd)/.venv/Scripts/python.exe}"

cd "$(dirname "$0")"
echo "── 1/5 Semantic Model → Panel Model ──"
"$NODE" --experimental-strip-types --no-warnings src/main.ts

echo
echo "── 2/5 Panel Model → DXF（R2007 + R2000/GBK 双版本）──"
"$PY" py/export_dxf.py

echo
echo "── 3/5 DXF 交付验证（ezdxf：严格读取 + audit + 回读断言）──"
"$PY" py/verify_dxf.py
"$PY" py/verify_dxf.py out/Cabinet_001_R2000_GBK.dxf

echo
echo "── 4/5 独立解析器交叉验证（dxf-parser）──"
"$NODE" js/verify-with-dxf-parser.mjs

echo
echo "── 5/5 渲染预览图 ──"
"$PY" py/render_preview.py

echo
echo "✔ 全部完成。产物在 spike/out/"
ls -1 out/
