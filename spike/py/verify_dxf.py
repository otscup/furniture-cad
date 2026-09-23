"""
DXF 交付质量验证。

无法在本机装 AutoCAD，所以用四道独立检查替代"人工打开看一眼"：
  1. 严格读取（ezdxf.readfile）—— 文件结构合规性
  2. audit() —— ezdxf 的 DXF 校验器，报错即视为不可交付
  3. 回读断言 —— 单位、图层、文字样式、尺寸实测值是否与模型一致
  4. 独立解析器交叉验证（JS dxf-parser，另一套实现）由 run-verify 调用
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

import ezdxf

ROOT = Path(__file__).resolve().parent.parent
OUTDIR = ROOT / "out"
NEUTRAL = OUTDIR / "neutral.json"

fails: list[str] = []
warns: list[str] = []

def check(cond: bool, ok: str, bad: str) -> None:
    print(("  PASS  " if cond else "  FAIL  ") + (ok if cond else bad))
    if not cond:
        fails.append(bad)


def main() -> None:
    dxf = Path(sys.argv[1]) if len(sys.argv) > 1 else OUTDIR / "Cabinet_001_R2007.dxf"
    raw = dxf.read_bytes()
    print("═" * 74)
    print("DXF 交付验证  ——", dxf.name)
    print("═" * 74)

    data = json.loads(NEUTRAL.read_text(encoding="utf-8"))

    # ── 1. 严格读取 ────────────────────────────────────────────────
    print("\n[1] 严格读取（不带 recover）")
    doc = ezdxf.readfile(dxf)
    msp = doc.modelspace()
    check(True, f"readfile 成功，DXF 版本 {doc.dxfversion}，模型空间实体 {len(msp)} 个", "")

    # ── 2. audit ──────────────────────────────────────────────────
    print("\n[2] audit() 结构校验")
    auditor = doc.audit()
    check(
        not auditor.has_errors,
        f"无错误（errors={len(auditor.errors)}, fixes={len(auditor.fixes)}）",
        f"audit 发现 {len(auditor.errors)} 个错误：" + str(auditor.errors[:5]),
    )
    if auditor.fixes:
        warns.append(f"audit 自动修复 {len(auditor.fixes)} 处（需人工确认）")

    # ── 3. 单位与度量 ──────────────────────────────────────────────
    print("\n[3] 单位（踩坑清单第 1 条）")
    insunits = doc.header["$INSUNITS"]
    check(insunits == 4, f"$INSUNITS = {insunits}（4 = 毫米）", f"$INSUNITS = {insunits}，不是 4，对方打开会差 25.4 倍")
    check(doc.header["$MEASUREMENT"] == 1, "$MEASUREMENT = 1（公制）", "$MEASUREMENT 不是 1")
    check(doc.header["$LUNITS"] == 2, "$LUNITS = 2（十进制）", "$LUNITS 不是 2")

    # ── 4. 中文文字样式与编码（踩坑清单第 2 条）──────────────────────
    print("\n[4] 中文文字与编码")
    hz = doc.styles.get("HZ")
    check("HZ" in doc.styles, "文字样式 HZ 存在", "缺少文字样式 HZ")
    print(f"        font = {hz.dxf.font!r}   doc.encoding = {doc.encoding}   $DWGCODEPAGE = {doc.header.get('$DWGCODEPAGE', '-')}")

    texts = [e.dxf.text for e in msp.query("TEXT")]
    cn = [t for t in texts if any("\u4e00" <= ch <= "\u9fff" for ch in t)]
    check(len(cn) > 0, f"包含 {len(cn)} 条中文文字，示例：{cn[0] if cn else '-'}", "没有中文文字，无法验证编码")
    check(all("\ufffd" not in t for t in texts), "回读无乱码字符（U+FFFD）", "存在乱码字符 U+FFFD")

    # 文件字节层的证据：中文必须是原生编码，不能是 \U+XXXX 转义
    has_escape = b"\\U+" in raw
    check(not has_escape, "文件字节中无 \\U+XXXX 转义（中文为原生编码，CAD 直接可读）",
          "中文被写成 \\U+XXXX 转义序列 —— 这是 ezdxf 默认 cp1252 的行为，部分 CAD 会显示为乱码")
    probe = "主卧衣柜"
    native = probe.encode("gbk") in raw or probe.encode("utf-8") in raw
    check(native, f"中文以原生字节写入（{'GBK' if probe.encode('gbk') in raw else 'UTF-8'}）", "未找到中文原生字节")

    # ── 5. 图层（踩坑清单第 3 条）───────────────────────────────────
    print("\n[5] 图层")
    names = sorted(l.dxf.name for l in doc.layers)
    print("        " + ", ".join(names))
    for need in ("PANEL_18", "EDGE_1MM", "EDGE_04MM", "DIM", "ELEV_STRUCT", "ELEV_FRONT"):
        check(need in names, f"图层 {need} 存在", f"缺少图层 {need}")

    # ── 6. 实体类型分布 ────────────────────────────────────────────
    print("\n[6] 实体类型分布")
    c = Counter(e.dxftype() for e in msp)
    print("        " + ", ".join(f"{k}×{v}" for k, v in c.most_common()))
    check(c.get("LWPOLYLINE", 0) > 0, f"LWPOLYLINE {c.get('LWPOLYLINE', 0)} 个", "没有多段线")
    check(c.get("DIMENSION", 0) > 0, f"DIMENSION {c.get('DIMENSION', 0)} 个（真 CAD 标注，可编辑）", "没有尺寸标注")
    check(c.get("TEXT", 0) > 0, f"TEXT {c.get('TEXT', 0)} 个", "没有文字")

    # ── 7. 回读断言：板件尺寸必须与 Panel Model 完全一致 ─────────────
    print("\n[7] 回读断言 —— 板件图尺寸 vs Panel Model")
    # 收集所有闭合矩形多段线的（宽, 高），用于与板件尺寸集合比对
    rects: Counter = Counter()
    for e in msp.query("LWPOLYLINE"):
        if not e.closed:
            continue
        pts = list(e.get_points("xy"))
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        w = round(max(xs) - min(xs))
        h = round(max(ys) - min(ys))
        if w > 0 and h > 0:
            rects[(h, w)] += 1  # (length, width)

    missing = []
    for p in data["panels"]:
        key = (p["length"], p["width"])
        if rects.get(key, 0) < 1:
            missing.append(f"{p['id']} {p['length']}×{p['width']}")
    check(
        not missing,
        f"{len(data['panels'])} 种板件在图中全部找到且尺寸零误差",
        f"{len(missing)} 种板件尺寸对不上：{missing[:5]}",
    )

    # ── 8. 尺寸标注实测值 ──────────────────────────────────────────
    print("\n[8] 尺寸标注实测值（DIMENSION.get_measurement）")
    meas = []
    for d in msp.query("DIMENSION"):
        try:
            meas.append((round(d.get_measurement()), d.dxf.defpoint2, d.dxf.defpoint3))
        except Exception:  # noqa: BLE001
            warns.append(f"DIMENSION {d.dxf.handle} 无法取测量值")
    if meas:
        vals = sorted({m[0] for m in meas})
        print(f"        标注值集合（{len(vals)} 个）：{vals}")
        need = {2400.0, 2320.0, 80.0}
        check(need.issubset(set(vals)), "立面总高/箱体高/踢脚高 标注正确（2400 / 2320 / 80）", f"缺少预期标注值 {need - set(vals)}")
        check(
            all(v in vals for v in (582, 1164)),
            "分区净宽标注正确（582 / 1164）",
            "分区净宽标注缺失",
        )
    # ── 8b. 标注文字必须等于实测值（防 dimlfac / 缩放陷阱）────────────
    print("\n[8b] 标注文字 vs 实测值（防 dimlfac 放大陷阱）")
    check(len(meas) > 0, f"取到 {len(meas)} 个标注测量值", "没有取到任何标注测量值")
    lfac = doc.dimstyles.get("FURN").dxf.dimlfac
    check(lfac == 1.0, f"dimstyle FURN 的 dimlfac = {lfac}（必须为 1）", f"dimlfac = {lfac}，标注文字会被放大 {lfac} 倍")
    mismatched = []
    for d in msp.query("DIMENSION"):
        try:
            m = round(d.get_measurement())
            blk = doc.blocks.get(d.dxf.geometry) if d.dxf.geometry else None
            shown = None
            if blk:
                for e in blk:
                    if e.dxftype() == "TEXT":
                        shown = e.dxf.text
                    elif e.dxftype() == "MTEXT":
                        shown = e.text
            if shown is not None and str(m) != shown:
                mismatched.append(f"{d.dxf.handle}: 实测 {m} 但图上写 {shown}")
        except Exception as exc:  # noqa: BLE001
            mismatched.append(f"{d.dxf.handle}: 取文字失败 {exc}")
    check(not mismatched, f"全部 {len(meas)} 个标注的图上文字 == 实测尺寸（送厂不会读错数）", f"{len(mismatched)} 个标注文字与实测不符：{mismatched[:4]}")

    # ── 9. 图幅范围（毫米合理性）───────────────────────────────────
    print("\n[9] 图幅范围")
    elev_pts: list[tuple[float, float]] = []
    sheet_pts: list[tuple[float, float]] = []
    for e in msp:
        try:
            t = e.dxftype()
            if t == "LWPOLYLINE":
                pts = [(p[0], p[1]) for p in e.get_points("xy")]
            elif t == "LINE":
                pts = [(e.dxf.start.x, e.dxf.start.y), (e.dxf.end.x, e.dxf.end.y)]
            else:
                continue
        except Exception:  # noqa: BLE001
            continue
        for pt in pts:
            (elev_pts if pt[0] < 4000 else sheet_pts).append(pt)

    if elev_pts:
        xs = [p[0] for p in elev_pts]
        ys = [p[1] for p in elev_pts]
        w, h = max(xs) - min(xs), max(ys) - min(ys)
        print(f"        正立面图区  X {min(xs):.0f}..{max(xs):.0f}  Y {min(ys):.0f}..{max(ys):.0f}   ({w:.0f} × {h:.0f} mm)")
        check(2200 < w < 3400 and 2200 < h < 3400, f"立面图幅 {w:.0f}×{h:.0f}mm 符合 2400×2400 柜体 + 标注空间的预期",
              f"立面图幅 {w:.0f}×{h:.0f}mm 异常")
    else:
        check(False, "", "立面区没有实体")

    if sheet_pts:
        xs = [p[0] for p in sheet_pts]
        ys = [p[1] for p in sheet_pts]
        w, h = max(xs) - min(xs), max(ys) - min(ys)
        print(f"        板件图区    X {min(xs):.0f}..{max(xs):.0f}  Y {min(ys):.0f}..{max(ys):.0f}   ({w:.0f} × {h:.0f} mm)")
        check(w > 1000 and h > 1000, f"板件图区有效（{w:.0f}×{h:.0f}mm）", "板件图区异常")
        if h > 30000:
            warns.append(
                f"板件图 1:1 排布跨度 {h/1000:.1f}m，无法打印在单张图纸上 —— "
                "Phase 5 需加图纸空间布局（A2 图框 + 视口 1:10/1:20）"
            )
        else:
            print("        （1:1 模型空间排布，Phase 5 将加 A2 图纸空间视口）")

    # ── 10. 可追溯信息 ─────────────────────────────────────────────
    print("\n[10] 可追溯三件套（模型版本 / 生成器版本 / 规则集版本）")
    blob = " ".join(texts)
    tb = data["meta"]["traceability"]
    for label, val in (("模型版本", tb["modelId"]), ("生成器版本", tb["generator"]), ("规则集版本", tb["ruleSet"])):
        check(val in blob, f"{label} {val} 已写入图纸", f"图纸中缺少{label} {val}")

    # ── 汇总 ──────────────────────────────────────────────────────
    print("\n" + "═" * 74)
    if fails:
        print(f"结论：✗ 不合格，{len(fails)} 项未通过")
        for f in fails:
            print("   · " + f)
    else:
        print("结论：✔ 全部通过 —— 文件可交付给真实 CAD 打开")
    if warns:
        for w in warns:
            print("   ⚠ " + w)
    print("═" * 74)
    raise SystemExit(1 if fails else 0)


if __name__ == "__main__":
    main()
