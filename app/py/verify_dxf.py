#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
DXF 回读校验：读一份 DXF，把可打印性和序列化语义以 JSON 吐到 stdout。

被 verify/export-acceptance.ts 调用，也可以手工跑：
    python py/verify_dxf.py <file.dxf> [neutral.json]

第二个参数启用逐图元回归：房间 PLAN 与家具纸空间图元都只能经过一个统一的
等比例缩放和平移，图元、文字、尺寸文本及其相对位置不得改变。
"""
from __future__ import annotations

import json
import math
import sys
from collections import Counter
from pathlib import Path

import ezdxf
from ezdxf import bbox
from ezdxf.audit import Auditor


def layout_bounds(layout) -> dict[str, float] | None:
    entities = list(layout)
    if not entities:
        return None
    ext = bbox.extents(entities, fast=False)
    if not ext.has_data:
        return None
    return {
        "minX": float(ext.extmin.x),
        "minY": float(ext.extmin.y),
        "maxX": float(ext.extmax.x),
        "maxY": float(ext.extmax.y),
    }


def layout_report(layout) -> dict:
    entities = list(layout)
    settings = layout.dxf_layout.dxf
    text_entities = [e for e in entities if e.dxftype() in ("TEXT", "MTEXT")]
    text_contents = [e.plain_text() for e in text_entities]
    texts = [e for e in text_entities if e.dxftype() == "TEXT"]
    heights = [float(e.dxf.height) for e in texts]
    page_width = float(settings.get("paper_width", 0))
    page_height = float(settings.get("paper_height", 0))
    left = float(settings.get("left_margin", 0))
    right = float(settings.get("right_margin", 0))
    bottom = float(settings.get("bottom_margin", 0))
    top = float(settings.get("top_margin", 0))
    bounds = layout_bounds(layout)
    fits = bool(bounds is not None and page_width > 0 and page_height > 0
                and bounds["minX"] >= left - 0.01
                and bounds["minY"] >= bottom - 0.01
                and bounds["maxX"] <= page_width - right + 0.01
                and bounds["maxY"] <= page_height - top + 0.01)
    return {
        "name": layout.name,
        "entityCount": len(entities),
        "viewportCount": sum(1 for e in entities if e.dxftype() == "VIEWPORT"),
        "bounds": bounds,
        "paperWidth": page_width,
        "paperHeight": page_height,
        "paperSize": settings.get("paper_size", ""),
        "margins": {"left": left, "right": right, "bottom": bottom, "top": top},
        "plotScaleNumerator": float(settings.get("scale_numerator", 0)),
        "plotScaleDenominator": float(settings.get("scale_denominator", 0)),
        "plotPaperUnits": int(settings.get("plot_paper_units", 0)),
        "plotRotation": int(settings.get("plot_rotation", 0)),
        "plotType": int(settings.get("plot_type", -1)),
        "textHeightMin": min(heights) if heights else None,
        "textHeightMax": max(heights) if heights else None,
        "texts": text_contents,
        "fitsPrintableArea": fits,
    }


def safe_layout_name(name: str, idx: int) -> str:
    safe = "".join(c if (c.isalnum() or c in "_-") else "_" for c in name)
    return safe[:50] or f"SHEET_{idx}"


def nearly_equal(a: float, b: float, tolerance: float = 1e-6) -> bool:
    return math.isfinite(a) and math.isfinite(b) and abs(a - b) <= max(tolerance, abs(b) * 1e-9)


def compare_sheet(sheet: dict, space, scale: float | None = None,
                  offset_x: float = 0.0, offset_y: float = 0.0) -> dict:
    """Compare serialized entities to source prims, allowing one global paper transform."""
    expected = []
    for prim in sheet.get("prims", []) or []:
        kind = prim.get("k")
        if kind == "poly" and len(prim.get("pts", [])) >= 2:
            expected.append((prim, "LWPOLYLINE"))
        elif kind == "fill" and len(prim.get("pts", [])) >= 3:
            expected.append((prim, "LWPOLYLINE"))
        elif kind == "text" and prim.get("text"):
            expected.append((prim, "TEXT"))
        elif kind not in ("poly", "fill", "text"):
            return {"ok": False, "errors": [f"未知源图元类型 {kind!r}"]}

    actual = list(space)
    errors: list[str] = []
    if len(actual) != len(expected):
        errors.append(f"图元数 {len(actual)} != 源图元数 {len(expected)}")
    if any(entity.dxftype() == "VIEWPORT" for entity in actual):
        errors.append("纸空间中仍存在会叠加模型空间内容的 VIEWPORT")

    # Infer the paper transform from the first non-degenerate source/output polyline pair.
    if scale is None:
        for (prim, expected_type), entity in zip(expected, actual):
            if expected_type != "LWPOLYLINE" or entity.dxftype() != "LWPOLYLINE":
                continue
            source_pts = prim.get("pts", [])
            target_pts = list(entity.get_points("xy"))
            if len(source_pts) != len(target_pts) or len(source_pts) < 2:
                continue
            a = source_pts[0]
            for i in range(1, len(source_pts)):
                b = source_pts[i]
                dx, dy = float(b["x"]) - float(a["x"]), float(b["y"]) - float(a["y"])
                if abs(dx) > 1e-9:
                    scale = (float(target_pts[i][0]) - float(target_pts[0][0])) / dx
                    break
                if abs(dy) > 1e-9:
                    scale = (float(target_pts[i][1]) - float(target_pts[0][1])) / dy
                    break
            if scale is not None:
                offset_x = float(target_pts[0][0]) - scale * float(a["x"])
                offset_y = float(target_pts[0][1]) - scale * float(a["y"])
                break
        if scale is None:
            for (prim, expected_type), entity in zip(expected, actual):
                if expected_type == "TEXT" and entity.dxftype() == "TEXT" and float(prim.get("size", 0)) > 0:
                    scale = float(entity.dxf.height) / float(prim["size"])
                    offset_x = float(entity.dxf.insert.x) - scale * float(prim["p"]["x"])
                    offset_y = float(entity.dxf.insert.y) - scale * float(prim["p"]["y"])
                    break
        if scale is None:
            scale = 1.0

    for index, ((prim, expected_type), entity) in enumerate(zip(expected, actual)):
        if entity.dxftype() != expected_type:
            errors.append(f"图元 {index} 类型 {entity.dxftype()} != {expected_type}")
            continue
        if expected_type == "LWPOLYLINE":
            source_pts = prim.get("pts", [])
            target_pts = list(entity.get_points("xy"))
            if len(source_pts) != len(target_pts):
                errors.append(f"折线 {index} 顶点数 {len(target_pts)} != {len(source_pts)}")
                continue
            expected_closed = True if prim.get("k") == "fill" else bool(prim.get("closed"))
            if bool(entity.closed) != expected_closed:
                errors.append(f"折线 {index} 闭合语义改变")
            expected_dashed = bool(prim.get("dash"))
            actual_linetype = str(entity.dxf.get("linetype", "BYLAYER")).upper()
            if expected_dashed and actual_linetype != "DASHED":
                errors.append(f"折线 {index} 虚线语义改变：linetype={actual_linetype}")
            if not expected_dashed and actual_linetype == "DASHED":
                errors.append(f"折线 {index} 实线语义改变：意外使用 DASHED")
            for point_index, (source, target) in enumerate(zip(source_pts, target_pts)):
                x = float(source["x"]) * scale + offset_x
                y = float(source["y"]) * scale + offset_y
                if not nearly_equal(float(target[0]), x) or not nearly_equal(float(target[1]), y):
                    errors.append(f"折线 {index} 顶点 {point_index} 未遵循同一纸面变换")
                    break
        else:
            source_point = prim["p"]
            expected_text = str(prim["text"])
            if entity.plain_text() != expected_text:
                errors.append(f"文字 {index} 内容改变：{entity.plain_text()!r} != {expected_text!r}")
            if (not nearly_equal(float(entity.dxf.insert.x), float(source_point["x"]) * scale + offset_x)
                    or not nearly_equal(float(entity.dxf.insert.y), float(source_point["y"]) * scale + offset_y)):
                errors.append(f"文字 {index} 插入点未遵循同一纸面变换")
            expected_height = float(prim.get("size", 90)) * scale
            if not nearly_equal(float(entity.dxf.height), expected_height):
                errors.append(f"文字 {index} 字高 {entity.dxf.height:g} != 变换后 {expected_height:g}")
            actual_rotation = float(entity.dxf.get("rotation", 0))
            expected_rotation = float(prim.get("rot", 0))
            rotation_delta = (actual_rotation - expected_rotation + 180.0) % 360.0 - 180.0
            if not nearly_equal(rotation_delta, 0.0):
                errors.append(f"文字 {index} 旋转角改变")

    return {
        "ok": not errors,
        "layout": getattr(space, "name", "Model"),
        "scale": scale,
        "offsetX": offset_x,
        "offsetY": offset_y,
        "expectedEntities": len(expected),
        "actualEntities": len(actual),
        "errors": errors[:30],
    }


def compare_neutral(doc, neutral: dict) -> dict:
    sheets = neutral.get("sheets", []) or []
    results = []
    # New DXF documents contain a default paper layout named "Layout1" before
    # export adds cabinet layouts. The verifier runs after serialization, so seed
    # only that default name and then reproduce the exporter's collision handling.
    used_names: set[str] = {"Layout1"} if "Layout1" in doc.layouts else set()
    for index, sheet in enumerate(sheets):
        sheet_name = str(sheet.get("name", f"SHEET_{index}"))
        layout_name = safe_layout_name(str(sheet.get("nameZh") or sheet_name), index)
        base_name = layout_name
        suffix = 1
        while layout_name in used_names:
            suffix += 1
            layout_name = f"{base_name}_{suffix}"
        used_names.add(layout_name)
        try:
            layout = doc.layouts.get(layout_name)
        except Exception:
            results.append({"sheet": sheet_name, "layout": layout_name, "ok": False,
                            "errors": ["找不到源图纸对应的 DXF layout"]})
            continue
        result = compare_sheet(sheet, layout)
        result["sheet"] = sheet_name
        result["layout"] = layout_name
        results.append(result)
    errors = [f"{entry.get('sheet')}: {error}" for entry in results
              for error in entry.get("errors", [])]
    return {"ok": all(entry.get("ok", False) for entry in results),
            "sheets": results, "errors": errors[:50]}


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("用法: python verify_dxf.py <file.dxf> [neutral.json]\n")
        return 2
    p = Path(sys.argv[1])
    doc = ezdxf.readfile(str(p))

    # 检查所有空间：modelspace 应为空；房间 PLAN 与柜体图纸都在独立 paper space layouts。
    all_entities = []
    msp = doc.modelspace()
    all_entities.extend(msp)
    layout_names = []
    paper_layouts = []
    for layout in doc.layouts:
        if layout.name not in ("Model",):
            layout_names.append(layout.name)
            all_entities.extend(layout)
            paper_layouts.append(layout_report(layout))

    counts = Counter(e.dxftype() for e in all_entities)
    texts = [e.plain_text() for e in all_entities if e.dxftype() == "TEXT"]
    escaped = [t for t in texts if "\\U+" in t]

    # 只查承载图元的图层；空的必备图层 '0' 与 'Defpoints' 不参加颜色验收。
    used_layers = {e.dxf.layer for e in all_entities}
    used_layer_colors = {doc.layers.get(layer).dxf.color for layer in used_layers}
    all_layer_colors = {layer.dxf.color for layer in doc.layers}

    custom: dict[str, str] = {}
    try:
        md = doc.ezdxf_metadata()
        for key in ("FurnitureProject", "FurnitureGenerator", "FurnitureModelVersion", "FurnitureRuleSet", "FurnitureGeneratedAt"):
            value = md.get(key)
            if value is not None:
                custom[key] = str(value)
    except Exception:
        pass

    out = {
        "file": str(p),
        "dxfversion": doc.dxfversion,
        "entities": len(all_entities),
        "modelspaceEntities": len(msp),
        "layouts": layout_names,
        "paperLayouts": paper_layouts,
        "counts": dict(counts),
        "layers": len(doc.layers),
        "usedLayers": sorted(used_layers),
        "usedLayerColors": sorted(used_layer_colors),
        "allLayerColors": sorted(all_layer_colors),
        "colorSevenUsed": 7 in used_layer_colors,
        "escapedTexts": escaped,
        "texts": texts,
        "textCount": len(texts),
        "sampleTexts": texts[:6],
        "insUnits": doc.header.get("$INSUNITS"),
        "custom": custom,
        "auditIssues": [str(issue) for issue in Auditor(doc).run()][:20],
    }
    if len(sys.argv) >= 3:
        neutral = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
        out["neutralSemantics"] = compare_neutral(doc, neutral)

    sys.stdout.write(json.dumps(out, ensure_ascii=False))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
