#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
DXF 回读校验：读一份 DXF，把"能不能用"的关键事实以 JSON 吐到 stdout。

被 verify/export-acceptance.ts 调用，也可以手工跑：
    python py/verify_dxf.py <file.dxf>

检查的是**交付质量**，不是"文件存在"：
  · 中文有没有被写成 \\U+XXXX（ezdxf 编码坑，实测过）
  · 图层里有没有 ACI 7（黑/白随背景反转，白底隐形）
  · $INSUNITS 是不是毫米
  · 三件套（模型版本/生成器/规则集）有没有写进自定义属性
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

import ezdxf


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("用法: python verify_dxf.py <file.dxf>\n")
        return 2
    p = Path(sys.argv[1])
    doc = ezdxf.readfile(str(p))
    msp = doc.modelspace()

    counts = Counter(e.dxftype() for e in msp)
    texts = [e.plain_text() for e in msp if e.dxftype() == "TEXT"]
    escaped = [t for t in texts if "\\U+" in t]

    # 只查**承载图元**的图层。DXF 必备的 '0' 层与打印不输出的 'Defpoints'
    # 默认就是 7，但它们上面什么都没有 —— 把它们算进去，断言就永远红不了也永远绿不了。
    used_layers = {e.dxf.layer for e in msp}
    used_layer_colors = {doc.layers.get(l).dxf.color for l in used_layers}
    all_layer_colors = {layer.dxf.color for layer in doc.layers}

    # 元数据：ezdxf_metadata() 返回 R2000MetaData，用 get() 读（没有 custom_properties 属性）
    custom: dict[str, str] = {}
    try:
        md = doc.ezdxf_metadata()
        for k in ("FurnitureProject", "FurnitureGenerator", "FurnitureModelVersion", "FurnitureRuleSet", "FurnitureGeneratedAt"):
            v = md.get(k)
            if v is not None:
                custom[k] = str(v)
    except Exception:
        pass

    out = {
        "file": str(p),
        "dxfversion": doc.dxfversion,
        "entities": len(msp),
        "counts": dict(counts),
        "layers": len(doc.layers),
        "usedLayers": sorted(used_layers),
        "usedLayerColors": sorted(used_layer_colors),
        "allLayerColors": sorted(all_layer_colors),
        "colorSevenUsed": 7 in used_layer_colors,
        "escapedTexts": escaped,
        "textCount": len(texts),
        "sampleTexts": texts[:6],
        "insUnits": doc.header.get("$INSUNITS"),
        "custom": custom,
        "auditIssues": len(ezdxf.audit(doc, renumber=False)) if False else None,
    }
    sys.stdout.write(json.dumps(out, ensure_ascii=False))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
