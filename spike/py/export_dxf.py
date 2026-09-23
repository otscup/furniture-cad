"""
中立交换格式 → DXF  (ezdxf)

职责边界：本脚本**只做序列化**，不做任何几何计算。
所有尺寸、位置、封边信息都由 TS 侧算好放在 neutral.json 里。

输出（双版本，中文编码各走一条安全路线）：
  out/Cabinet_001_R2007.dxf      —— AC1021，原生 UTF-8，中文零转义【主交付】
  out/Cabinet_001_R2000_GBK.dxf  —— AC1015 + ANSI_936，给老版本 / 部分国产 CAD
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import ezdxf
from ezdxf.enums import TextEntityAlignment

ROOT = Path(__file__).resolve().parent.parent
NEUTRAL = ROOT / "out" / "neutral.json"
OUTDIR = ROOT / "out"

TXT = 25          # 文字高度 mm
GAP = 700         # 板件之间的间距 mm
ROW_W = 6400      # 板件图每行最大宽度 mm
LABEL_H = 170     # 每块板下方标签区高度 mm

LAYERS = [
    # (name, aci color, linetype, lineweight 1/100mm)
    ("FRAME", 8, "CONTINUOUS", 25),
    ("TITLE", 7, "CONTINUOUS", 25),
    ("PANEL_18", 3, "CONTINUOUS", 25),
    ("PANEL_15", 4, "CONTINUOUS", 18),
    ("PANEL_9", 5, "CONTINUOUS", 18),
    ("PANEL_5", 6, "CONTINUOUS", 13),
    ("EDGE_1MM", 1, "CONTINUOUS", 70),
    ("EDGE_04MM", 2, "CONTINUOUS", 35),
    ("EDGE_NONE", 9, "DASHED", 9),
    ("DIM", 7, "CONTINUOUS", 13),
    ("ELEV_STRUCT", 3, "CONTINUOUS", 35),
    ("ELEV_FRONT", 5, "CONTINUOUS", 25),
    ("ELEV_HW", 4, "CENTER", 18),
    ("NOTE", 2, "CONTINUOUS", 13),
]


def build(dxfversion: str, encoding: str | None, out_name: str) -> None:
    data = json.loads(NEUTRAL.read_text(encoding="utf-8"))
    meta, panels, elevation = data["meta"], data["panels"], data["elevation"]

    doc = ezdxf.new(dxfversion, setup=True)
    # ── 关键 1：中文编码（踩坑清单第 2 条，实测结论见 docs/Phase0-Spike-Report.md）──
    #  ezdxf 默认 cp1252，中文会被写成 \U+XXXX 转义串；R2007+ 走 UTF-8，R2000 需显式 GBK。
    if encoding:
        doc.encoding = encoding
        doc.header["$DWGCODEPAGE"] = "ANSI_936"
    # ── 关键 2：单位与度量（踩坑清单第 1 条）──────────────────────────
    doc.header["$INSUNITS"] = 4      # 4 = 毫米
    doc.header["$MEASUREMENT"] = 1   # 公制
    doc.header["$LUNITS"] = 2        # 十进制
    doc.header["$LTSCALE"] = 1.0
    doc.header["$AUNITS"] = 0

    # ── 中文文字样式（踩坑清单第 2 条）──────────────────────────────
    if "HZ" not in doc.styles:
        doc.styles.add("HZ", font="simfang.ttf")   # 仿宋，中文制图标准字体
    doc.styles.get("HZ").dxf.bigfont = ""

    doc.dimstyles.duplicate_entry("EZDXF", "FURN")
    ds = doc.dimstyles.get("FURN")
    # ⚠️ 坑：ezdxf setup=True 建出的 'EZDXF' 样式默认 dimlfac = 100，
    #    直接复制会让所有标注文字放大 100 倍（2400 显示成 240000）。
    ds.dxf.dimlfac = 1.0
    ds.dxf.dimtxt = TXT
    ds.dxf.dimasz = 18
    ds.dxf.dimexe = 6
    ds.dxf.dimexo = 8
    ds.dxf.dimdec = 0
    ds.dxf.dimtxsty = "HZ"
    ds.dxf.dimclrt = 7
    ds.dxf.dimclrd = 7

    for name, color, ltype, lw in LAYERS:
        if name not in doc.layers:
            doc.layers.add(name, color=color, linetype=ltype, lineweight=lw)

    msp = doc.modelspace()

    def text(x: float, y: float, s: str, h: float = TXT, layer: str = "TITLE") -> None:
        msp.add_text(s, height=h, dxfattribs={"style": "HZ", "layer": layer}).set_placement(
            (x, y), align=TextEntityAlignment.LEFT
        )

    def hdim(x1: float, x2: float, y: float, base_y: float) -> None:
        msp.add_linear_dim(base=(0, base_y), p1=(x1, y), p2=(x2, y), angle=0, dimstyle="FURN").render()

    def vdim(y1: float, y2: float, x: float, base_x: float) -> None:
        msp.add_linear_dim(base=(base_x, 0), p1=(x, y1), p2=(x, y2), angle=90, dimstyle="FURN").render()

    def edge_mark(x1: float, y1: float, x2: float, y2: float, eid: str | None) -> None:
        """把封边画成加粗彩色线，压在板件轮廓上。"""
        layer = "EDGE_1MM" if eid == "E_1MM" else ("EDGE_04MM" if eid == "E_04MM" else "EDGE_NONE")
        lw = 100 if eid == "E_1MM" else (50 if eid == "E_04MM" else 9)
        pl = msp.add_lwpolyline([(x1, y1), (x2, y2)], dxfattribs={"layer": layer})
        pl.dxf.lineweight = lw

    # ══════════════════════════════ Zone B · 正立面图 ══════════════════════════════
    outer = meta["outer"]
    inner = meta["inner"]
    ew, eh, ed = outer["width"], outer["height"], outer["depth"]
    text(0, eh + 320, f"{meta['cabinetName']}  正立面图  1:1", h=60)
    text(0, eh + 240, f"外尺寸 {ew} × {eh} × {ed} mm（宽×高×深）", h=TXT, layer="NOTE")

    # 外框
    msp.add_lwpolyline(
        [(0, 0), (ew, 0), (ew, eh), (0, eh)], close=True, dxfattribs={"layer": "FRAME"}
    )
    for r in elevation["rects"]:
        x, y, w, h = r["x"], r["y"], r["w"], r["h"]
        if h <= 0:  # 挂衣杆等符号元素，画成中心线
            msp.add_line((x, y), (x + w, y), dxfattribs={"layer": r["layer"]})
            continue
        msp.add_lwpolyline(
            [(x, y), (x + w, y), (x + w, y + h), (x, y + h)],
            close=True,
            dxfattribs={"layer": r["layer"]},
        )
    for d in elevation["dims"]:
        if d["kind"] == "vertical":
            vdim(d["y"], d["y"] + d["length"], d["x"], d["x"] - 60)
        else:
            hdim(d["x"], d["x"] + d["length"], d["y"], d["y"] - 60)

    # 侧板 / 立板 / 层板 的文字标注
    for r in elevation["rects"]:
        if r["layer"] == "ELEV_STRUCT" and r["h"] > 150:
            text(r["x"] + 25, r["y"] + r["h"] / 2, r["label"], h=28, layer="NOTE")

    # ══════════════════════════════ Zone A · 板件图 ══════════════════════════════
    ZONE_A_X = ew + 2200
    text(ZONE_A_X, eh + 320, "板 件 图（开料图）  1:1", h=60)
    text(
        ZONE_A_X,
        eh + 240,
        "粗红线=1mm 封边 · 中黄线=0.4mm 封边 · 灰虚线=不封边 · 尺寸单位 mm，1:1 实际大小",
        h=TXT,
        layer="NOTE",
    )

    ordered = sorted(panels, key=lambda p: -(p["length"] * p["width"]))
    x_cursor, y_cursor, row_h = ZONE_A_X, eh, 0.0
    for p in ordered:
        w, h = p["width"], p["length"]
        if x_cursor + w > ZONE_A_X + ROW_W and x_cursor > ZONE_A_X:
            x_cursor = ZONE_A_X
            y_cursor -= row_h + GAP
            row_h = 0.0

        x0, y0 = x_cursor, y_cursor - h
        msp.add_lwpolyline(
            [(x0, y0), (x0 + w, y0), (x0 + w, y0 + h), (x0, y0 + h)],
            close=True,
            dxfattribs={"layer": p["layer"]},
        )
        # 封边标记：top/bottom 是长度 = width 的两端；left/right 是长度 = length 的两侧
        e = p["edge"]
        edge_mark(x0, y0 + h, x0 + w, y0 + h, e["top"])
        edge_mark(x0, y0, x0 + w, y0, e["bottom"])
        edge_mark(x0, y0, x0, y0 + h, e["left"])
        edge_mark(x0 + w, y0, x0 + w, y0 + h, e["right"])

        # 标签
        ly = y0 - 55
        text(x0, ly, f"{p['id']}  {p['nameZh']}", h=30)
        text(x0, ly - 42, f"{p['length']} × {p['width']} × {p['thickness']}   数量 {p['qty']}", h=30, layer="NOTE")
        text(x0, ly - 84, f"{p['material']}  封边：{p['edgeLabel']}", h=26, layer="NOTE")

        # 四个封边文字贴在对应边旁
        if e["left"]:
            text(x0 - 190, y0 + h / 2, "封边", h=24, layer="NOTE")
        if e["top"]:
            text(x0 + w / 2 - 40, y0 + h + 12, "封边", h=24, layer="NOTE")

        # 尺寸：长与宽
        vdim(y0, y0 + h, x0, x0 - 120)
        hdim(x0, x0 + w, y0, y0 - 120)

        x_cursor += w + GAP
        row_h = max(row_h, h + LABEL_H)

    # ══════════════════════════════ 可追溯信息块 ══════════════════════════════
    tb = meta["traceability"]
    tx, ty = ZONE_A_X, y_cursor - row_h - 700
    text(tx, ty, "═══ 制造信息（可追溯）═══", h=45)
    lines = [
        f"柜体：{meta['cabinetId']}  {meta['cabinetName']}",
        f"外尺寸：{ew} × {eh} × {ed} mm（宽×高×深）　内空：{inner['width']} × {inner['height']} mm",
        f"板件种类 {data['stats']['panelKinds']} / 总件数 {data['stats']['totalPieces']} / 板材面积 {data['stats']['boardAreaM2']} m² / 估重 {data['stats']['estWeightKg']} kg",
        f"模型版本：{tb['modelId']} @ schema {tb['schemaVersion']}",
        f"生成器版本：{tb['generator']}",
        f"规则集版本：{tb['ruleSet']}",
        f"生成时间：{meta['generatedAt']}",
    ]
    for i, ln in enumerate(lines):
        text(tx, ty - 90 - i * 60, ln, h=32, layer="NOTE")

    # 五金清单
    hy = ty - 90 - len(lines) * 60 - 120
    text(tx, hy, "═══ 五金清单 ═══", h=45)
    for i, hw in enumerate(data["hardware"]):
        text(tx, hy - 90 - i * 60, f"{hw['nameZh']}  × {hw['qty']}   {hw['spec']}", h=30, layer="NOTE")

    # 问题清单（WARNING/INFO）
    if data["issues"]:
        wy = hy - 90 - len(data["hardware"]) * 60 - 120
        text(tx, wy, "═══ 校验问题（导出前须清零 ERROR）═══", h=45)
        for i, it in enumerate(data["issues"]):
            text(tx, wy - 90 - i * 60, f"[{it['severity']}] {it['code']} — {it['message']}", h=28, layer="NOTE")

    out_path = OUTDIR / out_name
    doc.saveas(out_path)
    print(f"OK  -> {out_path.name}   [{doc.dxfversion} / encoding={doc.encoding}]  entities={len(msp)}  $INSUNITS={doc.header['$INSUNITS']}")


if __name__ == "__main__":
    try:
        build("R2007", None, "Cabinet_001_R2007.dxf")
        build("R2000", "gbk", "Cabinet_001_R2000_GBK.dxf")
    except Exception as exc:  # noqa: BLE001
        print(f"FAILED: {exc}", file=sys.stderr)
        raise
