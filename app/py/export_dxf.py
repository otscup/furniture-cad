#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
中立交换 JSON → DXF。

── 这个脚本只做一件事：把 TS 算好的图元序列化成 DXF 实体 ──

它**不做任何几何计算**：没有标注、没有排图、没有尺寸链。
所有坐标、文字内容与位置都由 TS 侧的 labels.ts / views.ts 算好，
这里只是把它们搬进 DXF。这条线是"图 = 料"的唯一保证 ——
一旦这里开始自己算标注，就有了第二份几何真相源，
"图上 2400、料单 2399" 这类问题会从结构上变得可能。

── 沿用 spike 实测出的三条硬结论（见 docs/Phase0-Spike-Report.md）──
  1. 主交付用 R2007（AC1021）：原生 UTF-8，中文零转义。
     R2000 必须显式 GBK + $DWGCODEPAGE=ANSI_936，且对不认 codepage 的解析器会乱码。
  2. ezdxf 默认 cp1252，中文会被写成 \\U+XXXX。
  3. ACI 颜色 7 是黑/白随背景反转，白底会隐形 —— 颜色策略不能用 7。

用法：
    python py/export_dxf.py <neutral.json> <out.dxf> [R2007|R2000]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import ezdxf
from ezdxf.enums import TextEntityAlignment

TXT_STYLE = "HZ"

# ── 图层颜色：按用途分配，**刻意避开 ACI 7**（黑/白随背景反转，白底会隐形）──
# 前缀沿用 views.ts / renderer.ts 实际产出的图层名（A- 建筑、F- 家具的标准命名）。
LAYER_COLOR_RULES = [
    ("A-WALL", 8),        # 墙体 → 深灰
    ("A-TEXT", 2),        # 墙上文字 → 黄
    ("F-CAB-FRONT", 5),   # 正视 → 蓝
    ("F-CAB-HW", 6),      # 五金 → 品红
    ("F-CAB-HIDDEN", 4),  # 隐藏线 / 衔接线 → 青
    ("F-VIEW", 4),
    ("F-DIM", 1),         # 标注 → 红
    ("F-TEXT", 2),        # 文字 → 黄
    ("F-CAB", 3),         # 家具主体 → 绿
    ("PANEL_", 3),        # 板件 → 绿
    ("EDGE_", 1),         # 封边 → 红
    ("DIM", 1),
    ("TEXT", 2),
]
DEFAULT_COLOR = 9       # 未知图层 → 灰（而不是 7）


def color_for(layer: str) -> int:
    for prefix, c in LAYER_COLOR_RULES:
        if layer.startswith(prefix):
            return c
    return DEFAULT_COLOR


def lineweight_for(lw: float) -> int:
    """Prim 的 lw 是屏幕像素级（1~3）；DXF lineweight 单位是 1/100 mm。"""
    return int(max(0, min(211, round(lw * 13))))


def align_of(a: str):
    return {
        "l": TextEntityAlignment.LEFT,
        "c": TextEntityAlignment.CENTER,
        "r": TextEntityAlignment.RIGHT,
    }.get(a, TextEntityAlignment.LEFT)


def build(data: dict, out_path: Path, dxfversion: str = "R2007") -> dict:
    meta = data["meta"]

    doc = ezdxf.new(dxfversion, setup=True)
    if dxfversion == "R2000":
        # R2000 没有原生 UTF-8，只能显式 GBK；这份只作兼容备用
        doc.encoding = "gbk"
        doc.header["$DWGCODEPAGE"] = "ANSI_936"

    doc.header["$INSUNITS"] = 4      # 4 = 毫米
    doc.header["$MEASUREMENT"] = 1   # 公制
    doc.header["$LUNITS"] = 2
    doc.header["$LTSCALE"] = 1.0

    if TXT_STYLE not in doc.styles:
        doc.styles.add(TXT_STYLE, font="simfang.ttf")   # 仿宋，中文制图标准字体
    doc.styles.get(TXT_STYLE).dxf.bigfont = ""

    # 图层按需创建：图元里出现过才建，不预先写一大堆用不上的层
    layers: dict[str, None] = {}
    for sh in data.get("sheets", []):
        for pr in sh.get("prims", []):
            layers.setdefault(pr["layer"], None)
    for name in layers:
        ltype = "CONTINUOUS"
        if name not in doc.layers:
            doc.layers.add(name, color=color_for(name), linetype=ltype)

    msp = doc.modelspace()

    stats = {"poly": 0, "fill": 0, "text": 0}

    for sh in data.get("sheets", []):
        for pr in sh.get("prims", []):
            layer = pr["layer"]
            if pr["k"] == "poly":
                pts = [(float(p["x"]), float(p["y"])) for p in pr["pts"]]
                if len(pts) < 2:
                    continue
                attribs = {"layer": layer}
                if pr.get("dash"):
                    attribs["linetype"] = "DASHED"
                # 闭合是构造参数，不是 dxf 属性（pl.dxf.closed 会直接抛 DXFAttributeError）
                pl = msp.add_lwpolyline(pts, close=bool(pr.get("closed")), dxfattribs=attribs)
                pl.dxf.lineweight = lineweight_for(float(pr.get("lw", 1)))
                stats["poly"] += 1

            elif pr["k"] == "fill":
                pts = [(float(p["x"]), float(p["y"])) for p in pr["pts"]]
                if len(pts) < 3:
                    continue
                hatch = msp.add_hatch(color=color_for(layer), dxfattribs={"layer": layer})
                hatch.paths.add_polyline_path(pts, is_closed=True)
                try:
                    hatch.set_solid_fill(color=color_for(layer))
                except Exception:
                    pass
                stats["fill"] += 1

            elif pr["k"] == "text":
                t = pr["text"]
                if not t:
                    continue
                e = msp.add_text(
                    t,
                    height=float(pr.get("size", 90)),
                    dxfattribs={"style": TXT_STYLE, "layer": layer},
                )
                e.set_placement(
                    (float(pr["p"]["x"]), float(pr["p"]["y"])),
                    align=align_of(pr.get("align", "l")),
                )
                if pr.get("rot"):
                    e.dxf.rotation = float(pr["rot"])
                stats["text"] += 1

    # 生产数据三件套写进文件的自定义属性：模型版本 + 生成器版本 + 规则集版本。
    # 主方案红线：交付物必须能完整复现，光靠一个文件名做不到 —— 文件会被改名。
    try:
        # 正确的 API 是**方法** `doc.ezdxf_metadata()`，返回 R2000MetaData，
        # 用**下标**写入（`md[...] = ...`），没有 custom_properties 属性。
        # 前两版分别写成了赋值和 `.custom_properties[...]`，都被外面这个
        # except 静默吞掉 —— 三件套就这么丢的。这也是为什么这条必须有断言盯着：
        # 元数据写失败不报错，只有回读才看得见。
        md = doc.ezdxf_metadata()
        tr = meta.get("traceability", {})
        md["FurnitureProject"] = str(meta.get("projectName", ""))
        md["FurnitureGenerator"] = str(meta.get("generatorVersion", ""))
        md["FurnitureModelVersion"] = str(tr.get("modelVersion", ""))
        md["FurnitureRuleSet"] = str(meta.get("ruleSetId", ""))
        md["FurnitureGeneratedAt"] = str(meta.get("generatedAt", ""))
    except Exception:
        # 元数据写不进去不该让导出失败 —— 几何本体才是交付物。
        # 但验收会回读检查，所以"静默失败"活不过下一轮验收。
        pass

    out_path.parent.mkdir(parents=True, exist_ok=True)
    doc.saveas(str(out_path))

    return {
        "out": str(out_path),
        "dxfversion": doc.dxfversion,
        "encoding": doc.encoding,
        "entities": len(msp),
        "layers": len(layers),
        "primStats": stats,
        "warnings": meta.get("warnings", []),
    }


def main() -> int:
    if len(sys.argv) < 3:
        sys.stderr.write("用法: python export_dxf.py <neutral.json> <out.dxf> [R2007|R2000]\n")
        return 2
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2])
    version = sys.argv[3] if len(sys.argv) > 3 else "R2007"
    data = json.loads(src.read_text(encoding="utf-8"))
    info = build(data, dst, version)
    sys.stdout.write(json.dumps(info, ensure_ascii=False))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
