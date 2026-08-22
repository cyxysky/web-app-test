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
from urllib.parse import unquote, unquote_to_bytes

import uno


DIAGNOSTICS = {"applied": 0, "fallbacks": [], "warnings": []}
GRAPHIC_PROVIDER = None


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


def set_property(target, name, value, *, required=False, context=""):
    try:
        setattr(target, name, value)
        DIAGNOSTICS["applied"] += 1
        return True
    except Exception as error:
        message = f"{context + ': ' if context else ''}{name}: {type(error).__name__}: {error}"
        if required:
            raise RuntimeError(f"LibreOffice rejected required property {message}") from error
        DIAGNOSTICS["warnings"].append(message)
        return False


def set_graphic(target, url, *, context=""):
    if GRAPHIC_PROVIDER is None:
        raise RuntimeError("LibreOffice graphic provider is unavailable")
    try:
        graphic = GRAPHIC_PROVIDER.queryGraphic((property_value("URL", url),))
    except Exception as error:
        raise RuntimeError(f"LibreOffice could not load graphic {context or url}: {type(error).__name__}: {error}") from error
    if graphic is None:
        raise RuntimeError(f"LibreOffice could not load graphic {context or url}")
    set_property(target, "Graphic", graphic, required=True, context=context)


CSS_COLORS = {
    "black": 0x000000, "white": 0xFFFFFF, "red": 0xFF0000, "green": 0x008000,
    "blue": 0x0000FF, "gray": 0x808080, "grey": 0x808080, "yellow": 0xFFFF00,
    "orange": 0xFFA500, "purple": 0x800080, "pink": 0xFFC0CB, "transparent": 0x000000,
}


def decode_percent_encoded_value(value):
    """Decode one URL-encoding pass without interpreting SVG/XML entities.

    Models occasionally copy fragments from a data SVG URL into an inline SVG
    block. For example, ``url(%23accent)`` is not a valid SVG paint reference
    after it is written to a standalone .svg file; it must become
    ``url(#accent)``. Do not use html.unescape here: SVG entities must retain
    their XML meaning until LibreOffice parses the file.
    """
    return unquote(str(value or ""))


def parse_color(value):
    cleaned = decode_percent_encoded_value(value).strip().lower()
    if not cleaned:
        return None
    if cleaned in CSS_COLORS:
        return CSS_COLORS[cleaned], 0.0 if cleaned == "transparent" else 1.0
    hexadecimal = cleaned.lstrip("#")
    if re.fullmatch(r"[0-9a-f]{3}", hexadecimal):
        hexadecimal = "".join(character * 2 for character in hexadecimal)
    if re.fullmatch(r"[0-9a-f]{4}", hexadecimal):
        hexadecimal = "".join(character * 2 for character in hexadecimal)
    if re.fullmatch(r"[0-9a-f]{6}", hexadecimal):
        return int(hexadecimal, 16), 1.0
    if re.fullmatch(r"[0-9a-f]{8}", hexadecimal):
        return int(hexadecimal[:6], 16), int(hexadecimal[6:], 16) / 255
    functional = re.fullmatch(r"rgba?\(\s*([\d.]+)%?\s*,\s*([\d.]+)%?\s*,\s*([\d.]+)%?(?:\s*[,/]\s*([\d.]+)%?)?\s*\)", cleaned)
    if functional:
        values = []
        for index in range(1, 4):
            raw = functional.group(index)
            component = float(raw)
            if f"{raw}%" in cleaned:
                component = component * 2.55
            values.append(max(0, min(255, round(component))))
        alpha_raw = functional.group(4)
        alpha = 1.0 if alpha_raw is None else float(alpha_raw)
        if alpha_raw is not None and f"{alpha_raw}%" in cleaned:
            alpha /= 100
        return (values[0] << 16) | (values[1] << 8) | values[2], max(0.0, min(1.0, alpha))
    return None


def color(value, fallback=0x000000):
    parsed = parse_color(value)
    return parsed[0] if parsed else fallback


def transparency(value, fallback=0):
    parsed = parse_color(value)
    return round((1 - parsed[1]) * 100) if parsed else fallback


def number(value, fallback=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(fallback)


def length_hmm(value, unit="mm", fallback=0.0):
    if isinstance(value, str):
        cleaned = value.strip().lower()
        match = re.fullmatch(r"(-?[\d.]+)\s*(px|pt|mm|cm|in)?", cleaned)
        if match:
            value, unit = float(match.group(1)), match.group(2) or unit
        else:
            value = fallback
    value = number(value, fallback)
    factors = {"px": 25.4 / 96 * 100, "pt": 25.4 / 72 * 100, "mm": 100, "cm": 1000, "in": 2540}
    return int(value * factors.get(str(unit or "mm").lower(), 100))


def padding(value, fallback=0, unit="mm"):
    if isinstance(value, list):
        values = [length_hmm(item, unit, fallback) for item in value]
        if len(values) == 1:
            return values * 4
        if len(values) == 2:
            return [values[0], values[1], values[0], values[1]]
        if len(values) == 3:
            return [values[0], values[1], values[2], values[1]]
        return (values + [0, 0, 0, 0])[:4]
    converted = length_hmm(value, unit, fallback)
    return [converted] * 4


def style_for(spec, block=None):
    document = spec.get("document") if isinstance(spec.get("document"), dict) else {}
    default = document.get("defaultStyle") if isinstance(document.get("defaultStyle"), dict) else {}
    own = block.get("style") if isinstance(block, dict) and isinstance(block.get("style"), dict) else {}
    return {**default, **own}


def normalized_block(block):
    if not isinstance(block, dict):
        return block
    result = dict(block)
    style = style_for({"document": {}}, result)
    if style:
        result["style"] = style
    if isinstance(result.get("children"), list):
        result["children"] = [normalized_block(child) for child in result["children"]]
    if isinstance(result.get("columns"), list):
        result["columns"] = [
            {**column, "blocks": [normalized_block(child) for child in column.get("blocks") or []]}
            if isinstance(column, dict) else column
            for column in result["columns"]
        ]
    return result


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


def safe_graphic_name(value):
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", str(value or uuid.uuid4().hex)).strip("._")
    return cleaned[:96] or uuid.uuid4().hex


def normalized_inline_svg(value):
    raw_svg = str(value or "").strip()
    if not raw_svg:
        return ""
    # Accept a complete data SVG URI defensively when a provider puts it in
    # `svg` instead of `source`. Its payload is decoded exactly once.
    if raw_svg.lower().startswith("data:"):
        header, separator, payload = raw_svg.partition(",")
        if separator and "svg" in header.lower():
            try:
                decoded = base64.b64decode(payload) if ";base64" in header.lower() else unquote_to_bytes(payload)
                return decoded.decode("utf-8-sig")
            except Exception as error:
                DIAGNOSTICS["warnings"].append(f"inline SVG data URI could not be decoded: {type(error).__name__}: {error}")
                return raw_svg
    # Inline SVG is not a URL. Normalize one encoded pass so encoded fragment
    # references (`%23id`) and copied CSS colors (`%23FFFFFF`) remain valid.
    return decode_percent_encoded_value(raw_svg)


def materialize_graphic(block, work_dir):
    raw_svg = normalized_inline_svg(block.get("svg"))
    source = str(block.get("source") or "").strip()
    if raw_svg:
        target = work_dir / f"{safe_graphic_name(block.get('id'))}.svg"
        target.write_text(raw_svg, encoding="utf-8")
        return target.as_uri()
    if source.startswith("data:"):
        header, payload = source.split(",", 1)
        extension = ".svg" if "svg" in header else ".png" if "png" in header else ".jpg"
        target = work_dir / f"{safe_graphic_name(block.get('id'))}{extension}"
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


def decode_uno_value(value):
    if isinstance(value, list):
        return tuple(decode_uno_value(item) for item in value)
    if not isinstance(value, dict):
        return value
    marker = value.get("$uno")
    if marker in ("constant", "enum"):
        name = str(value.get("name") or "")
        if not name:
            raise ValueError("$uno=constant requires name")
        return uno.getConstantByName(name)
    if marker == "sequence":
        return tuple(decode_uno_value(item) for item in value.get("items") or [])
    if marker == "propertyValues":
        fields = value.get("fields") or {}
        return tuple(property_value(str(name), decode_uno_value(item)) for name, item in fields.items())
    if marker == "struct":
        name = str(value.get("name") or "")
        if not name:
            raise ValueError("$uno=struct requires name")
        result = uno.createUnoStruct(name)
        for field, field_value in (value.get("fields") or {}).items():
            setattr(result, field, decode_uno_value(field_value))
        return result
    return {key: decode_uno_value(item) for key, item in value.items()}


def apply_uno_properties(target, block):
    properties = block.get("unoProperties") if isinstance(block, dict) else None
    if not isinstance(properties, dict):
        return
    target_info = None
    try:
        target_info = target.getPropertySetInfo()
    except Exception:
        # Some UNO objects use direct attributes without a PropertySetInfo.
        # setattr below remains the authoritative compatibility check for them.
        target_info = None
    for name, value in properties.items():
        if target_info is not None and not target_info.hasPropertyByName(str(name)):
            context = str(block.get("id") or block.get("type") or "block")
            raise ValueError(
                f"UNO property {name} is not supported by the native object for {context}. "
                "Use a documented property of that block's emitted UNO object, or use the document DSL for layout."
            )
        set_property(target, str(name), decode_uno_value(value), required=True, context=str(block.get("id") or block.get("type") or "block"))


def parse_linear_gradient(value):
    if isinstance(value, dict) and value.get("type") in ("linearGradient", "linear-gradient"):
        stops = value.get("stops") or []
        colors = [parse_color(stop.get("color")) for stop in stops if isinstance(stop, dict)]
        colors = [item for item in colors if item]
        if len(colors) >= 2:
            return colors[0], colors[-1], number(value.get("angle"), 0)
    if not isinstance(value, str):
        return None
    value = decode_percent_encoded_value(value)
    if not value.strip().lower().startswith("linear-gradient("):
        return None
    angle_match = re.search(r"linear-gradient\(\s*(-?[\d.]+)deg", value, re.I)
    tokens = re.findall(r"#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|\b(?:black|white|red|green|blue|gray|grey|yellow|orange|purple|pink|transparent)\b", value, re.I)
    colors = [parse_color(token) for token in tokens]
    colors = [item for item in colors if item]
    if len(colors) < 2:
        return None
    return colors[0], colors[-1], number(angle_match.group(1), 0) if angle_match else 0


def apply_fill(target, style, *, default_color=None):
    fill = style.get("fill", style.get("backgroundColor"))
    gradient = parse_linear_gradient(fill)
    if gradient:
        start, end, angle = gradient
        value = uno.createUnoStruct("com.sun.star.awt.Gradient")
        value.Style = uno_constant("com.sun.star.awt.GradientStyle.LINEAR", 0)
        value.StartColor, value.EndColor = start[0], end[0]
        value.Angle = int(angle * 10)
        value.Border, value.XOffset, value.YOffset = 0, 50, 50
        value.StartIntensity, value.EndIntensity, value.StepCount = 100, 100, 0
        set_property(target, "FillStyle", uno_constant("com.sun.star.drawing.FillStyle.GRADIENT", 2))
        set_property(target, "FillGradient", value)
        set_property(target, "FillTransparence", max(transparency_from_opacity(style), round((2 - start[1] - end[1]) * 50)))
        return
    if fill is not None or default_color is not None:
        raw = fill if fill is not None else default_color
        parsed = parse_color(raw)
        if parsed and parsed[1] <= 0:
            set_property(target, "FillStyle", uno_constant("com.sun.star.drawing.FillStyle.NONE", 0))
            return
        set_property(target, "FillStyle", uno_constant("com.sun.star.drawing.FillStyle.SOLID", 1))
        set_property(target, "FillColor", color(raw, color(default_color, 0xFFFFFF)))
        set_property(target, "FillTransparence", max(transparency(raw), transparency_from_opacity(style)))
    else:
        set_property(target, "FillStyle", uno_constant("com.sun.star.drawing.FillStyle.NONE", 0))


def transparency_from_opacity(style):
    if style.get("opacity") is None:
        return 0
    opacity = max(0.0, min(1.0, number(style.get("opacity"), 1)))
    return round((1 - opacity) * 100)


def apply_line(target, style):
    line_color = style.get("borderColor", style.get("lineColor"))
    line_width = style.get("borderWidth", style.get("lineWidth"))
    if line_color is None and not number(line_width, 0):
        set_property(target, "LineStyle", uno_constant("com.sun.star.drawing.LineStyle.NONE", 0))
        return
    set_property(target, "LineStyle", uno_constant("com.sun.star.drawing.LineStyle.SOLID", 1))
    set_property(target, "LineColor", color(line_color, 0x000000))
    set_property(target, "LineTransparence", transparency(line_color))
    if line_width is not None:
        set_property(target, "LineWidth", length_hmm(line_width, style.get("unit", "px")))


def apply_transform_and_shadow(target, style):
    if style.get("rotation") is not None:
        set_property(target, "RotateAngle", int(number(style.get("rotation")) * 100))
    if style.get("borderRadius") is not None:
        set_property(target, "CornerRadius", length_hmm(style.get("borderRadius"), style.get("unit", "px")))
    shadow = style.get("shadow")
    if shadow:
        details = shadow if isinstance(shadow, dict) else {}
        set_property(target, "Shadow", True)
        set_property(target, "ShadowColor", color(details.get("color"), 0x000000))
        set_property(target, "ShadowTransparence", transparency(details.get("color"), int(number(details.get("transparency"), 35))))
        set_property(target, "ShadowXDistance", length_hmm(details.get("x", 3), style.get("unit", "px")))
        set_property(target, "ShadowYDistance", length_hmm(details.get("y", 3), style.get("unit", "px")))
        if details.get("blur") is not None:
            set_property(target, "ShadowBlur", int(number(details.get("blur")) * 100))


def apply_shape_style(target, style, *, default_fill=None):
    apply_fill(target, style, default_color=default_fill)
    apply_line(target, style)
    apply_transform_and_shadow(target, style)


def style_text(target, style, *, default_size=11, default_color=0x000000):
    font = str(style.get("fontFamily") or "Liberation Sans")
    size = number(style.get("fontSize"), default_size)
    set_property(target, "CharFontName", font)
    set_property(target, "CharFontNameAsian", font)
    set_property(target, "CharHeight", size)
    set_property(target, "CharHeightAsian", size)
    set_property(target, "CharColor", color(style.get("color"), default_color))
    set_property(target, "CharTransparence", max(transparency(style.get("color")), transparency_from_opacity(style)))
    weight = style.get("fontWeight")
    set_property(target, "CharWeight", 150.0 if weight in ("bold", 600, 700, 800, 900) or number(weight) >= 600 else 100.0)
    set_property(target, "CharPosture", uno_constant("com.sun.star.awt.FontSlant.ITALIC", 2) if style.get("fontStyle") == "italic" else uno_constant("com.sun.star.awt.FontSlant.NONE", 0))
    if style.get("letterSpacing") is not None:
        requested_spacing = number(style.get("letterSpacing"))
        # CharKerning is a signed UNO short measured in 1/100 pt. Preserve the
        # authored value exactly inside the actual storage range instead of
        # imposing an arbitrary visual-design range.
        kerning = round(requested_spacing * 100)
        if kerning < -32768 or kerning > 32767:
            raise ValueError(
                f"letterSpacing {requested_spacing}pt exceeds LibreOffice CharKerning's "
                "signed-short range (-327.68pt to 327.67pt)"
            )
        set_property(target, "CharKerning", kerning)
    alignments = {"left": 0, "right": 1, "center": 3, "justify": 2}
    set_property(target, "ParaAdjust", alignments.get(style.get("align"), 0))
    if style.get("lineHeight") is not None:
        line_spacing = uno.createUnoStruct("com.sun.star.style.LineSpacing")
        line_height = number(style.get("lineHeight"), 1)
        line_spacing.Mode = 0
        line_spacing.Height = int(line_height * 100 if line_height <= 4 else line_height)
        set_property(target, "ParaLineSpacing", line_spacing)


def configure_writer_page(document, spec):
    settings = spec.get("document") if isinstance(spec.get("document"), dict) else {}
    page_spec = settings.get("page") if isinstance(settings.get("page"), dict) else {}
    try:
        pages = document.StyleFamilies.getByName("PageStyles")
        names = list(pages.getElementNames())
        page = pages.getByName("Default Page Style") if "Default Page Style" in names else pages.getByName(names[0])
        unit = page_spec.get("unit", "mm")
        for source, target in (("marginLeft", "LeftMargin"), ("marginRight", "RightMargin"), ("marginTop", "TopMargin"), ("marginBottom", "BottomMargin")):
            if source in page_spec:
                set_property(page, target, length_hmm(page_spec[source], unit))
        if page_spec.get("orientation") == "landscape":
            width, height = page.Width, page.Height
            set_property(page, "IsLandscape", True)
            if width < height:
                page.Width, page.Height = height, width
        if page_spec.get("width") and page_spec.get("height"):
            page.Width = length_hmm(page_spec["width"], unit)
            page.Height = length_hmm(page_spec["height"], unit)
        if page_spec.get("backgroundColor"):
            set_property(page, "BackColor", color(page_spec.get("backgroundColor"), 0xFFFFFF))
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
    except Exception as error:
        raise RuntimeError(f"Unable to configure Writer page styles: {error}") from error
    apply_uno_properties(document, {"id": "writer-document", "unoProperties": settings.get("unoProperties")})


def writer_paragraph(document, value, style, *, default_size=11, block=None):
    text = document.Text
    cursor = text.createTextCursorByRange(text.End)
    style_text(cursor, style, default_size=default_size)
    margins = padding(style.get("margin"), 0, style.get("unit", "mm"))
    set_property(cursor, "ParaTopMargin", margins[0])
    set_property(cursor, "ParaBottomMargin", margins[2])
    set_property(cursor, "ParaLeftMargin", margins[3])
    if style.get("backgroundColor"):
        set_property(cursor, "ParaBackColor", color(style.get("backgroundColor"), 0xFFFFFF))
    if block:
        apply_uno_properties(cursor, block)
    text.insertString(cursor, str(value or ""), False)
    text.insertControlCharacter(cursor, uno_constant("com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK", 0), False)


def writer_table(document, rows, style, block=None):
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
            if block and isinstance(block.get("cellUnoProperties"), dict):
                apply_uno_properties(cell, {"id": f"{block.get('id')}-cell-{row_index}-{column_index}", "unoProperties": block["cellUnoProperties"]})
    if block:
        apply_uno_properties(table, block)
    document.Text.insertControlCharacter(document.Text.End, uno_constant("com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK", 0), False)


def writer_graphic(document, block, style, work_dir):
    url = prepare_graphic(block, work_dir)
    if not url:
        return
    graphic = document.createInstance("com.sun.star.text.TextGraphicObject")
    set_graphic(graphic, url, context=str(block.get("id") or block.get("type") or "graphic"))
    if style.get("width"):
        set_property(graphic, "Width", length_hmm(style.get("width"), style.get("unit", "mm")))
    if style.get("height"):
        set_property(graphic, "Height", length_hmm(style.get("height"), style.get("unit", "mm")))
    set_property(graphic, "AnchorType", uno_constant("com.sun.star.text.TextContentAnchorType.AS_CHARACTER", 0))
    apply_uno_properties(graphic, block)
    document.Text.insertTextContent(document.Text.End, graphic, False)
    document.Text.insertControlCharacter(document.Text.End, uno_constant("com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK", 0), False)


def custom_shape_service(block, default_service):
    requested = str(block.get("unoService") or "").strip()
    if not requested:
        shape_kind = str(block.get("shape") or block.get("shapeType") or "rect").lower()
        return {
            "ellipse": "com.sun.star.drawing.EllipseShape",
            "circle": "com.sun.star.drawing.EllipseShape",
            "line": "com.sun.star.drawing.LineShape",
            "arrow": "com.sun.star.drawing.LineShape",
            "text": "com.sun.star.drawing.TextShape",
        }.get(shape_kind, default_service)
    allowed = requested.startswith("com.sun.star.drawing.") or requested.startswith("com.sun.star.presentation.")
    if not allowed or not requested.endswith("Shape"):
        raise ValueError(f"Unsupported UNO document shape service: {requested}")
    return requested


def visual_box(style, default_unit="mm", defaults=(10, 10, 80, 24)):
    unit = style.get("unit", default_unit)
    return tuple(length_hmm(style.get(name), unit, fallback) for name, fallback in zip(("x", "y", "width", "height"), defaults))


def writer_draw_object(document, block, style, work_dir, page_number):
    kind = str(block.get("type") or "shape")
    page = document.DrawPage
    graphic = kind in ("image", "svg", "chart")
    service = "com.sun.star.drawing.GraphicObjectShape" if graphic else custom_shape_service(block, "com.sun.star.drawing.RectangleShape" if kind == "shape" else "com.sun.star.drawing.TextShape")
    shape = draw_shape(document, page, service, *visual_box(style))
    set_property(shape, "AnchorType", uno_constant("com.sun.star.text.TextContentAnchorType.AT_PAGE", 2))
    set_property(shape, "AnchorPageNo", page_number)
    if graphic:
        url = prepare_graphic(block, work_dir)
        if not url:
            raise ValueError(f"Graphic block {block.get('id')} has no usable svg/source")
        set_graphic(shape, url, context=str(block.get("id") or kind))
    else:
        shape.String = block_text(block)
        style_text(shape, style, default_size=max(12, 26 - int(number(block.get("level"), 1)) * 3) if kind == "heading" else 11)
        apply_shape_style(shape, style, default_fill="#FFFFFF" if kind == "shape" else None)
    apply_uno_properties(shape, block)
    return shape


def positioned(style):
    return style.get("position") == "absolute" or any(style.get(key) is not None for key in ("x", "y"))


def render_writer_blocks(document, blocks, spec, work_dir, page_number=1):
    for block in blocks:
        if not isinstance(block, dict):
            continue
        kind = str(block.get("type") or "text")
        style = style_for(spec, block)
        # Pagination is document semantics, not a paragraph UNO escape hatch.
        if block.get("breakBefore") == "page":
            document.Text.insertControlCharacter(document.Text.End, uno_constant("com.sun.star.text.ControlCharacter.PAGE_BREAK", 1), False)
        if kind in ("image", "svg", "chart"):
            if positioned(style):
                writer_draw_object(document, block, style, work_dir, page_number)
            else:
                writer_graphic(document, block, style, work_dir)
        elif kind == "table":
            writer_table(document, block.get("rows") or [], style, block)
        elif kind == "shape" or block.get("unoService"):
            writer_draw_object(document, block, style, work_dir, page_number)
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
            if positioned(style):
                writer_draw_object(document, {**block, "text": "\n".join("  ".join(row) for row in rows)}, style, work_dir, page_number)
            else:
                writer_table(document, rows, style, block)
        elif kind == "columns":
            columns = block.get("columns") if isinstance(block.get("columns"), list) else []
            writer_table(document, [["\n".join(block_text(child) for child in column.get("blocks", [])) for column in columns]], style)
        elif kind == "group":
            render_writer_blocks(document, block.get("children") or [], spec, work_dir, page_number)
        elif kind in ("page", "sheet"):
            render_writer_blocks(document, block.get("children") or [], spec, work_dir, page_number)
        else:
            heading_level = int(number(block.get("level"), 1))
            default_size = max(12, 26 - heading_level * 3) if kind == "heading" else 10 if kind == "code" else 11
            if positioned(style):
                writer_draw_object(document, block, style, work_dir, page_number)
            else:
                writer_paragraph(document, block_text(block), style, default_size=default_size, block=block)


def build_writer(desktop, spec, work_dir):
    document = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, (property_value("Hidden", True),))
    configure_writer_page(document, spec)
    blocks = spec.get("blocks") or []
    page_blocks = [block for block in blocks if isinstance(block, dict) and block.get("type") == "page"]
    if page_blocks and len(page_blocks) == len(blocks):
        for index, page_block in enumerate(page_blocks):
            if index:
                document.Text.insertControlCharacter(document.Text.End, uno_constant("com.sun.star.text.ControlCharacter.PAGE_BREAK", 1), False)
            render_writer_blocks(document, page_block.get("children") or [], spec, work_dir, index + 1)
    else:
        render_writer_blocks(document, blocks, spec, work_dir)
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
    try:
        target.setDataArray(normalized)
    except Exception as error:
        DIAGNOSTICS["fallbacks"].append({
            "blockId": block.get("id"),
            "strategy": "cell-by-cell",
            "reason": f"setDataArray rejected mixed values: {type(error).__name__}",
        })
        for row_index, row in enumerate(normalized):
            for column_index, value in enumerate(row):
                cell = sheet.getCellByPosition(start_column + column_index, start_row + row_index)
                if isinstance(value, bool):
                    cell.Formula = "=TRUE()" if value else "=FALSE()"
                elif isinstance(value, (int, float)) and not isinstance(value, bool):
                    cell.Value = float(value)
                else:
                    cell.String = str(value)
    style = block.get("style") if isinstance(block.get("style"), dict) else {}
    style_text(target, style, default_size=10)
    if style.get("backgroundColor"):
        set_property(target, "CellBackColor", color(style.get("backgroundColor"), 0xFFFFFF))
    apply_uno_properties(target, block)
    for merge in block.get("merges") or []:
        try:
            sheet.getCellRangeByName(str(merge)).merge(True)
        except Exception as error:
            raise RuntimeError(f"Unable to merge Calc range {merge} in block {block.get('id')}: {error}") from error
    for formula in block.get("formulas") or []:
        try:
            sheet.getCellRangeByName(str(formula.get("cell"))).Formula = str(formula.get("formula"))
        except Exception as error:
            raise RuntimeError(f"Unable to write Calc formula in block {block.get('id')}: {error}") from error
    for column in block.get("columns") or []:
        if isinstance(column, dict) and isinstance(column.get("index"), int) and column.get("width") is not None:
            set_property(sheet.Columns.getByIndex(column["index"]), "Width", int(number(column["width"]) * 430))
    return start_row + len(rows) + 1


def calc_chart(sheet, block, index):
    try:
        source = sheet.getCellRangeByName(str(block.get("range") or "A1:B2"))
        rectangle = uno.createUnoStruct("com.sun.star.awt.Rectangle")
        style = block.get("style") if isinstance(block.get("style"), dict) else {}
        unit = style.get("unit", "px")
        rectangle.X = length_hmm(style.get("x"), unit, 40)
        rectangle.Y = length_hmm(style.get("y"), unit, 40 + index * 320)
        rectangle.Width = length_hmm(style.get("width"), unit, 640)
        rectangle.Height = length_hmm(style.get("height"), unit, 360)
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
        apply_uno_properties(chart, block)
    except Exception as error:
        raise RuntimeError(f"Unable to create Calc chart {block.get('id') or index}: {error}") from error


def calc_draw_object(document, sheet, block, style, work_dir):
    kind = str(block.get("type") or "shape")
    graphic = kind in ("image", "svg") or (kind == "chart" and (block.get("svg") or block.get("source")))
    service = "com.sun.star.drawing.GraphicObjectShape" if graphic else custom_shape_service(block, "com.sun.star.drawing.RectangleShape" if kind == "shape" else "com.sun.star.drawing.TextShape")
    shape = draw_shape(document, sheet.DrawPage, service, *visual_box(style, "px", (40, 40, 480, 160)))
    if graphic:
        url = prepare_graphic(block, work_dir)
        if not url:
            raise ValueError(f"Graphic block {block.get('id')} has no usable svg/source")
        set_graphic(shape, url, context=str(block.get("id") or kind))
    else:
        shape.String = block_text(block)
        style_text(shape, style, default_size=20 if kind == "heading" else 11)
        apply_shape_style(shape, style, default_fill="#FFFFFF" if kind == "shape" else None)
    apply_uno_properties(shape, block)
    return shape


def build_calc(desktop, spec, work_dir):
    document = desktop.loadComponentFromURL("private:factory/scalc", "_blank", 0, (property_value("Hidden", True),))
    blocks = spec.get("blocks") or []
    sheet_blocks = [block for block in blocks if isinstance(block, dict) and block.get("type") == "sheet"]
    if not sheet_blocks or len(sheet_blocks) != len(blocks):
        raise ValueError("Spreadsheet documents require explicit top-level sheet blocks")
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
        apply_uno_properties(sheet, sheet_block)
        row = 0
        for block in sheet_block.get("children") or []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "table":
                row = calc_table(document, sheet, block, int(number(block.get("startRow"), row)), int(number(block.get("startColumn"), 0)))
            elif block.get("type") == "chart":
                if block.get("svg") or block.get("source"):
                    calc_draw_object(document, sheet, block, block.get("style") or {}, work_dir)
                else:
                    calc_chart(sheet, block, row)
            elif block.get("type") == "group":
                for child in block.get("children") or []:
                    calc_draw_object(document, sheet, child, child.get("style") or {}, work_dir)
            elif block.get("type") in ("image", "svg", "shape") or block.get("unoService") or positioned(block.get("style") or {}):
                calc_draw_object(document, sheet, block, block.get("style") or {}, work_dir)
            else:
                row = calc_table(document, sheet, {"rows": [[block_text(block)]], "style": block.get("style")}, row, 0)
        page_spec = (spec.get("document") or {}).get("page") or {}
        try:
            page = document.StyleFamilies.getByName("PageStyles").getByName(sheet.PageStyle)
            set_property(page, "IsLandscape", page_spec.get("orientation") == "landscape")
        except Exception as error:
            raise RuntimeError(f"Unable to configure Calc page style for sheet {name}: {error}") from error
    apply_uno_properties(document, {"id": "calc-document", "unoProperties": (spec.get("document") or {}).get("unoProperties")})
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


def slide_measure(value, total, fallback, unit="px"):
    if isinstance(value, str) and value.strip().endswith("%"):
        return total * number(value.strip()[:-1]) / 100
    return length_hmm(value, unit, fallback)


def slide_box(style, page_width, page_height, default_y, origin_x=0, origin_y=0, default_x=60):
    unit = style.get("unit", "px")
    local_x = slide_measure(style.get("x"), page_width, default_x, unit)
    local_y = default_y - origin_y if style.get("y") is None else slide_measure(style.get("y"), page_height, 0, unit)
    x = origin_x + local_x
    y = origin_y + local_y
    width = slide_measure(style.get("width"), page_width, 880, unit)
    height = slide_measure(style.get("height"), page_height, 96, unit)
    return x, y, max(1, min(width, page_width - local_x)), max(1, min(height, page_height - local_y))


def slide_text(document, page, value, style, box, default_size=18, block=None):
    shape = draw_shape(document, page, "com.sun.star.drawing.TextShape", *box)
    shape.String = str(value or "")
    style_text(shape, style, default_size=default_size)
    set_property(shape, "TextWordWrap", True)
    vertical = {"top": 0, "middle": 2, "center": 2, "bottom": 3}
    if style.get("verticalAlign") in vertical:
        set_property(shape, "TextVerticalAdjust", vertical[style["verticalAlign"]])
    for source, target in (("paddingLeft", "TextLeftDistance"), ("paddingRight", "TextRightDistance"), ("paddingTop", "TextUpperDistance"), ("paddingBottom", "TextLowerDistance")):
        if style.get(source) is not None:
            set_property(shape, target, length_hmm(style[source], style.get("unit", "px")))
    apply_shape_style(shape, style)
    if block:
        apply_uno_properties(shape, block)
    return shape


def slide_graphic(document, page, block, style, box, work_dir):
    url = prepare_graphic(block, work_dir)
    if not url:
        return
    shape = draw_shape(document, page, "com.sun.star.drawing.GraphicObjectShape", *box)
    set_graphic(shape, url, context=str(block.get("id") or block.get("type") or "graphic"))
    apply_transform_and_shadow(shape, style)
    apply_uno_properties(shape, block)


def slide_table(document, page, block, style, box):
    if block.get("unoProperties"):
        raise ValueError(f"PPT table block {block.get('id')} uses a synthetic text-grid and cannot accept unoProperties; use SVG or explicit child shapes")
    rows = [list(row) for row in block.get("rows") or [] if isinstance(row, list)]
    if not rows:
        return
    columns = max(len(row) for row in rows)
    x, y, width, height = box
    column_specs = block.get("columns") if isinstance(block.get("columns"), list) else []
    weights = []
    for column_index in range(columns):
        raw_width = column_specs[column_index].get("width") if column_index < len(column_specs) and isinstance(column_specs[column_index], dict) else 1
        if isinstance(raw_width, str) and raw_width.strip().endswith("%"):
            raw_width = number(raw_width.strip()[:-1], 1)
        weights.append(max(0.01, number(raw_width, 1)))
    weight_total = sum(weights) or columns
    column_widths = [width * weight / weight_total for weight in weights]
    explicit_height = style.get("height") is not None
    minimum_cell_height = length_hmm(max(28, number(style.get("fontSize"), 10) * 1.8), "px")
    cell_h = height / len(rows) if explicit_height else max(height / len(rows), minimum_cell_height)
    cell_style = block.get("cellStyle") if isinstance(block.get("cellStyle"), dict) else {}
    header_style = block.get("headerStyle") if isinstance(block.get("headerStyle"), dict) else {}
    for row_index, row in enumerate(rows):
        current_x = x
        for column_index in range(columns):
            value = row[column_index] if column_index < len(row) else ""
            resolved_style = {**style, **cell_style, **(header_style if row_index == 0 else {})}
            resolved_style.setdefault("borderColor", style.get("borderColor") or "#D1D5DB")
            resolved_style.setdefault("borderWidth", 1)
            resolved_style.setdefault("paddingLeft", 6)
            resolved_style.setdefault("paddingRight", 6)
            resolved_style.setdefault("paddingTop", 4)
            resolved_style.setdefault("paddingBottom", 4)
            cell_width = column_widths[column_index]
            slide_text(document, page, value, resolved_style, (current_x, y + row_index * cell_h, cell_width, cell_h), default_size=10)
            current_x += cell_width


def render_slide_blocks(document, page, blocks, spec, work_dir, page_width, page_height, origin_x=0, origin_y=0, default_x=60):
    cursor_y = origin_y + length_hmm(48, "px")
    for block in blocks:
        if not isinstance(block, dict):
            continue
        kind = str(block.get("type") or "text")
        style = style_for(spec, block)
        box = slide_box(style, page_width, page_height, cursor_y, origin_x, origin_y, default_x)
        if kind in ("image", "svg", "chart"):
            slide_graphic(document, page, block, style, box, work_dir)
        elif kind == "table":
            slide_table(document, page, block, style, box)
        elif kind == "shape":
            service = custom_shape_service(block, "com.sun.star.drawing.RectangleShape")
            shape = draw_shape(document, page, service, *box)
            apply_shape_style(shape, style, default_fill="#FFFFFF")
            if block.get("text"):
                shape.String = str(block["text"])
                style_text(shape, style)
            apply_uno_properties(shape, block)
        elif kind == "group":
            has_local_frame = any(style.get(key) is not None for key in ("x", "y", "width", "height"))
            if has_local_frame:
                group_x, group_y, group_width, group_height = box
                render_slide_blocks(
                    document,
                    page,
                    block.get("children") or [],
                    spec,
                    work_dir,
                    group_width,
                    group_height,
                    group_x,
                    group_y,
                    0,
                )
            else:
                render_slide_blocks(document, page, block.get("children") or [], spec, work_dir, page_width, page_height, origin_x, origin_y, default_x)
        elif block.get("unoService"):
            service = custom_shape_service(block, "com.sun.star.drawing.RectangleShape")
            shape = draw_shape(document, page, service, *box)
            if hasattr(shape, "String"):
                shape.String = block_text(block)
                style_text(shape, style)
            apply_shape_style(shape, style)
            apply_uno_properties(shape, block)
        elif kind == "columns":
            columns = block.get("columns") or []
            x, y, width, height = box
            gap = length_hmm(style.get("gap"), style.get("unit", "px"), 20)
            total = sum(number(column.get("width"), 1) for column in columns) or len(columns) or 1
            current_x = x
            for column in columns:
                column_width = (width - gap * max(0, len(columns) - 1)) * number(column.get("width"), 1) / total
                render_slide_blocks(document, page, [dict(child, style={**(child.get("style") or {}), "x": f"{(current_x - origin_x) / 100}mm", "y": f"{(y - origin_y) / 100}mm", "width": f"{column_width / 100}mm"}) for child in column.get("blocks") or []], spec, work_dir, page_width, page_height, origin_x, origin_y, default_x)
                current_x += column_width + gap
        elif kind in ("card", "metric", "timeline"):
            items = block.get("items") if isinstance(block.get("items"), list) else []
            value = "\n".join(f"{item.get('label', item.get('title', ''))}  {item.get('value', item.get('text', ''))}" if isinstance(item, dict) else str(item) for item in items) or block_text(block)
            slide_text(document, page, value, style, box, block=block)
        else:
            size = max(14, 30 - int(number(block.get("level"), 1)) * 3) if kind == "heading" else 18
            slide_text(document, page, block_text(block), style, box, default_size=size, block=block)
        cursor_y = max(cursor_y, box[1] + box[3] + length_hmm(style.get("gap"), style.get("unit", "px"), 16))


def build_impress(desktop, spec, work_dir):
    document = desktop.loadComponentFromURL("private:factory/simpress", "_blank", 0, (property_value("Hidden", True),))
    settings = spec.get("document") if isinstance(spec.get("document"), dict) else {}
    page_spec = settings.get("page") if isinstance(settings.get("page"), dict) else {}
    page_unit = page_spec.get("unit", "px")
    width = length_hmm(page_spec.get("width"), page_unit, 1280)
    height = length_hmm(page_spec.get("height"), page_unit, 720)
    if page_spec.get("orientation") == "portrait" and width > height:
        width, height = height, width
    page_blocks = [block for block in spec.get("blocks") or [] if isinstance(block, dict) and block.get("type") == "page"]
    if not page_blocks or len(page_blocks) != len(spec.get("blocks") or []):
        raise ValueError("Presentation documents require explicit top-level page blocks")
    pages = document.DrawPages
    while pages.Count > 1:
        pages.remove(pages.getByIndex(pages.Count - 1))
    for index, page_block in enumerate(page_blocks):
        page = pages.getByIndex(0) if index == 0 else pages.insertNewByIndex(index)
        while page.Count:
            page.remove(page.getByIndex(page.Count - 1))
        page.Width, page.Height = width, height
        apply_uno_properties(page, page_block)
        page_style = style_for(spec, page_block)
        background_fill = page_style.get("fill", page_style.get("backgroundColor", page_spec.get("backgroundColor")))
        if background_fill:
            background = draw_shape(document, page, "com.sun.star.drawing.RectangleShape", 0, 0, width, height)
            apply_fill(background, {**page_style, "fill": background_fill}, default_color="#FFFFFF")
            set_property(background, "LineStyle", uno_constant("com.sun.star.drawing.LineStyle.NONE", 0))
        render_slide_blocks(document, page, page_block.get("children") or [], spec, work_dir, width, height)
    apply_uno_properties(document, {"id": "impress-document", "unoProperties": settings.get("unoProperties")})
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
            desktop = manager.createInstanceWithContext("com.sun.star.frame.Desktop", context)
            graphic_provider = manager.createInstanceWithContext("com.sun.star.graphic.GraphicProvider", context)
            return process, desktop, graphic_provider
        except Exception as error:
            last_error = error
            if process.poll() is not None:
                break
            time.sleep(.2)
    try:
        process.terminate()
    except Exception:
        pass
    raise RuntimeError(f"Unable to connect to LibreOffice UNO: {last_error}")


def close_component(component):
    if component is None:
        return
    try:
        component.close(True)
        return
    except Exception:
        pass
    try:
        component.dispose()
    except Exception:
        pass


def shutdown_office(process, desktop):
    if desktop is not None:
        try:
            desktop.terminate()
        except Exception:
            pass
    if process is None:
        return
    try:
        process.wait(timeout=5)
        return
    except Exception:
        pass
    try:
        process.terminate()
    except Exception:
        pass


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


def verify_saved_document(desktop, output, kind, spec):
    if output.suffix.lower() == ".pdf":
        return {"kind": kind, "pdf": True}
    reopened = desktop.loadComponentFromURL(output.as_uri(), "_blank", 0, (property_value("Hidden", True), property_value("ReadOnly", True)))
    if reopened is None:
        raise RuntimeError("LibreOffice could not reopen the exported document")
    try:
        if kind == "impress":
            expected = len(spec.get("blocks") or [])
            actual = reopened.DrawPages.Count
            if actual != expected:
                raise RuntimeError(f"Exported presentation page count mismatch: expected {expected}, got {actual}")
            empty = [index + 1 for index in range(actual) if reopened.DrawPages.getByIndex(index).Count == 0 and (spec["blocks"][index].get("children") or [])]
            if empty:
                raise RuntimeError(f"Exported presentation contains unexpectedly empty slides: {empty}")
            return {"kind": kind, "pages": actual}
        if kind == "calc":
            expected = [sheet_name(block.get("name") or block.get("title"), index, set()) for index, block in enumerate(spec.get("blocks") or [])]
            actual = list(reopened.Sheets.getElementNames())
            if len(actual) != len(expected):
                raise RuntimeError(f"Exported spreadsheet sheet count mismatch: expected {len(expected)}, got {len(actual)}")
            return {"kind": kind, "sheets": actual}
        text = str(reopened.Text.String or "")
        draw_count = reopened.DrawPage.Count if hasattr(reopened, "DrawPage") else 0
        if not text.strip() and not draw_count:
            raise RuntimeError("Exported Writer document has no text or drawing objects")
        return {"kind": kind, "textCharacters": len(text), "drawObjects": draw_count}
    finally:
        close_component(reopened)


def main():
    global GRAPHIC_PROVIDER
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
    spec["blocks"] = [normalized_block(block) for block in spec.get("blocks") or []]
    extension = output_path.suffix.lower()
    if extension not in FILTERS and extension != ".pdf":
        raise ValueError(f"Unsupported LibreOffice output extension: {extension}")
    requested_type = spec.get("documentType")
    if extension in FILTERS:
        requested_type = {"writer": "word", "calc": "spreadsheet", "impress": "presentation"}[FILTERS[extension][0]]
    if requested_type not in ("word", "spreadsheet", "presentation"):
        raise ValueError("documentType must be word, spreadsheet, or presentation")
    soffice_path = Path(args.soffice).resolve()
    process, desktop, GRAPHIC_PROVIDER = connect_office(soffice_path, profile_path)
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
        verification = None
        if extension != ".pdf":
            close_component(document)
            document = None
            # Some LibreOffice builds dispose the URP bridge when the last
            # generation document closes. Verify the exported file through an
            # independent process instead of reusing that potentially dead bridge.
            shutdown_office(process, desktop)
            process, desktop = None, None
            verification_profile = profile_path.parent / f"{profile_path.name}-verification"
            verification_profile.mkdir(parents=True, exist_ok=True)
            process, desktop, GRAPHIC_PROVIDER = connect_office(soffice_path, verification_profile)
            verification = verify_saved_document(desktop, output_path, kind, spec)
        print(json.dumps({
            "bytes": output_path.stat().st_size,
            "kind": kind,
            "output": str(output_path),
            "verification": verification,
            "diagnostics": DIAGNOSTICS,
        }, ensure_ascii=False))
    finally:
        close_component(document)
        shutdown_office(process, desktop)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        raise
