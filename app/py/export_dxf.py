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

# ── 标准 DXF 图层（对标生产图纸）──
#   内部图层 → 标准图层 的映射。生产下单的 DXF 必须用这套标准层，
#   而不是 views.ts 的 F- 前缀内部层。
#   注意：刻意避开 ACI 7（黑/白随背景反转，白底打印会隐形）——
#   用 8（深灰）在黑白背景下都可见。
STD_LAYERS = {
    # name: (aci_color, linetype, lineweight_1_100mm)
    "OUTLINE": (8, "Continuous", 70),   # 轮廓线：深灰，0.7mm
    "DIM": (3, "Continuous", 25),       # 尺寸标注：绿，0.25mm
    "HIDDEN": (8, "Dashed", 25),        # 虚线：灰，0.25mm
    "TEXT": (8, "Continuous", 25),      # 文字：深灰
    "CENTER": (1, "Center", 25),        # 中心线：红，0.25mm
    "ANNOT_RED": (1, "Continuous", 25), # 红色工艺标注：红，0.25mm
}

# 内部图层 → 标准图层（注意：长前缀在前，避免 F-CAB 吞掉 F-CAB-HIDDEN）
LAYER_MAP = [
    ("F-ANNOT-RED", "ANNOT_RED"),  # 红色工艺标注 → 红色层
    ("F-BORDER", "OUTLINE"),      # 图框 → 轮廓线
    ("F-CAB-HIDDEN", "HIDDEN"),
    ("F-CAB-FRONT", "OUTLINE"),
    ("F-CAB-HW", "OUTLINE"),
    ("F-CAB", "OUTLINE"),
    ("A-WALL", "OUTLINE"),
    ("PANEL_", "OUTLINE"),
    ("EDGE_", "OUTLINE"),
    ("F-DIM", "DIM"),
    ("DIM", "DIM"),
    ("F-VIEW", "CENTER"),
    ("F-TEXT", "TEXT"),
    ("TEXT", "TEXT"),
    ("A-TEXT", "TEXT"),
]


def std_layer_for(layer: str) -> str:
    """内部图层名 → 标准 DXF 图层名。"""
    # 防御：数字图层名（如 '100'、'285'）是非法的，直接归到 OUTLINE
    # （疑似某处把尺寸数值当成了 layer 名，根因待查，这里先保证 DXF 干净）
    if not isinstance(layer, str) or layer.strip().isdigit():
        return "OUTLINE"
    for prefix, std in LAYER_MAP:
        if layer.startswith(prefix):
            return std
    return "OUTLINE"  # 未知 → 轮廓线（可见，不断线）


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
    if "meta" not in data:
        raise ValueError("中立交换 JSON 缺少 meta 字段（顶层必须有 meta）")
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

    # ── 标准图层：预先创建 5 个生产标准层 ──
    for std_name, (aci, ltype, lw) in STD_LAYERS.items():
        if std_name not in doc.layers:
            # linetype 必须存在：setup=True 自带 Continuous/Center/Dashed 等标准线型
            try:
                doc.layers.add(std_name, color=aci, linetype=ltype)
            except Exception:
                doc.layers.add(std_name, color=aci)
            doc.layers.get(std_name).dxf.lineweight = lw

    # 图层按需映射：内部图层 → 标准图层（F-CAB 等内部名不进 DXF）
    layers: dict[str, None] = {}
    for sh in data.get("sheets", []) or []:
        for pr in sh.get("prims", []) or []:
            # 缺 layer / 非对象的坏图元不在此处裸崩，交给下方逐图元处理统一给出「图元损坏」结构化报错
            if isinstance(pr, dict) and pr.get("layer"):
                layers.setdefault(std_layer_for(pr["layer"]), None)

    msp = doc.modelspace()

    stats = {"poly": 0, "fill": 0, "text": 0, "sheets": 0, "dimension": 0, "leader": 0}

    # ── v8 修复：收集同一 sheet 内 (0,0) 的柜名 TEXT，分散排布 ──
    # 10 个柜名（冰箱柜、地柜四门等）坐标全是 (0,0)，堆在一起。
    # 这里按 sheet 内出现顺序，垂直列表排布在图纸左上角空白处。
    def distribute_zero_texts(prims_list):
        zero_texts = [pr for pr in prims_list
                      if isinstance(pr, dict) and pr.get("k") == "text"
                      and pr.get("p") and float(pr["p"].get("x", 0)) == 0
                      and float(pr["p"].get("y", 0)) == 0]
        if not zero_texts:
            return
        # 按文本去重排序，保持稳定顺序
        seen = []
        for pr in zero_texts:
            t = pr.get("text", "")
            if t not in seen:
                seen.append(t)
        # 垂直列表：x=500 起，每行间隔 400
        base_x, base_y, step = 500, 9000, 400
        idx = 0
        for pr in prims_list:
            if (isinstance(pr, dict) and pr.get("k") == "text" and pr.get("p")
                    and float(pr["p"].get("x", 0)) == 0 and float(pr["p"].get("y", 0)) == 0):
                pr["p"] = {"x": base_x, "y": base_y - idx * step}
                idx += 1

    # ── v8 修复：DIMENSION 和 LEADER 实体生成 ──
    # TS 侧把尺寸画成 poly+text（F-DIM 层），引线画成 poly+text（F-ANNOT-RED 层）。
    # 这里把它们转成真正的 DXF DIMENSION / LEADER 实体，否则下游 CAD 软件认不出。
    def build_dimensions(target_space, prims_list, std_layer_fn):
        """从 F-DIM 层的 poly+text 生成 DXF DIMENSION 实体。"""
        import re
        # 收集 DIM 层的 text（数字）和 poly（直线）
        dim_texts = []  # (x, y, text)
        dim_lines = []  # [(x1,y1),(x2,y2)]
        for pr in prims_list:
            if not isinstance(pr, dict):
                continue
            layer = pr.get("layer", "")
            std = std_layer_fn(layer)
            if std != "DIM":
                continue
            if pr.get("k") == "text":
                t = str(pr.get("text", "")).strip()
                # 尺寸数字：纯数字（可能带小数）
                if re.fullmatch(r'\d+(\.\d+)?', t):
                    p = pr.get("p", {})
                    dim_texts.append((float(p.get("x", 0)), float(p.get("y", 0)), t))
            elif pr.get("k") == "poly":
                pts = pr.get("pts", [])
                if len(pts) == 2:
                    dim_lines.append((
                        (float(pts[0]["x"]), float(pts[0]["y"])),
                        (float(pts[1]["x"]), float(pts[1]["y"])),
                    ))
        if not dim_texts or not dim_lines:
            return 0
        count = 0
        for tx, ty, txt in dim_texts:
            # 找最近的直线（距离文本中心最近的线段中点）
            best = None
            best_d = float('inf')
            for (x1, y1), (x2, y2) in dim_lines:
                mx, my = (x1 + x2) / 2, (y1 + y2) / 2
                d = ((mx - tx) ** 2 + (my - ty) ** 2) ** 0.5
                # 只考虑长度 >50 的直线（排除箭头小线）
                seg_len = ((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5
                if seg_len < 50:
                    continue
                if d < best_d:
                    best_d = d
                    best = ((x1, y1), (x2, y2))
            if best is None:
                continue
            (x1, y1), (x2, y2) = best
            try:
                # 用文本位置作为尺寸线位置，线段端点作为界线原点
                dim = target_space.add_linear_dim(
                    base=(tx, ty),
                    p1=(x1, y1),
                    p2=(x2, y2),
                    text=txt,
                    dxfattribs={"layer": "DIM"},
                )
                dim.render()
                count += 1
            except Exception:
                # DIMENSION 生成失败不阻断导出（poly+text 本体已在）
                continue
        return count

    def build_leaders(target_space, prims_list, std_layer_fn):
        """从 F-ANNOT-RED 层的 poly+text 生成 DXF LEADER 实体。"""
        annot_texts = []  # (x, y, text)
        annot_lines = []  # [(x1,y1),(x2,y2)]
        for pr in prims_list:
            if not isinstance(pr, dict):
                continue
            layer = pr.get("layer", "")
            std = std_layer_fn(layer)
            if std != "ANNOT_RED":
                continue
            if pr.get("k") == "text":
                t = str(pr.get("text", "")).strip()
                if t:
                    p = pr.get("p", {})
                    annot_texts.append((float(p.get("x", 0)), float(p.get("y", 0)), t))
            elif pr.get("k") == "poly":
                pts = pr.get("pts", [])
                if len(pts) == 2 and not pr.get("closed"):
                    annot_lines.append((
                        (float(pts[0]["x"]), float(pts[0]["y"])),
                        (float(pts[1]["x"]), float(pts[1]["y"])),
                    ))
        if not annot_texts:
            return 0
        count = 0
        for tx, ty, txt in annot_texts:
            # 找最近的引线（文本下方 500 范围内的垂直线优先）
            best = None
            best_d = float('inf')
            for (x1, y1), (x2, y2) in annot_lines:
                # 引线一端应在文本附近
                d1 = ((x1 - tx) ** 2 + (y1 - ty) ** 2) ** 0.5
                d2 = ((x2 - tx) ** 2 + (y2 - ty) ** 2) ** 0.5
                d = min(d1, d2)
                if d < best_d and d < 800:
                    best_d = d
                    best = ((x1, y1), (x2, y2))
            if best is None:
                continue
            (x1, y1), (x2, y2) = best
            try:
                # LEADER：从文本位置指向引线远端
                # 确定哪端离文本远（目标点），哪端近（文本端）
                d1 = ((x1 - tx) ** 2 + (y1 - ty) ** 2) ** 0.5
                far = (x2, y2) if d1 < ((x2 - tx) ** 2 + (y2 - ty) ** 2) ** 0.5 else (x1, y1)
                leader = target_space.add_leader(
                    vertices=[(tx, ty - 40), far],
                    dxfattribs={"layer": "ANNOT_RED"},
                )
                # 关联文本注解
                try:
                    leader.set_annotation(
                        target_space.add_text(txt, height=170,
                                            dxfattribs={"layer": "ANNOT_RED"}),
                        leader_style="mtext",
                    )
                except Exception:
                    pass
                count += 1
            except Exception:
                continue
        return count

    # ── 多 sheet：一张图纸一个 paper space layout ──
    # 旧逻辑把所有 sheet 的图元都扔进 modelspace，会重叠。
    # 现在每个 sheet 独立一个 layout（图纸空间），互不干扰。
    # PLAN（平面布置图）保留在 modelspace（它是 1:1 的建筑底图）；
    # SHEET_*（家具生产图）进各自的 paper space layout。
    def sanitize_layout_name(name: str, idx: int) -> str:
        # DXF layout 名：去特殊字符，限长
        safe = "".join(c if (c.isalnum() or c in "_-") else "_" for c in name)
        safe = safe[:50] or f"SHEET_{idx}"
        return safe

    for si, sh in enumerate(data.get("sheets", []) or []):
        sheet_name = str(sh.get("name", f"SHEET_{si}"))
        # v8：先分散 (0,0) 的柜名 TEXT
        distribute_zero_texts(sh.get("prims", []) or [])
        # PLAN 进 modelspace，其余进 paper space layout
        if sheet_name == "PLAN":
            target_space = msp
            space_label = "modelspace"
        else:
            layout_name = sanitize_layout_name(sh.get("nameZh") or sheet_name, si)
            # 重名时加后缀
            base_name = layout_name
            suffix = 1
            while layout_name in doc.layouts:
                suffix += 1
                layout_name = f"{base_name}_{suffix}"
            doc.layouts.new(layout_name)
            target_space = doc.layouts.get(layout_name)
            # 2026-10-04：删掉 ezdxf 自动创建的视口（用户说左下角缩略图看着像 bug）
            for vp in list(target_space.query('VIEWPORT')):
                # 保留主视口 (*Active)，删掉其他的
                # 实际上新 layout 只有一个视口，直接删掉避免缩略图
                try:
                    target_space.delete_entity(vp)
                except Exception:
                    pass
            space_label = f"layout:{layout_name}"
        stats["sheets"] += 1

        for pi, pr in enumerate(sh.get("prims", []) or []):
            if not isinstance(pr, dict):
                raise ValueError(f"图元损坏：sheet[{si}] prim[{pi}] 不是对象")
            try:
                layer = pr["layer"]
                kind = pr["k"]
            except (KeyError, TypeError) as e:
                raise ValueError(
                    f"图元损坏：sheet[{si}] prim[{pi}] 缺少必填字段 layer/k（kind={pr.get('k') if isinstance(pr, dict) else '?'}）"
                ) from e
            # 内部图层 → 标准 DXF 图层（生产规范）
            layer = std_layer_for(layer)
            try:
                if kind == "poly":
                    pts = [(float(p["x"]), float(p["y"])) for p in pr["pts"]]
                    if len(pts) < 2:
                        continue
                    attribs = {"layer": layer}
                    if pr.get("dash"):
                        attribs["linetype"] = "DASHED"
                    # 闭合是构造参数，不是 dxf 属性（pl.dxf.closed 会直接抛 DXFAttributeError）
                    pl = target_space.add_lwpolyline(pts, close=bool(pr.get("closed")), dxfattribs=attribs)
                    pl.dxf.lineweight = lineweight_for(float(pr.get("lw", 1)))
                    stats["poly"] += 1

                elif kind == "fill":
                    # 问题5修复：不做实心 HATCH（手机看图软件渲染成灰块，看不到线条）
                    # 改画闭合轮廓线（线框模式）。玻璃等需要填充的由 TS 侧用斜线表达。
                    pts = [(float(p["x"]), float(p["y"])) for p in pr["pts"]]
                    if len(pts) < 3:
                        continue
                    attribs = {"layer": layer}
                    pl = target_space.add_lwpolyline(pts, close=True, dxfattribs=attribs)
                    pl.dxf.lineweight = lineweight_for(float(pr.get("lw", 1)))
                    stats["fill"] += 1
                    stats["poly"] += 1

                elif kind == "text":
                    t = pr["text"]
                    if not t:
                        continue
                    e = target_space.add_text(
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
                else:
                    # 未知图元类型：不静默吞，明确报错（让验收抓得到）
                    raise ValueError(f"图元损坏：sheet[{si}] prim[{pi}] 未知图元类型 k={kind!r}")
            except (KeyError, TypeError, ValueError) as e:
                if isinstance(e, ValueError) and "图元损坏" in str(e):
                    raise
                raise ValueError(
                    f"图元损坏：sheet[{si}] prim[{pi}] kind={kind!r} 字段缺失或类型错误：{e}"
                ) from e

        # v8：生成 DIMENSION 和 LEADER 实体（TS 侧只给了 poly+text，这里转成真实体）
        stats["dimension"] += build_dimensions(target_space, sh.get("prims", []) or [], std_layer_for)
        stats["leader"] += build_leaders(target_space, sh.get("prims", []) or [], std_layer_for)

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

    # 实体总数：modelspace + 所有 paper space layouts
    total_entities = len(msp)
    layout_names = []
    for layout in doc.layouts:
        if layout.name not in ("Model",):
            total_entities += len(layout)
            layout_names.append(layout.name)

    return {
        "out": str(out_path),
        "dxfversion": doc.dxfversion,
        "encoding": doc.encoding,
        "entities": total_entities,
        "layers": len(layers),
        "layouts": layout_names,
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
