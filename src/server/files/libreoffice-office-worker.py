from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path

import uno


THEMES = {
    "professional": {
        "primary": 0x1F4E78,
        "accent": 0x2F75B5,
        "body": 0x263238,
        "background": 0xF5F8FC,
        "soft": 0xEAF2F8,
        "font": "Microsoft YaHei",
    },
    "minimal": {
        "primary": 0x202124,
        "accent": 0x5F6368,
        "body": 0x303134,
        "background": 0xFFFFFF,
        "soft": 0xF1F3F4,
        "font": "Microsoft YaHei",
    },
    "executive": {
        "primary": 0x183B56,
        "accent": 0xD4A72C,
        "body": 0x243746,
        "background": 0xF7F5F0,
        "soft": 0xE8EEF2,
        "font": "Microsoft YaHei",
    },
    "warm": {
        "primary": 0x7A3E2D,
        "accent": 0xD97745,
        "body": 0x3F302B,
        "background": 0xFFF9F3,
        "soft": 0xFBEADD,
        "font": "Microsoft YaHei",
    },
}


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


def parse_color(value, fallback):
    cleaned = str(value or "").strip().lstrip("#")
    if re.fullmatch(r"[0-9a-fA-F]{6}", cleaned):
        return int(cleaned, 16)
    return fallback


def clean_inline(value):
    text = str(value or "")
    text = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"(`{1,3}|\*\*|__|~~)", "", text)
    return text.strip()


def resolve_theme(spec):
    source = spec.get("theme") if isinstance(spec.get("theme"), dict) else {}
    preset = source.get("preset") if source.get("preset") in THEMES else "professional"
    theme = dict(THEMES[preset])
    theme["primary"] = parse_color(source.get("primaryColor"), theme["primary"])
    theme["accent"] = parse_color(source.get("accentColor"), theme["accent"])
    theme["body"] = parse_color(source.get("bodyColor"), theme["body"])
    theme["background"] = parse_color(source.get("backgroundColor"), theme["background"])
    font = str(source.get("fontFamily") or "").strip()
    if font:
        theme["font"] = font[:120]
    return theme


def markdown_blocks(content):
    lines = str(content or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    result = []
    paragraph = []
    code = []
    in_code = False

    def flush_paragraph():
        if paragraph:
            result.append({"kind": "paragraph", "text": " ".join(paragraph).strip()})
            paragraph.clear()

    def flush_code():
        if code:
            result.append({"kind": "code", "text": "\n".join(code).rstrip()})
            code.clear()

    index = 0
    while index < len(lines):
        raw = lines[index]
        stripped = raw.strip()
        if stripped.startswith("```"):
            flush_paragraph()
            if in_code:
                flush_code()
            in_code = not in_code
            index += 1
            continue
        if in_code:
            code.append(raw)
            index += 1
            continue
        if not stripped:
            flush_paragraph()
            index += 1
            continue

        if "|" in stripped and index + 1 < len(lines) and re.match(r"^\s*\|?\s*:?-+", lines[index + 1]):
            flush_paragraph()
            table_lines = [raw, lines[index + 1]]
            index += 2
            while index < len(lines) and "|" in lines[index] and lines[index].strip():
                table_lines.append(lines[index])
                index += 1

            def cells(line):
                return [part.strip() for part in line.strip().strip("|").split("|")]

            rows = [cells(table_lines[0])] + [cells(line) for line in table_lines[2:]]
            result.append({"kind": "table", "rows": rows})
            continue

        heading = re.match(r"^(#{1,6})\s+(.+)$", stripped)
        if heading:
            flush_paragraph()
            result.append({"kind": "heading", "level": len(heading.group(1)), "text": clean_inline(heading.group(2))})
            index += 1
            continue
        bullet = re.match(r"^[-*+]\s+(.+)$", stripped)
        if bullet:
            flush_paragraph()
            result.append({"kind": "bullet", "text": clean_inline(bullet.group(1))})
            index += 1
            continue
        numbered = re.match(r"^(\d+)[.)]\s+(.+)$", stripped)
        if numbered:
            flush_paragraph()
            result.append({"kind": "numbered", "number": numbered.group(1), "text": clean_inline(numbered.group(2))})
            index += 1
            continue
        paragraph.append(clean_inline(stripped))
        index += 1

    flush_paragraph()
    flush_code()
    return result


def style_text_cursor(cursor, theme, *, size=10.5, color=None, bold=False, background=None, align=0, before=0, after=250, left=0):
    set_property(cursor, "CharFontName", theme["font"])
    set_property(cursor, "CharFontNameAsian", theme["font"])
    set_property(cursor, "CharHeight", float(size))
    set_property(cursor, "CharHeightAsian", float(size))
    set_property(cursor, "CharColor", theme["body"] if color is None else color)
    set_property(cursor, "CharWeight", 150.0 if bold else 100.0)
    set_property(cursor, "CharWeightAsian", 150.0 if bold else 100.0)
    set_property(cursor, "ParaAdjust", align)
    set_property(cursor, "ParaTopMargin", before)
    set_property(cursor, "ParaBottomMargin", after)
    set_property(cursor, "ParaLeftMargin", left)
    set_property(cursor, "ParaBackColor", -1 if background is None else background)


def append_writer_paragraph(document, text_value, theme, **style):
    text = document.Text
    cursor = text.createTextCursorByRange(text.End)
    style_text_cursor(cursor, theme, **style)
    text.insertString(cursor, str(text_value), False)
    text.insertControlCharacter(cursor, uno_constant("com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK", 0), False)


def append_writer_table(document, rows, theme):
    normalized = [list(row) for row in rows if isinstance(row, list)]
    if not normalized:
        return
    column_count = min(24, max(len(row) for row in normalized))
    row_count = min(500, len(normalized))
    table = document.createInstance("com.sun.star.text.TextTable")
    table.initialize(row_count, column_count)
    document.Text.insertTextContent(document.Text.End, table, False)
    names = list(table.getCellNames())
    for row_index in range(row_count):
        for column_index in range(column_count):
            name = names[row_index * column_count + column_index]
            cell = table.getCellByName(name)
            cell.String = str(normalized[row_index][column_index] if column_index < len(normalized[row_index]) else "")
            set_property(cell, "CharFontName", theme["font"])
            set_property(cell, "CharFontNameAsian", theme["font"])
            set_property(cell, "CharHeight", 9.5)
            set_property(cell, "BackColor", theme["primary"] if row_index == 0 else (theme["soft"] if row_index % 2 == 0 else 0xFFFFFF))
            set_property(cell, "CharColor", 0xFFFFFF if row_index == 0 else theme["body"])
            set_property(cell, "CharWeight", 150.0 if row_index == 0 else 100.0)
    set_property(table, "BackTransparent", False)
    document.Text.insertControlCharacter(document.Text.End, uno_constant("com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK", 0), False)


def configure_writer_page(document, title, theme):
    try:
        families = document.StyleFamilies
        pages = families.getByName("PageStyles")
        names = list(pages.getElementNames())
        page = pages.getByName("Default Page Style") if "Default Page Style" in names else pages.getByName(names[0])
        set_property(page, "LeftMargin", 2200)
        set_property(page, "RightMargin", 2200)
        set_property(page, "TopMargin", 1800)
        set_property(page, "BottomMargin", 1800)
        set_property(page, "HeaderIsOn", True)
        set_property(page, "FooterIsOn", True)
        header = page.HeaderText
        header.String = "WebPilot"
        header_cursor = header.createTextCursor()
        style_text_cursor(header_cursor, theme, size=8.5, color=theme["accent"], after=0)
        footer = page.FooterText
        footer.String = "WebPilot  ·  "
        footer_cursor = footer.createTextCursorByRange(footer.End)
        field = document.createInstance("com.sun.star.text.TextField.PageNumber")
        set_property(field, "NumberingType", uno_constant("com.sun.star.style.NumberingType.ARABIC", 4))
        footer.insertTextContent(footer_cursor, field, False)
        footer_cursor.gotoStart(True)
        style_text_cursor(footer_cursor, theme, size=8, color=0x7A8491, align=3, after=0)
    except Exception:
        pass


def build_writer(desktop, spec, theme):
    document = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, (property_value("Hidden", True),))
    title = str(spec.get("title") or Path(spec.get("fileName") or "Document").stem)
    subtitle = str(spec.get("subtitle") or "").strip()
    configure_writer_page(document, title, theme)
    append_writer_paragraph(document, title, theme, size=25, color=theme["primary"], bold=True, after=180)
    if subtitle:
        append_writer_paragraph(document, subtitle, theme, size=12, color=theme["accent"], after=500)
    append_writer_paragraph(document, "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━", theme, size=3, color=theme["accent"], after=420)

    blocks = markdown_blocks(spec.get("content"))
    if blocks and blocks[0].get("kind") == "heading" and blocks[0].get("text", "").strip() == title.strip():
        blocks = blocks[1:]
    for block in blocks:
        kind = block.get("kind")
        if kind == "heading":
            level = int(block.get("level") or 1)
            size = 18 if level == 1 else 14 if level == 2 else 11.5
            append_writer_paragraph(
                document,
                block.get("text", ""),
                theme,
                size=size,
                color=theme["primary"] if level <= 2 else theme["accent"],
                bold=True,
                before=420 if level <= 2 else 260,
                after=180,
            )
        elif kind == "bullet":
            append_writer_paragraph(document, f"•  {block.get('text', '')}", theme, left=500, after=120)
        elif kind == "numbered":
            append_writer_paragraph(document, f"{block.get('number')}.  {block.get('text', '')}", theme, left=500, after=120)
        elif kind == "code":
            append_writer_paragraph(document, block.get("text", ""), theme, size=9, color=0x32404D, background=theme["soft"], left=350, before=120, after=250)
        elif kind == "table":
            append_writer_table(document, block.get("rows") or [], theme)
        else:
            append_writer_paragraph(document, block.get("text", ""), theme, after=240)
    return document, "writer"


def normalized_sheet_name(value, index, used):
    base = re.sub(r"[\\/?*:\[\]]", " ", str(value or f"Sheet {index + 1}")).strip()[:31] or f"Sheet {index + 1}"
    name = base
    suffix = 2
    while name.lower() in used:
        ending = f" {suffix}"
        name = f"{base[:31 - len(ending)]}{ending}"
        suffix += 1
    used.add(name.lower())
    return name


def style_calc_range(cell_range, theme, *, background=None, color=None, bold=None, align=None, number_format=None, document=None):
    set_property(cell_range, "CharFontName", theme["font"])
    set_property(cell_range, "CharFontNameAsian", theme["font"])
    set_property(cell_range, "CharHeight", 10.0)
    set_property(cell_range, "CharColor", theme["body"] if color is None else color)
    if background is not None:
        set_property(cell_range, "CellBackColor", background)
    if bold is not None:
        set_property(cell_range, "CharWeight", 150.0 if bold else 100.0)
    if align:
        alignments = {"left": 1, "center": 2, "right": 3}
        set_property(cell_range, "HoriJustify", alignments.get(align, 0))
    set_property(cell_range, "VertJustify", 2)
    set_property(cell_range, "IsTextWrapped", True)
    if number_format and document is not None:
        try:
            formats = document.NumberFormats
            locale = uno.createUnoStruct("com.sun.star.lang.Locale")
            key = formats.queryKey(str(number_format), locale, True)
            if key == -1:
                key = formats.addNew(str(number_format), locale)
            set_property(cell_range, "NumberFormat", key)
        except Exception:
            pass


def add_calc_chart(document, sheet, chart_spec, index):
    try:
        source = sheet.getCellRangeByName(str(chart_spec.get("range") or "A1:B2"))
        rectangle = uno.createUnoStruct("com.sun.star.awt.Rectangle")
        rectangle.X = 1000
        rectangle.Y = 1000 + index * 8500
        rectangle.Width = 15000
        rectangle.Height = 7500
        name = f"Chart{index + 1}"
        sheet.Charts.addNewByName(name, rectangle, (source.RangeAddress,), True, True)
        chart = sheet.Charts.getByName(name).EmbeddedObject
        services = {
            "area": "com.sun.star.chart.AreaDiagram",
            "bar": "com.sun.star.chart.BarDiagram",
            "column": "com.sun.star.chart.BarDiagram",
            "line": "com.sun.star.chart.LineDiagram",
            "pie": "com.sun.star.chart.PieDiagram",
        }
        diagram = chart.createInstance(services.get(chart_spec.get("type"), "com.sun.star.chart.BarDiagram"))
        if chart_spec.get("type") == "bar":
            set_property(diagram, "Vertical", True)
        chart.setDiagram(diagram)
        title = str(chart_spec.get("title") or "").strip()
        if title:
            chart.Title.String = title
    except Exception:
        pass


def configure_calc_page(document, sheet, landscape):
    try:
        pages = document.StyleFamilies.getByName("PageStyles")
        page = pages.getByName(sheet.PageStyle)
        set_property(page, "IsLandscape", bool(landscape))
        set_property(page, "ScaleToPagesX", 1)
        set_property(page, "ScaleToPagesY", 0)
        set_property(page, "LeftMargin", 900)
        set_property(page, "RightMargin", 900)
        set_property(page, "TopMargin", 1200)
        set_property(page, "BottomMargin", 1200)
    except Exception:
        pass


def build_calc(desktop, spec, theme):
    document = desktop.loadComponentFromURL("private:factory/scalc", "_blank", 0, (property_value("Hidden", True),))
    sheet_specs = [item for item in spec.get("sheets") or [] if isinstance(item, dict) and isinstance(item.get("rows"), list)]
    sheets = document.Sheets
    initial_names = list(sheets.getElementNames())
    used = set()
    for index, sheet_spec in enumerate(sheet_specs):
        name = normalized_sheet_name(sheet_spec.get("name"), index, used)
        if index == 0:
            sheet = sheets.getByName(initial_names[0])
            sheet.Name = name
        else:
            sheets.insertNewByName(name, index)
            sheet = sheets.getByName(name)

        rows = [list(row) for row in sheet_spec.get("rows") if isinstance(row, list)]
        row_count = len(rows)
        column_count = max([len(row) for row in rows] + [1])
        normalized_rows = tuple(tuple(
            (1.0 if row[col] is True else 0.0 if row[col] is False else row[col])
            if col < len(row) and row[col] is not None
            else ""
            for col in range(column_count)
        ) for row in rows)
        if row_count:
            used_range = sheet.getCellRangeByPosition(0, 0, column_count - 1, row_count - 1)
            used_range.setDataArray(normalized_rows)
            for row_index, row in enumerate(rows):
                for column_index, value in enumerate(row):
                    if isinstance(value, bool):
                        sheet.getCellByPosition(column_index, row_index).Formula = "=TRUE()" if value else "=FALSE()"
            style_calc_range(used_range, theme)
            header_rows = max(0, min(int(sheet_spec.get("headerRows", 1)), row_count))
            if header_rows:
                header = sheet.getCellRangeByPosition(0, 0, column_count - 1, header_rows - 1)
                style_calc_range(header, theme, background=theme["primary"], color=0xFFFFFF, bold=True, align="center")
            for row_index in range(header_rows, row_count):
                if (row_index - header_rows) % 2 == 1:
                    style_calc_range(sheet.getCellRangeByPosition(0, row_index, column_count - 1, row_index), theme, background=theme["soft"])

        for merge in sheet_spec.get("merges") or []:
            try:
                sheet.getCellRangeByName(str(merge)).merge(True)
            except Exception:
                pass
        for formula in sheet_spec.get("formulas") or []:
            try:
                sheet.getCellRangeByName(str(formula.get("cell"))).Formula = str(formula.get("formula"))
            except Exception:
                pass
        for range_style in sheet_spec.get("styles") or []:
            try:
                target = sheet.getCellRangeByName(str(range_style.get("range")))
                style_calc_range(
                    target,
                    theme,
                    background=parse_color(range_style.get("backgroundColor"), theme["soft"]) if range_style.get("backgroundColor") else None,
                    color=parse_color(range_style.get("color"), theme["body"]) if range_style.get("color") else None,
                    bold=range_style.get("bold") if isinstance(range_style.get("bold"), bool) else None,
                    align=range_style.get("horizontal"),
                    number_format=range_style.get("numberFormat"),
                    document=document,
                )
            except Exception:
                pass

        explicit_columns = {int(item.get("index")): item for item in sheet_spec.get("columns") or [] if isinstance(item, dict) and isinstance(item.get("index"), int)}
        for column_index in range(column_count):
            column = sheet.Columns.getByIndex(column_index)
            values = [str(row[column_index]) for row in rows if column_index < len(row) and row[column_index] is not None]
            requested = explicit_columns.get(column_index, {}).get("width")
            width_chars = float(requested) if isinstance(requested, (int, float)) else min(42, max(10, max([len(value) for value in values] + [8]) + 2))
            set_property(column, "Width", int(max(8, min(width_chars, 60)) * 430))
            format_code = explicit_columns.get(column_index, {}).get("format")
            if format_code and row_count:
                style_calc_range(sheet.getCellRangeByPosition(column_index, 1, column_index, row_count - 1), theme, number_format=format_code, document=document)

        freeze_rows = max(0, int(sheet_spec.get("freezeRows", sheet_spec.get("headerRows", 1))))
        freeze_columns = max(0, int(sheet_spec.get("freezeColumns", 0)))
        try:
            document.CurrentController.setActiveSheet(sheet)
            document.CurrentController.freezeAtPosition(freeze_columns, freeze_rows)
        except Exception:
            pass
        if sheet_spec.get("autoFilter") and row_count and column_count:
            try:
                range_address = sheet.getCellRangeByPosition(0, 0, column_count - 1, row_count - 1).RangeAddress
                range_name = f"WebPilotFilter{index + 1}"
                document.DatabaseRanges.addNewByName(range_name, range_address)
                document.DatabaseRanges.getByName(range_name).AutoFilter = True
            except Exception:
                pass
        for chart_index, chart_spec in enumerate(sheet_spec.get("charts") or []):
            if isinstance(chart_spec, dict):
                add_calc_chart(document, sheet, chart_spec, chart_index)
        configure_calc_page(document, sheet, bool(sheet_spec.get("landscape", column_count > 7)))
    return document, "calc"


def draw_shape(document, page, service, x, y, width, height):
    shape = document.createInstance(service)
    position = uno.createUnoStruct("com.sun.star.awt.Point")
    position.X, position.Y = int(x), int(y)
    size = uno.createUnoStruct("com.sun.star.awt.Size")
    size.Width, size.Height = int(width), int(height)
    shape.Position = position
    shape.Size = size
    page.add(shape)
    return shape


def draw_text(document, page, text, theme, x, y, width, height, *, size=20, color=None, bold=False, align=0):
    shape = draw_shape(document, page, "com.sun.star.drawing.TextShape", x, y, width, height)
    shape.String = str(text)
    set_property(shape, "CharFontName", theme["font"])
    set_property(shape, "CharFontNameAsian", theme["font"])
    set_property(shape, "CharHeight", float(size))
    set_property(shape, "CharHeightAsian", float(size))
    set_property(shape, "CharColor", theme["body"] if color is None else color)
    set_property(shape, "CharWeight", 150.0 if bold else 100.0)
    set_property(shape, "ParaAdjust", align)
    set_property(shape, "TextAutoGrowHeight", False)
    set_property(shape, "TextWordWrap", True)
    set_property(shape, "FillStyle", uno_constant("com.sun.star.drawing.FillStyle.NONE", 0))
    set_property(shape, "LineStyle", uno_constant("com.sun.star.drawing.LineStyle.NONE", 0))
    return shape


def add_slide(document, page, slide, theme, number, total, continuation=False):
    page.Width = 33867
    page.Height = 19050
    background = draw_shape(document, page, "com.sun.star.drawing.RectangleShape", 0, 0, 33867, 19050)
    set_property(background, "FillStyle", uno_constant("com.sun.star.drawing.FillStyle.SOLID", 1))
    set_property(background, "FillColor", theme["background"])
    set_property(background, "LineStyle", uno_constant("com.sun.star.drawing.LineStyle.NONE", 0))
    bar = draw_shape(document, page, "com.sun.star.drawing.RectangleShape", 0, 0, 550, 19050)
    set_property(bar, "FillStyle", uno_constant("com.sun.star.drawing.FillStyle.SOLID", 1))
    set_property(bar, "FillColor", theme["accent"])
    set_property(bar, "LineStyle", uno_constant("com.sun.star.drawing.LineStyle.NONE", 0))
    title = str(slide.get("title") or "Untitled") + ("（续）" if continuation else "")
    draw_text(document, page, title, theme, 1800, 1200, 29200, 2100, size=25, color=theme["primary"], bold=True)
    subtitle = str(slide.get("subtitle") or "").strip()
    if subtitle and not continuation:
        draw_text(document, page, subtitle, theme, 1850, 3300, 28000, 1000, size=11, color=theme["accent"])
    divider = draw_shape(document, page, "com.sun.star.drawing.RectangleShape", 1800, 4450, 29600, 60)
    set_property(divider, "FillStyle", uno_constant("com.sun.star.drawing.FillStyle.SOLID", 1))
    set_property(divider, "FillColor", theme["soft"])
    set_property(divider, "LineStyle", uno_constant("com.sun.star.drawing.LineStyle.NONE", 0))
    bullet_text = "\n\n".join(f"•  {line}" for line in slide.get("visibleBullets") or [])
    if not bullet_text:
        bullet_text = str(slide.get("content") or "")
    draw_text(document, page, bullet_text, theme, 2300, 5100, 28000, 10800, size=18, color=theme["body"])
    draw_text(document, page, "WebPilot", theme, 1850, 17600, 5000, 500, size=8, color=0x7A8491)
    draw_text(document, page, f"{number} / {total}", theme, 29000, 17600, 2500, 500, size=8, color=0x7A8491, align=1)


def build_impress(desktop, spec, theme):
    document = desktop.loadComponentFromURL("private:factory/simpress", "_blank", 0, (property_value("Hidden", True),))
    source_slides = [item for item in spec.get("slides") or [] if isinstance(item, dict)]
    if not source_slides:
        blocks = markdown_blocks(spec.get("content"))
        source_slides = [{"title": spec.get("title") or "Presentation", "bullets": [block.get("text", "") for block in blocks if block.get("text")]}]
    expanded = []
    for slide in source_slides:
        bullets = []
        if slide.get("content"):
            bullets.extend(line.strip() for line in str(slide.get("content")).splitlines() if line.strip())
        bullets.extend(str(item).strip() for item in slide.get("bullets") or [] if str(item).strip())
        groups = [bullets[index:index + 7] for index in range(0, len(bullets), 7)] or [[]]
        for group_index, group in enumerate(groups):
            expanded.append((dict(slide, visibleBullets=group), group_index > 0))

    pages = document.DrawPages
    while pages.Count > 1:
        pages.remove(pages.getByIndex(pages.Count - 1))
    for index, (slide, continuation) in enumerate(expanded):
        page = pages.getByIndex(0) if index == 0 and pages.Count else pages.insertNewByIndex(index)
        while page.Count:
            page.remove(page.getByIndex(page.Count - 1))
        add_slide(document, page, slide, theme, index + 1, len(expanded), continuation)
    return document, "impress"


FILTERS = {
    ".doc": ("writer", "MS Word 97"),
    ".docx": ("writer", "Office Open XML Text"),
    ".odt": ("writer", "writer8"),
    ".xls": ("calc", "MS Excel 97"),
    ".xlsx": ("calc", "Calc MS Excel 2007 XML"),
    ".ods": ("calc", "calc8"),
    ".ppt": ("impress", "MS PowerPoint 97"),
    ".pptx": ("impress", "Impress MS PowerPoint 2007 XML"),
    ".odp": ("impress", "impress8"),
}


def connect_office(soffice, profile):
    pipe_name = f"webpilot_{uuid.uuid4().hex}"
    accept = f"pipe,name={pipe_name};urp;StarOffice.ComponentContext"
    process = subprocess.Popen(
        [
            str(soffice),
            "--headless",
            "--nologo",
            "--nodefault",
            "--nofirststartwizard",
            "--norestore",
            "--nolockcheck",
            f"-env:UserInstallation={profile.as_uri()}",
            f"--accept={accept}",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
    deadline = time.monotonic() + 20
    last_error = None
    while time.monotonic() < deadline:
        try:
            context = resolver.resolve(f"uno:{accept}")
            manager = context.ServiceManager
            desktop = manager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
            return process, desktop
        except Exception as error:
            last_error = error
            if process.poll() is not None:
                break
            time.sleep(0.2)
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

    input_path = Path(args.input).resolve()
    output_path = Path(args.output).resolve()
    profile_path = Path(args.profile).resolve()
    profile_path.mkdir(parents=True, exist_ok=True)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    spec = json.loads(input_path.read_text(encoding="utf-8"))
    theme = resolve_theme(spec)
    extension = output_path.suffix.lower()
    if extension not in FILTERS and extension != ".pdf":
        raise ValueError(f"Unsupported LibreOffice output extension: {extension}")

    requested_type = spec.get("documentType")
    if extension in FILTERS:
        requested_type = {"writer": "word", "calc": "spreadsheet", "impress": "presentation"}[FILTERS[extension][0]]
    elif requested_type not in ("word", "spreadsheet", "presentation"):
        requested_type = "presentation" if spec.get("slides") else "spreadsheet" if spec.get("sheets") else "word"

    process, desktop = connect_office(Path(args.soffice).resolve(), profile_path)
    document = None
    try:
        if requested_type == "spreadsheet":
            document, kind = build_calc(desktop, spec, theme)
        elif requested_type == "presentation":
            document, kind = build_impress(desktop, spec, theme)
        else:
            document, kind = build_writer(desktop, spec, theme)
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
