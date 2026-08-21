from __future__ import annotations

import argparse
import base64
import html
import json
import math
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import unquote_to_bytes

import uno


def property_value(name, value):
    item = uno.createUnoStruct("com.sun.star.beans.PropertyValue")
    item.Name = name
    item.Value = value
    return item


def uno_constant(name, fallback):
    try:
        return uno.getConstantByName(name)
    except Exception:
        return fallback


def set_property(target, name, value):
    try:
        setattr(target, name, value)
        return True
    except Exception:
        return False


def color(value, fallback=0x000000):
    cleaned = str(value or "").strip().lstrip("#")
    return int(cleaned, 16) if re.fullmatch(r"[0-9a-fA-F]{6}", cleaned) else fallback


def number(value, fallback=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(fallback)


def padding(value, fallback=0):
    if isinstance(value, list):
        values = [int(number(item, fallback) * 100) for item in value]
        if len(values) == 1:
            return values * 4
        if len(values) == 2:
            return [values[0], values[1], values[0], values[1]]
        if len(values) == 3:
            return [values[0], values[1], values[2], values[1]]
        return (values + [0, 0, 0, 0])[:4]
    converted = int(number(value, fallback) * 100)
    return [converted] * 4


def style_for(spec, block=None):
    document = spec.get("document") if isinstance(spec.get("document"), dict) else {}
    default = document.get("defaultStyle") if isinstance(document.get("defaultStyle"), dict) else {}
    own = block.get("style") if isinstance(block, dict) and isinstance(block.get("style"), dict) else {}
    return {**default, **own}


def block_children(block):
    result = list(block.get("children") or []) if isinstance(block.get("children"), list) else []
    for column in block.get("columns") or []:
        if isinstance(column, dict) and isinstance(column.get("blocks"), list):
            result.extend(column["blocks"])
    return result


def block_text(block):
    if not isinstance(block, dict):
        return str(block or "")
    own = block.get("markdown", block.get("text", block.get("title", "")))
    nested = "\n".join(filter(None, (block_text(item) for item in block_children(block))))
    return "\n".join(filter(None, (str(own or "").strip(), nested))).strip()


def materialize_graphic(block, work_dir):
    raw_svg = str(block.get("svg") or "").strip()
    source = str(block.get("source") or block.get("url") or "").strip()
    if raw_svg:
        target = work_dir / f"{block.get('id', uuid.uuid4().hex)}.svg"
        target.write_text(raw_svg, encoding="utf-8")
        return target.as_uri()
    if source.startswith("data:"):
        header, payload = source.split(",", 1)
        extension = ".svg" if "svg" in header else ".png" if "png" in header else ".jpg"
        target = work_dir / f"{block.get('id', uuid.uuid4().hex)}{extension}"
        target.write_bytes(base64.b64decode(payload) if ";base64" in header else unquote_to_bytes(payload))
        return target.as_uri()
    source_path = Path(source)
    if source_path.is_file():
        return source_path.resolve().as_uri()
    return source


def chart_svg(block):
    data = block.get("data") if isinstance(block.get("data"), dict) else {}
    labels = list(data.get("labels") or [])
    series = list(data.get("series") or [])
    width, height = 900, 460
    background = color((block.get("style") or {}).get("backgroundColor"), 0xFFFFFF)
    palette = data.get("colors") or ["#2563eb", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6"]
    numeric_series = []
    for index, entry in enumerate(series):
        values = entry.get("values") if isinstance(entry, dict) else entry
        if isinstance(values, list):
            numeric_series.append((str(entry.get("name") or f"Series {index + 1}") if isinstance(entry, dict) else f"Series {index + 1}", [number(value) for value in values]))
    maximum = max([value for _, values in numeric_series for value in values] + [1])
    body = [f'<rect width="{width}" height="{height}" fill="#{background:06x}"/>']
    title = html.escape(str(block.get("title") or ""))
    if title:
        body.append(f'<text x="40" y="42" font-size="24" font-family="sans-serif" font-weight="600">{title}</text>')
    plot_x, plot_y, plot_w, plot_h = 70, 75, 790, 310
    chart_type = str(block.get("chartType") or data.get("type") or "bar")
    if chart_type in ("line", "area"):
        count = max([len(values) for _, values in numeric_series] + [1])
        for series_index, (_, values) in enumerate(numeric_series):
            points = []
            for item_index, value in enumerate(values):
                x = plot_x + (plot_w * item_index / max(1, count - 1))
                y = plot_y + plot_h - (plot_h * value / maximum)
                points.append(f"{x:.1f},{y:.1f}")
            body.append(f'<polyline fill="none" stroke="{palette[series_index % len(palette)]}" stroke-width="5" points="{" ".join(points)}"/>')
    else:
        count = max([len(values) for _, values in numeric_series] + [1])
        group = plot_w / max(1, count)
        bar_width = group / max(1, len(numeric_series) + 1)
        for series_index, (_, values) in enumerate(numeric_series):
            for item_index, value in enumerate(values):
                bar_height = plot_h * value / maximum
                x = plot_x + item_index * group + (series_index + 0.5) * bar_width
                y = plot_y + plot_h - bar_height
                body.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{bar_width * .82:.1f}" height="{bar_height:.1f}" fill="{palette[series_index % len(palette)]}"/>')
    for index, label in enumerate(labels):
        x = plot_x + plot_w * (index + .5) / max(1, len(labels))
        body.append(f'<text x="{x:.1f}" y="420" text-anchor="middle" font-size="15" font-family="sans-serif">{html.escape(str(label))}</text>')
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">{"".join(body)}</svg>'


def prepare_graphic(block, work_dir):
    if block.get("type") == "chart" and not block.get("svg") and not block.get("source"):
        block = {**block, "svg": chart_svg(block)}
    return materialize_graphic(block, work_dir)


def style_text(target, style, *, default_size=11, default_color=0x000000):
    font = str(style.get("fontFamily") or "Liberation Sans")
    size = number(style.get("fontSize"), default_size)
    set_property(target, "CharFontName", font)
    set_property(target, "CharFontNameAsian", font)
    set_property(target, "CharHeight", size)
    set_property(target, "CharHeightAsian", size)
    set_property(target, "CharColor", color(style.get("color"), default_color))
    weight = style.get("fontWeight")
    set_property(target, "CharWeight", 150.0 if weight in ("bold", 600, 700, 800, 900) or number(weight) >= 600 else 100.0)
    set_property(target, "CharPosture", uno_constant("com.sun.star.awt.FontSlant.ITALIC", 2) if style.get("fontStyle") == "italic" else uno_constant("com.sun.star.awt.FontSlant.NONE", 0))
    alignments = {"left": 0, "right": 1, "center": 3, "justify": 2}
    set_property(target, "ParaAdjust", alignments.get(style.get("align"), 0))


def configure_writer_page(document, spec):
    settings = spec.get("document") if isinstance(spec.get("document"), dict) else {}
    page_spec = settings.get("page") if isinstance(settings.get("page"), dict) else {}
    try:
        pages = document.StyleFamilies.getByName("PageStyles")
        names = list(pages.getElementNames())
        page = pages.getByName("Default Page Style") if "Default Page Style" in names else pages.getByName(names[0])
        for source, target in (("marginLeft", "LeftMargin"), ("marginRight", "RightMargin"), ("marginTop", "TopMargin"), ("marginBottom", "BottomMargin")):
            if source in page_spec:
                set_property(page, target, int(number(page_spec[source]) * 100))
        if page_spec.get("orientation") == "landscape":
            width, height = page.Width, page.Height
            set_property(page, "IsLandscape", True)
            if width < height:
                page.Width, page.Height = height, width
        if page_spec.get("width") and page_spec.get("height"):
            page.Width = int(number(page_spec["width"]) * 100)
            page.Height = int(number(page_spec["height"]) * 100)
        header = str(page_spec.get("header") or "")
        footer = str(page_spec.get("footer") or "")
        show_number = page_spec.get("showPageNumber") is True
        set_property(page, "HeaderIsOn", bool(header))
        set_property(page, "FooterIsOn", bool(footer or show_number))
        if header:
            page.HeaderText.String = header
        if footer or show_number:
            page.FooterText.String = footer + ("  " if footer and show_number else "")
            if show_number:
                cursor = page.FooterText.createTextCursorByRange(page.FooterText.End)
                page.FooterText.insertTextContent(cursor, document.createInstance("com.sun.star.text.TextField.PageNumber"), False)
    except Exception:
        pass


def writer_paragraph(document, value, style, *, default_size=11):
    text = document.Text
    cursor = text.createTextCursorByRange(text.End)
    style_text(cursor, style, default_size=default_size)
    margins = padding(style.get("margin"), 0)
    set_property(cursor, "ParaTopMargin", margins[0])
    set_property(cursor, "ParaBottomMargin", margins[2])
    set_property(cursor, "ParaLeftMargin", margins[3])
    if style.get("backgroundColor"):
        set_property(cursor, "ParaBackColor", color(style.get("backgroundColor"), 0xFFFFFF))
    text.insertString(cursor, str(value or ""), False)
    text.insertControlCharacter(cursor, uno_constant("com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK", 0), False)


def writer_table(document, rows, style):
    rows = [list(row) for row in rows if isinstance(row, list)]
    if not rows:
        return
    columns = max(len(row) for row in rows)
    table = document.createInstance("com.sun.star.text.TextTable")
    table.initialize(len(rows), columns)
    document.Text.insertTextContent(document.Text.End, table, False)
    names = list(table.getCellNames())
    for row_index, row in enumerate(rows):
        for column_index in range(columns):
            cell = table.getCellByName(names[row_index * columns + column_index])
            cell.String = str(row[column_index] if column_index < len(row) and row[column_index] is not None else "")
            style_text(cell, style, default_size=10)
            if style.get("backgroundColor"):
                set_property(cell, "BackColor", color(style.get("backgroundColor"), 0xFFFFFF))
    document.Text.insertControlCharacter(document.Text.End, uno_constant("com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK", 0), False)


def writer_graphic(document, block, style, work_dir):
    url = prepare_graphic(block, work_dir)
    if not url:
        return
    graphic = document.createInstance("com.sun.star.text.TextGraphicObject")
    set_property(graphic, "GraphicURL", url)
    if style.get("width"):
        set_property(graphic, "Width", int(number(style.get("width")) * 100))
    if style.get("height"):
        set_property(graphic, "Height", int(number(style.get("height")) * 100))
    set_property(graphic, "AnchorType", uno_constant("com.sun.star.text.TextContentAnchorType.AS_CHARACTER", 0))
    document.Text.insertTextContent(document.Text.End, graphic, False)
    document.Text.insertControlCharacter(document.Text.End, uno_constant("com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK", 0), False)


def render_writer_blocks(document, blocks, spec, work_dir):
    for block in blocks:
        if not isinstance(block, dict):
            continue
        kind = str(block.get("type") or "text")
        style = style_for(spec, block)
        if kind in ("image", "svg", "chart"):
            writer_graphic(document, block, style, work_dir)
        elif kind == "table":
            writer_table(document, block.get("rows") or [], style)
        elif kind == "pageBreak":
            document.Text.insertControlCharacter(document.Text.End, uno_constant("com.sun.star.text.ControlCharacter.PAGE_BREAK", 1), False)
        elif kind == "divider":
            writer_paragraph(document, str(block.get("text") or "―"), style, default_size=4)
        elif kind == "spacer":
            writer_paragraph(document, "", style)
        elif kind == "list":
            ordered = block.get("ordered") is True
            for index, item in enumerate(block.get("items") or []):
                value = item.get("text") if isinstance(item, dict) else item
                writer_paragraph(document, f"{index + 1}. {value}" if ordered else f"• {value}", style)
        elif kind in ("card", "metric", "timeline"):
            items = block.get("items") if isinstance(block.get("items"), list) else []
            rows = [[str(item.get("label", item.get("title", ""))), str(item.get("value", item.get("text", "")))] if isinstance(item, dict) else [str(item)] for item in items]
            if not rows:
                rows = [[block.get("title", ""), block.get("text", "")]]
            writer_table(document, rows, style)
        elif kind == "columns":
            columns = block.get("columns") if isinstance(block.get("columns"), list) else []
            writer_table(document, [["\n".join(block_text(child) for child in column.get("blocks", [])) for column in columns]], style)
        elif kind in ("page", "sheet"):
            render_writer_blocks(document, block.get("children") or [], spec, work_dir)
        else:
            heading_level = int(number(block.get("level"), 1))
            default_size = max(12, 26 - heading_level * 3) if kind == "heading" else 10 if kind == "code" else 11
            writer_paragraph(document, block_text(block), style, default_size=default_size)


def build_writer(desktop, spec, work_dir):
    document = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, (property_value("Hidden", True),))
    configure_writer_page(document, spec)
    render_writer_blocks(document, spec.get("blocks") or [], spec, work_dir)
    return document, "writer"


def sheet_name(value, index, used):
    base = re.sub(r"[\\/?*:\[\]]", " ", str(value or f"Sheet {index + 1}")).strip()[:31] or f"Sheet {index + 1}"
    candidate, suffix = base, 2
    while candidate.lower() in used:
        ending = f" {suffix}"
        candidate, suffix = f"{base[:31-len(ending)]}{ending}", suffix + 1
    used.add(candidate.lower())
    return candidate


def calc_table(document, sheet, block, start_row=0, start_column=0):
    rows = [list(row) for row in block.get("rows") or [] if isinstance(row, list)]
    if not rows:
        return start_row
    columns = max(len(row) for row in rows)
    normalized = tuple(tuple(row[column] if column < len(row) and row[column] is not None else "" for column in range(columns)) for row in rows)
    target = sheet.getCellRangeByPosition(start_column, start_row, start_column + columns - 1, start_row + len(rows) - 1)
    target.setDataArray(normalized)
    style = block.get("style") if isinstance(block.get("style"), dict) else {}
    style_text(target, style, default_size=10)
    if style.get("backgroundColor"):
        set_property(target, "CellBackColor", color(style.get("backgroundColor"), 0xFFFFFF))
    for merge in block.get("merges") or []:
        try:
            sheet.getCellRangeByName(str(merge)).merge(True)
        except Exception:
            pass
    for formula in block.get("formulas") or []:
        try:
            sheet.getCellRangeByName(str(formula.get("cell"))).Formula = str(formula.get("formula"))
        except Exception:
            pass
    for column in block.get("columns") or []:
        if isinstance(column, dict) and isinstance(column.get("index"), int) and column.get("width") is not None:
            set_property(sheet.Columns.getByIndex(column["index"]), "Width", int(number(column["width"]) * 430))
    return start_row + len(rows) + 1


def calc_chart(sheet, block, index):
    try:
        source = sheet.getCellRangeByName(str(block.get("range") or "A1:B2"))
        rectangle = uno.createUnoStruct("com.sun.star.awt.Rectangle")
        style = block.get("style") if isinstance(block.get("style"), dict) else {}
        rectangle.X = int(number(style.get("x"), 10) * 100)
        rectangle.Y = int(number(style.get("y"), 10 + index * 85) * 100)
        rectangle.Width = int(number(style.get("width"), 150) * 100)
        rectangle.Height = int(number(style.get("height"), 75) * 100)
        name = str(block.get("id") or f"Chart{index + 1}")
        sheet.Charts.addNewByName(name, rectangle, (source.RangeAddress,), True, True)
        chart = sheet.Charts.getByName(name).EmbeddedObject
        services = {"area": "com.sun.star.chart.AreaDiagram", "bar": "com.sun.star.chart.BarDiagram", "column": "com.sun.star.chart.BarDiagram", "line": "com.sun.star.chart.LineDiagram", "pie": "com.sun.star.chart.PieDiagram"}
        diagram = chart.createInstance(services.get(block.get("chartType"), "com.sun.star.chart.BarDiagram"))
        if block.get("chartType") == "bar":
            set_property(diagram, "Vertical", True)
        chart.setDiagram(diagram)
        if block.get("title"):
            chart.Title.String = str(block["title"])
    except Exception:
        pass


def build_calc(desktop, spec, work_dir):
    document = desktop.loadComponentFromURL("private:factory/scalc", "_blank", 0, (property_value("Hidden", True),))
    blocks = spec.get("blocks") or []
    sheet_blocks = [block for block in blocks if isinstance(block, dict) and block.get("type") == "sheet"]
    if not sheet_blocks:
        sheet_blocks = [{"id": "sheet-1", "type": "sheet", "name": "Sheet 1", "children": blocks}]
    sheets, used = document.Sheets, set()
    initial = list(sheets.getElementNames())
    for index, sheet_block in enumerate(sheet_blocks):
        name = sheet_name(sheet_block.get("name") or sheet_block.get("title"), index, used)
        if index == 0:
            sheet = sheets.getByName(initial[0])
            sheet.Name = name
        else:
            sheets.insertNewByName(name, index)
            sheet = sheets.getByName(name)
        row = 0
        for block in sheet_block.get("children") or []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "table":
                row = calc_table(document, sheet, block, int(number(block.get("startRow"), row)), int(number(block.get("startColumn"), 0)))
            elif block.get("type") == "chart":
                calc_chart(sheet, block, row)
            else:
                row = calc_table(document, sheet, {"rows": [[block_text(block)]], "style": block.get("style")}, row, 0)
        page_spec = (spec.get("document") or {}).get("page") or {}
        try:
            page = document.StyleFamilies.getByName("PageStyles").getByName(sheet.PageStyle)
            set_property(page, "IsLandscape", page_spec.get("orientation") == "landscape")
        except Exception:
            pass
    return document, "calc"


def draw_shape(document, page, service, x, y, width, height):
    shape = document.createInstance(service)
    position = uno.createUnoStruct("com.sun.star.awt.Point")
    position.X, position.Y = int(x), int(y)
    size = uno.createUnoStruct("com.sun.star.awt.Size")
    size.Width, size.Height = max(1, int(width)), max(1, int(height))
    shape.Position, shape.Size = position, size
    page.add(shape)
    return shape


def slide_measure(value, total, fallback):
    if isinstance(value, str) and value.strip().endswith("%"):
        return total * number(value.strip()[:-1]) / 100
    return number(value, fallback) * 100


def slide_box(style, page_width, page_height, default_y):
    x = slide_measure(style.get("x"), page_width, 15)
    y = slide_measure(style.get("y"), page_height, default_y)
    width = slide_measure(style.get("width"), page_width, 220)
    height = slide_measure(style.get("height"), page_height, 24)
    return x, y, min(width, page_width - x), min(height, page_height - y)


def slide_text(document, page, value, style, box, default_size=18):
    shape = draw_shape(document, page, "com.sun.star.drawing.TextShape", *box)
    shape.String = str(value or "")
    style_text(shape, style, default_size=default_size)
    set_property(shape, "TextWordWrap", True)
    set_property(shape, "FillStyle", uno_constant("com.sun.star.drawing.FillStyle.SOLID", 1) if style.get("backgroundColor") else uno_constant("com.sun.star.drawing.FillStyle.NONE", 0))
    if style.get("backgroundColor"):
        set_property(shape, "FillColor", color(style["backgroundColor"], 0xFFFFFF))
    set_property(shape, "LineStyle", uno_constant("com.sun.star.drawing.LineStyle.SOLID", 1) if style.get("borderColor") else uno_constant("com.sun.star.drawing.LineStyle.NONE", 0))
    if style.get("borderColor"):
        set_property(shape, "LineColor", color(style["borderColor"], 0x000000))
    return shape


def slide_graphic(document, page, block, style, box, work_dir):
    url = prepare_graphic(block, work_dir)
    if not url:
        return
    shape = draw_shape(document, page, "com.sun.star.drawing.GraphicObjectShape", *box)
    set_property(shape, "GraphicURL", url)


def slide_table(document, page, block, style, box):
    rows = [list(row) for row in block.get("rows") or [] if isinstance(row, list)]
    if not rows:
        return
    columns = max(len(row) for row in rows)
    x, y, width, height = box
    cell_w, cell_h = width / columns, height / len(rows)
    for row_index, row in enumerate(rows):
        for column_index in range(columns):
            value = row[column_index] if column_index < len(row) else ""
            slide_text(document, page, value, style, (x + column_index * cell_w, y + row_index * cell_h, cell_w, cell_h), default_size=10)


def render_slide_blocks(document, page, blocks, spec, work_dir, page_width, page_height):
    cursor_y = 12
    for block in blocks:
        if not isinstance(block, dict):
            continue
        kind = str(block.get("type") or "text")
        style = style_for(spec, block)
        box = slide_box(style, page_width, page_height, cursor_y)
        if kind in ("image", "svg", "chart"):
            slide_graphic(document, page, block, style, box, work_dir)
        elif kind == "table":
            slide_table(document, page, block, style, box)
        elif kind == "shape":
            shape = draw_shape(document, page, "com.sun.star.drawing.RectangleShape", *box)
            set_property(shape, "FillStyle", uno_constant("com.sun.star.drawing.FillStyle.SOLID", 1))
            set_property(shape, "FillColor", color(style.get("backgroundColor"), 0xFFFFFF))
            set_property(shape, "LineColor", color(style.get("borderColor"), color(style.get("backgroundColor"), 0xFFFFFF)))
            if block.get("text"):
                shape.String = str(block["text"])
                style_text(shape, style)
        elif kind == "columns":
            columns = block.get("columns") or []
            x, y, width, height = box
            gap = number(style.get("gap"), 5) * 100
            total = sum(number(column.get("width"), 1) for column in columns) or len(columns) or 1
            current_x = x
            for column in columns:
                column_width = (width - gap * max(0, len(columns) - 1)) * number(column.get("width"), 1) / total
                render_slide_blocks(document, page, [dict(child, style={**(child.get("style") or {}), "x": current_x / 100, "y": y / 100, "width": column_width / 100}) for child in column.get("blocks") or []], spec, work_dir, page_width, page_height)
                current_x += column_width + gap
        elif kind in ("card", "metric", "timeline"):
            items = block.get("items") if isinstance(block.get("items"), list) else []
            value = "\n".join(f"{item.get('label', item.get('title', ''))}  {item.get('value', item.get('text', ''))}" if isinstance(item, dict) else str(item) for item in items) or block_text(block)
            slide_text(document, page, value, style, box)
        else:
            size = max(14, 30 - int(number(block.get("level"), 1)) * 3) if kind == "heading" else 18
            slide_text(document, page, block_text(block), style, box, default_size=size)
        cursor_y = max(cursor_y, (box[1] + box[3]) / 100 + number(style.get("gap"), 4))


def build_impress(desktop, spec, work_dir):
    document = desktop.loadComponentFromURL("private:factory/simpress", "_blank", 0, (property_value("Hidden", True),))
    settings = spec.get("document") if isinstance(spec.get("document"), dict) else {}
    page_spec = settings.get("page") if isinstance(settings.get("page"), dict) else {}
    width = int(number(page_spec.get("width"), 338.67) * 100)
    height = int(number(page_spec.get("height"), 190.5) * 100)
    if page_spec.get("orientation") == "portrait" and width > height:
        width, height = height, width
    page_blocks = [block for block in spec.get("blocks") or [] if isinstance(block, dict) and block.get("type") == "page"]
    if not page_blocks:
        page_blocks = [{"id": "page-1", "type": "page", "children": spec.get("blocks") or []}]
    pages = document.DrawPages
    while pages.Count > 1:
        pages.remove(pages.getByIndex(pages.Count - 1))
    for index, page_block in enumerate(page_blocks):
        page = pages.getByIndex(0) if index == 0 else pages.insertNewByIndex(index)
        while page.Count:
            page.remove(page.getByIndex(page.Count - 1))
        page.Width, page.Height = width, height
        page_style = style_for(spec, page_block)
        background_color = page_style.get("backgroundColor", page_spec.get("backgroundColor"))
        if background_color:
            background = draw_shape(document, page, "com.sun.star.drawing.RectangleShape", 0, 0, width, height)
            set_property(background, "FillStyle", uno_constant("com.sun.star.drawing.FillStyle.SOLID", 1))
            set_property(background, "FillColor", color(background_color, 0xFFFFFF))
            set_property(background, "LineStyle", uno_constant("com.sun.star.drawing.LineStyle.NONE", 0))
        render_slide_blocks(document, page, page_block.get("children") or [], spec, work_dir, width, height)
    return document, "impress"


FILTERS = {
    ".doc": ("writer", "MS Word 97"), ".docx": ("writer", "Office Open XML Text"), ".odt": ("writer", "writer8"),
    ".xls": ("calc", "MS Excel 97"), ".xlsx": ("calc", "Calc MS Excel 2007 XML"), ".ods": ("calc", "calc8"),
    ".ppt": ("impress", "MS PowerPoint 97"), ".pptx": ("impress", "Impress MS PowerPoint 2007 XML"), ".odp": ("impress", "impress8"),
}


def connect_office(soffice, profile):
    pipe_name = f"webpilot_{uuid.uuid4().hex}"
    accept = f"pipe,name={pipe_name};urp;StarOffice.ComponentContext"
    process = subprocess.Popen([str(soffice), "--headless", "--nologo", "--nodefault", "--nofirststartwizard", "--norestore", "--nolockcheck", f"-env:UserInstallation={profile.as_uri()}", f"--accept={accept}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
    deadline, last_error = time.monotonic() + 20, None
    while time.monotonic() < deadline:
        try:
            context = resolver.resolve(f"uno:{accept}")
            manager = context.ServiceManager
            return process, manager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
        except Exception as error:
            last_error = error
            if process.poll() is not None:
                break
            time.sleep(.2)
    process.terminate()
    raise RuntimeError(f"Unable to connect to LibreOffice UNO: {last_error}")


def save_document(document, kind, output):
    extension = output.suffix.lower()
    if extension == ".pdf":
        filter_name = {"writer": "writer_pdf_Export", "calc": "calc_pdf_Export", "impress": "impress_pdf_Export"}[kind]
        document.storeToURL(output.as_uri(), (property_value("FilterName", filter_name), property_value("Overwrite", True)))
        return
    expected_kind, filter_name = FILTERS[extension]
    if expected_kind != kind:
        raise ValueError(f"The document type {kind} cannot be saved as {extension}")
    document.storeAsURL(output.as_uri(), (property_value("FilterName", filter_name), property_value("Overwrite", True)))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--soffice", required=True)
    args = parser.parse_args()
    input_path, output_path = Path(args.input).resolve(), Path(args.output).resolve()
    profile_path = Path(args.profile).resolve()
    profile_path.mkdir(parents=True, exist_ok=True)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    spec = json.loads(input_path.read_text(encoding="utf-8"))
    extension = output_path.suffix.lower()
    if extension not in FILTERS and extension != ".pdf":
        raise ValueError(f"Unsupported LibreOffice output extension: {extension}")
    requested_type = spec.get("documentType")
    if extension in FILTERS:
        requested_type = {"writer": "word", "calc": "spreadsheet", "impress": "presentation"}[FILTERS[extension][0]]
    if requested_type not in ("word", "spreadsheet", "presentation"):
        raise ValueError("documentType must be word, spreadsheet, or presentation")
    process, desktop = connect_office(Path(args.soffice).resolve(), profile_path)
    document = None
    try:
        if requested_type == "spreadsheet":
            document, kind = build_calc(desktop, spec, input_path.parent)
        elif requested_type == "presentation":
            document, kind = build_impress(desktop, spec, input_path.parent)
        else:
            document, kind = build_writer(desktop, spec, input_path.parent)
        save_document(document, kind, output_path)
        if not output_path.is_file() or output_path.stat().st_size < 64:
            raise RuntimeError("LibreOffice did not create a valid output file")
        print(json.dumps({"bytes": output_path.stat().st_size, "kind": kind, "output": str(output_path)}, ensure_ascii=False))
    finally:
        if document is not None:
            try:
                document.close(True)
            except Exception:
                try:
                    document.dispose()
                except Exception:
                    pass
        try:
            desktop.terminate()
        except Exception:
            pass
        try:
            process.wait(timeout=5)
        except Exception:
            process.terminate()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        raise
