from __future__ import annotations

# Runtime asset distributed with @webpilot/capability-file.
import argparse
import ast
import base64
import builtins
import contextlib
import hashlib
import inspect
import io
import json
import math
import re
import shutil
import subprocess
import sys
import threading
import time
import unicodedata
import uuid
import zipfile
import posixpath
import xml.etree.ElementTree as ET
from html import unescape
from dataclasses import dataclass, field
from pathlib import Path

import uno

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, 'reconfigure'):
        _stream.reconfigure(encoding='utf-8', errors='replace')


FILTERS = {
    '.doc': ('word', 'MS Word 97'), '.docx': ('word', 'Office Open XML Text'), '.odt': ('word', 'writer8'),
    '.xls': ('spreadsheet', 'MS Excel 97'), '.xlsx': ('spreadsheet', 'Calc MS Excel 2007 XML'), '.ods': ('spreadsheet', 'calc8'),
    '.ppt': ('presentation', 'MS PowerPoint 97'), '.pptx': ('presentation', 'Impress MS PowerPoint 2007 XML'), '.odp': ('presentation', 'impress8'),
}
PDF_FILTERS = {'word': 'writer_pdf_Export', 'spreadsheet': 'calc_pdf_Export', 'presentation': 'impress_pdf_Export'}


def property_value(name, value):
    item = uno.createUnoStruct('com.sun.star.beans.PropertyValue')
    item.Name, item.Value = name, value
    return item


def point(x, y):
    value = uno.createUnoStruct('com.sun.star.awt.Point')
    value.X, value.Y = int(x), int(y)
    return value


def size(width, height):
    value = uno.createUnoStruct('com.sun.star.awt.Size')
    value.Width, value.Height = int(width), int(height)
    return value


POINT_TO_100TH_MM = 2540.0 / 72.0

_CJK_FONT = 'Noto Sans CJK SC'
_CJK_FONT_PATTERN = re.compile(r'cjk|source han|noto (?:sans|serif) (?:sc|tc)|yahei|simsun|simhei|dengxian|fangsong|kaiti|pingfang|heiti|songti|wenkai|[\u3400-\u9fff]', re.I)


def configure_cjk_font(job):
    """Resolve a real CJK family once per worker, from the renderer's inventory."""
    global _CJK_FONT
    try:
        toolkit = job.context.ServiceManager.createInstanceWithContext('com.sun.star.awt.Toolkit', job.context)
        device = toolkit.createScreenCompatibleDevice(1, 1)
        families = {str(font.Name).casefold(): str(font.Name) for font in device.getFontDescriptors()}
        for name in ('Microsoft YaHei', 'Microsoft YaHei UI', 'Noto Sans CJK SC', 'Source Han Sans SC',
                     'Noto Sans SC', 'PingFang SC', 'WenQuanYi Micro Hei', 'SimSun'):
            if name.casefold() in families:
                _CJK_FONT = families[name.casefold()]
                return
        job.runtime_diagnostics.append({'code': 'CJK_FONT_UNAVAILABLE', 'severity': 'warning',
                                        'message': 'No preferred CJK font is installed; Chinese layout may use font substitution.'})
    except Exception:
        job.runtime_diagnostics.append({'code': 'CJK_FONT_INVENTORY_UNAVAILABLE', 'severity': 'warning',
                                        'message': 'The renderer font inventory is unavailable; verify Chinese font substitution.'})


def apply_text_font(target, font_name=None, font_size=None, bold=None, italic=None):
    """UNO stores Latin, Asian and complex-script typography separately."""
    properties = {}
    if font_name:
        properties['CharFontName'] = str(font_name)
        properties['CharFontNameAsian'] = str(font_name) if _CJK_FONT_PATTERN.search(str(font_name)) else _CJK_FONT
        properties['CharFontNameComplex'] = str(font_name)
    for name, value in (
        ('CharHeight', float(font_size) if font_size is not None else None),
        ('CharWeight', (150.0 if bold else 100.0) if bold is not None else None),
        ('CharPosture', uno.Enum('com.sun.star.awt.FontSlant', 'ITALIC' if italic else 'NONE') if italic is not None else None),
    ):
        if value is not None:
            for suffix in ('', 'Asian', 'Complex'):
                properties[name + suffix] = value
    # Optional script properties differ across legacy chart implementations.
    info = target.getPropertySetInfo()
    if info is None:
        return
    for name, value in properties.items():
        if info.hasPropertyByName(name):
            setattr(target, name, value)


def office_color(value, name='color'):
    """Normalize the color spellings models commonly use at the facade edge."""
    if isinstance(value, bool):
        raise ValueError(f'{name} must be an RGB integer or a 6-digit hex string.')
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        color = int(value)
    elif isinstance(value, str):
        text = value.strip()
        if text.startswith('#'):
            text = text[1:]
        elif text.lower().startswith('0x'):
            text = text[2:]
        if not re.fullmatch(r'[0-9A-Fa-f]{6}', text):
            raise ValueError(
                f'{name}={value!r} is invalid; use 0xRRGGBB, "#RRGGBB", or "0xRRGGBB".'
            )
        color = int(text, 16)
    else:
        raise ValueError(f'{name} must be an RGB integer or a 6-digit hex string.')
    if color < 0 or color > 0xFFFFFF:
        raise ValueError(f'{name} must stay within 0x000000-0xFFFFFF.')
    return color


def presentation_text_units(value):
    """Return conservative em-widths for mixed CJK/Latin presentation text."""
    lines = str(value or '').replace('\r\n', '\n').replace('\r', '\n').split('\n')
    measured = []
    for line in lines:
        units = 0.0
        for character in line:
            if character == '\t':
                units += 2.0
            elif character.isspace():
                units += 0.33
            elif unicodedata.east_asian_width(character) in {'W', 'F'}:
                units += 1.0
            elif unicodedata.category(character).startswith('P'):
                units += 0.48
            elif character.isupper() or character.isdigit():
                units += 0.62
            else:
                units += 0.55
        measured.append(units)
    return measured or [0.0]


def presentation_text_line_count(value, width, font_size, padding=0):
    """Estimate wrapped lines using explicit 1/100 mm geometry and pt text."""
    usable_width = max(1.0, float(width) - 2.0 * max(0.0, float(padding)))
    em_width = max(1.0, float(font_size) * POINT_TO_100TH_MM)
    units_per_line = max(0.5, usable_width / em_width)
    return max(1, sum(max(1, int(math.ceil(units / units_per_line))) for units in presentation_text_units(value)))


def presentation_text_height(font_size, lines=1, padding=0, line_spacing=1.15):
    """Return a PowerPoint-calibrated TextShape height in 1/100 mm.

    A single line needs its glyph box plus a small leading allowance, not a
    complete 1.22 line-spacing interval. Treating it as 1.22 made ordinary
    16pt/0.4in and 78pt/1.4in PptxGenJS-style boxes fail before rendering.
    Additional wrapped lines use the requested line-spacing multiplier.
    """
    line_count = max(1, int(lines))
    point_height = max(1.0, float(font_size)) * POINT_TO_100TH_MM
    leading = 1.05 + (line_count - 1) * max(1.0, float(line_spacing))
    return int(math.ceil(point_height * leading + 2.0 * max(0.0, float(padding))))


def source_image_dimensions(path: Path):
    """Read intrinsic pixel/vector dimensions without trusting UNO lazy metadata."""
    data = path.read_bytes()
    if data.startswith(b'\x89PNG\r\n\x1a\n') and len(data) >= 24:
        return int.from_bytes(data[16:20], 'big'), int.from_bytes(data[20:24], 'big')
    if data[:2] == b'\xff\xd8':
        position = 2
        sof_markers = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
        while position + 4 <= len(data):
            while position < len(data) and data[position] != 0xFF:
                position += 1
            while position < len(data) and data[position] == 0xFF:
                position += 1
            if position >= len(data):
                break
            marker = data[position]
            position += 1
            if marker in {0x01, 0xD8, 0xD9}:
                continue
            if position + 2 > len(data):
                break
            length = int.from_bytes(data[position:position + 2], 'big')
            if length < 2 or position + length > len(data):
                break
            segment = data[position + 2:position + length]
            if marker in sof_markers and len(segment) >= 5:
                return int.from_bytes(segment[3:5], 'big'), int.from_bytes(segment[1:3], 'big')
            position += length
    if data[:6] in {b'GIF87a', b'GIF89a'} and len(data) >= 10:
        return int.from_bytes(data[6:8], 'little'), int.from_bytes(data[8:10], 'little')
    if path.suffix.lower() == '.svg' or b'<svg' in data[:1024].lower():
        head = data[:16384].decode('utf-8', errors='ignore')
        tag_match = re.search(r'<svg\b[^>]*>', head, flags=re.IGNORECASE | re.DOTALL)
        tag = tag_match.group(0) if tag_match else head
        width_match = re.search(r'\bwidth\s*=\s*["\']\s*([0-9.]+)', tag, flags=re.IGNORECASE)
        height_match = re.search(r'\bheight\s*=\s*["\']\s*([0-9.]+)', tag, flags=re.IGNORECASE)
        if width_match and height_match:
            return float(width_match.group(1)), float(height_match.group(1))
        view_box = re.search(
            r'\bviewBox\s*=\s*["\']\s*[-0-9.]+[ ,]+[-0-9.]+[ ,]+([0-9.]+)[ ,]+([0-9.]+)',
            tag,
            flags=re.IGNORECASE,
        )
        if view_box:
            return float(view_box.group(1)), float(view_box.group(2))
    return None


def save_document(document, job):
    suffix = job.output_path.suffix.lower()
    filters = {
        '.doc': 'MS Word 97', '.docx': 'Office Open XML Text', '.odt': 'writer8',
        '.xls': 'MS Excel 97', '.xlsx': 'Calc MS Excel 2007 XML', '.ods': 'calc8',
        '.ppt': 'MS PowerPoint 97', '.pptx': 'Impress MS PowerPoint 2007 XML', '.odp': 'impress8',
        '.pdf': PDF_FILTERS[job.document_type],
    }
    if suffix not in filters:
        raise ValueError(f'Unsupported output extension: {suffix}')
    properties = (job.property('FilterName', filters[suffix]), job.property('Overwrite', True))
    output = job.output_path.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    last_error = None
    # storeAsURL mutates the component URL and intermittently aborts with
    # 0x11b/Code 27 on Windows, even for a brand-new temp directory. Export a
    # copy to a normal (non-dot-prefixed) candidate instead, then publish it by
    # atomic rename. Each retry gets its own target and exact lock-file cleanup.
    for attempt in range(3):
        candidate = output.with_name(f'wp-save-{uuid.uuid4().hex}{suffix}')
        lock_file = candidate.with_name(f'.~lock.{candidate.name}#')
        try:
            candidate.unlink(missing_ok=True)
            lock_file.unlink(missing_ok=True)
            document.storeToURL(candidate.as_uri(), properties)
            if not candidate.is_file() or candidate.stat().st_size < 64:
                raise RuntimeError('LibreOffice export produced no usable candidate file.')
            output.unlink(missing_ok=True)
            candidate.replace(output)
            lock_file.unlink(missing_ok=True)
            return
        except Exception as error:
            last_error = error
            candidate.unlink(missing_ok=True)
            lock_file.unlink(missing_ok=True)
            if attempt < 2:
                time.sleep(0.15 * (attempt + 1))
    raise RuntimeError(f'LibreOffice could not save the isolated output after 3 attempts: {last_error}') from last_error


def _excel_column_name(index):
    value = max(1, int(index))
    result = ''
    while value:
        value, remainder = divmod(value - 1, 26)
        result = chr(65 + remainder) + result
    return result


def _patch_xlsx_freeze_panes(job, entries):
    requests = dict(job.ooxml_patches.get('freezePanes') or {})
    if not requests:
        return entries
    workbook = entries.get('xl/workbook.xml', b'').decode('utf-8', errors='replace')
    relationships = entries.get('xl/_rels/workbook.xml.rels', b'').decode('utf-8', errors='replace')
    sheet_targets = {}
    for match in re.finditer(r'<sheet\b[^>]*\bname="([^"]+)"[^>]*\br:id="([^"]+)"[^>]*/?>', workbook):
        name, relation_id = unescape(match.group(1)), match.group(2)
        relation = re.search(
            rf'<Relationship\b[^>]*\bId="{re.escape(relation_id)}"[^>]*\bTarget="([^"]+)"',
            relationships,
        )
        if relation:
            target = relation.group(1).replace('\\', '/').lstrip('/')
            sheet_targets[name] = target if target.startswith('xl/') else f'xl/{target}'
    for sheet_name, request in requests.items():
        target = sheet_targets.get(str(sheet_name))
        if not target or target not in entries:
            raise ValueError(f'Cannot persist freeze panes because worksheet {sheet_name!r} was not found in XLSX relationships.')
        xml = entries[target].decode('utf-8', errors='replace')
        rows = max(0, int(request.get('rows', 0)))
        columns = max(0, int(request.get('columns', 0)))

        def patch_view(match):
            opening, content, closing = match.group(1), match.group(2), match.group(3)
            content = re.sub(r'<pane\b[^>]*/>', '', content, count=1)
            if not rows and not columns:
                return opening + content + closing
            top_left = f'{_excel_column_name(columns + 1)}{rows + 1}'
            active_pane = 'bottomRight' if rows and columns else ('bottomLeft' if rows else 'topRight')
            attributes = []
            if columns:
                attributes.append(f'xSplit="{columns}"')
            if rows:
                attributes.append(f'ySplit="{rows}"')
            attributes.extend((f'topLeftCell="{top_left}"', f'activePane="{active_pane}"', 'state="frozen"'))
            pane = '<pane ' + ' '.join(attributes) + '/>'
            selection = re.search(r'<selection\b[^>]*/>', content)
            if selection:
                current = selection.group(0)
                if re.search(r'\bpane="[^"]*"', current):
                    current = re.sub(r'\bpane="[^"]*"', f'pane="{active_pane}"', current)
                else:
                    current = current[:-2] + f' pane="{active_pane}"/>'
                content = content[:selection.start()] + pane + current + content[selection.end():]
            else:
                content = pane + content
            return opening + content + closing

        xml, count = re.subn(r'(<sheetView\b[^>]*>)(.*?)(</sheetView>)', patch_view, xml, count=1, flags=re.DOTALL)
        if count != 1:
            raise ValueError(f'Cannot persist freeze panes because worksheet {sheet_name!r} has no sheetView.')
        entries[target] = xml.encode('utf-8')
    return entries


def _patch_xlsx_subtotal_formulas(job, entries):
    if not job.ooxml_patches.get('repairSubtotalFormulas'):
        return entries
    for name in list(entries):
        if not re.fullmatch(r'xl/worksheets/sheet\d+\.xml', name, flags=re.IGNORECASE):
            continue
        xml = entries[name].decode('utf-8', errors='replace')
        xml = re.sub(
            r'(<f\b[^>]*>[^<]*\bSUBTOTAL\([^<]*?)#REF!(</f>)',
            r'\1\2', xml, flags=re.IGNORECASE,
        )
        entries[name] = xml.encode('utf-8')
    return entries


def _patch_pptx_native_bullets(job, entries):
    artifact_names = set(job.ooxml_patches.get('nativeBullets') or [])
    if not artifact_names:
        return entries

    def patch_shape(match):
        shape_xml = match.group(0)
        name_match = re.search(r'<p:cNvPr\b[^>]*\bname="([^"]+)"', shape_xml)
        if not name_match or unescape(name_match.group(1)) not in artifact_names:
            return shape_xml

        def patch_paragraph(paragraph_match):
            paragraph = paragraph_match.group(0)
            if '<a:buChar' in paragraph or '<a:buAutoNum' in paragraph:
                return paragraph
            if not re.search(r'<a:t>\s*•\s*', paragraph):
                return paragraph
            paragraph = re.sub(r'(<a:t>)\s*•\s*', r'\1', paragraph, count=1)
            if '<a:pPr' in paragraph:
                paragraph = re.sub(r'(<a:pPr\b[^>]*>)', r'\1<a:buChar char="•"/>', paragraph, count=1)
            else:
                paragraph = paragraph.replace('<a:p>', '<a:p><a:pPr><a:buChar char="•"/></a:pPr>', 1)
            return paragraph

        return re.sub(r'<a:p>.*?</a:p>', patch_paragraph, shape_xml, flags=re.DOTALL)

    for name in list(entries):
        if not re.fullmatch(r'ppt/slides/slide\d+\.xml', name, flags=re.IGNORECASE):
            continue
        xml = entries[name].decode('utf-8', errors='replace')
        xml = re.sub(r'<p:sp>.*?</p:sp>', patch_shape, xml, flags=re.DOTALL)
        entries[name] = xml.encode('utf-8')
    return entries


def _materialize_authored_chart_data(entries, chart_path, xml):
    """Back newly authored literal chart caches with an actual editable workbook.

    Never replace an existing externalData relationship (imported workbook,
    formulas or lineage). This is called only for this job's authored charts.
    """
    c = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
    r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
    s = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    root = ET.fromstring(xml)
    if root.find('{%s}externalData' % c) is not None:
        return xml
    columns = []

    def column_name(number):
        name = ''
        while number:
            number, remainder = divmod(number - 1, 26)
            name = chr(65 + remainder) + name
        return name

    def materialize(match):
        kind, block = match.group(1), match.group(0)
        ref = ET.fromstring('<root xmlns:c="%s">%s</root>' % (c, block))[0]
        cache = ref.find('{%s}%sCache' % (c, 'num' if kind == 'numRef' else 'str'))
        if cache is None:
            raise RuntimeError('Authored chart data has no literal cache; cannot create an editable workbook safely.')
        points = {}
        count_node = cache.find('{%s}ptCount' % c)
        count = int(count_node.get('val', '0')) if count_node is not None else 0
        for pt in cache.findall('{%s}pt' % c):
            idx = int(pt.get('idx'))
            value = pt.findtext('{%s}v' % c, '')
            if idx < 0 or idx >= count or idx in points:
                raise RuntimeError('Authored chart cache has invalid or duplicate point indices.')
            if kind == 'numRef' and not math.isfinite(float(value)):
                raise RuntimeError('Authored chart cache has a non-finite number.')
            points[idx] = value
        if count < 1 or count > 1048575:
            raise RuntimeError('Authored chart cache has an unsupported point count.')
        # UNO pads unequal-length role series to the longest series. Trim only
        # absent trailing slots, never real points or internal missing values.
        effective_count = max(points, default=-1) + 1
        if 0 < effective_count < count:
            count = effective_count
            block = re.sub(r'<c:ptCount\b[^>]*/>', '<c:ptCount val="%s"/>' % count, block, count=1)
        columns.append((kind, count, points))
        col = column_name(len(columns))
        formula = 'Data!$%s$2:$%s$%s' % (col, col, count + 1)
        if count == 1:
            formula = 'Data!$%s$2' % col
        block, changed = re.subn(r'<c:f>.*?</c:f>', '<c:f>' + formula + '</c:f>', block, count=1, flags=re.DOTALL)
        if changed != 1:
            raise RuntimeError('Authored chart reference has no formula to bind to its workbook.')
        return block

    xml = re.sub(r'<c:(numRef|strRef)\b[^>]*>.*?</c:\1>', materialize, xml, flags=re.DOTALL)
    expected = sum(1 for item in root.iter() if item.tag in {'{%s}numRef' % c, '{%s}strRef' % c})
    if not columns or len(columns) != expected or len(columns) > 16384:
        raise RuntimeError('Authored chart data references could not all be materialized.')
    worksheet = ET.Element('worksheet', xmlns=s)
    sheet_data = ET.SubElement(worksheet, 'sheetData')
    rows = {}
    for column_index, (kind, count, points) in enumerate(columns, 1):
        col = column_name(column_index)
        for row_number, value in [(1, 'Source %s' % column_index)] + [(idx + 2, value) for idx, value in sorted(points.items())]:
            rows.setdefault(row_number, []).append((col, value, row_number == 1 or kind == 'strRef'))
    for number, values in sorted(rows.items()):
        row = ET.SubElement(sheet_data, 'row', r=str(number))
        for col, value, is_text in values:
            cell = ET.SubElement(row, 'c', r=col + str(number), t='inlineStr' if is_text else 'n')
            if is_text:
                ET.SubElement(ET.SubElement(cell, 'is'), 't', {'xml:space': 'preserve'}).text = value
            else:
                ET.SubElement(cell, 'v').text = value
    buffer = io.BytesIO()
    ct = 'http://schemas.openxmlformats.org/package/2006/content-types'
    rel_ns = 'http://schemas.openxmlformats.org/package/2006/relationships'
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED) as workbook:
        workbook.writestr('[Content_Types].xml', '<Types xmlns="%s"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>' % ct)
        workbook.writestr('_rels/.rels', '<Relationships xmlns="%s"><Relationship Id="rId1" Type="%s/officeDocument" Target="xl/workbook.xml"/></Relationships>' % (rel_ns, r))
        workbook.writestr('xl/workbook.xml', '<workbook xmlns="%s" xmlns:r="%s"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>' % (s, r))
        workbook.writestr('xl/_rels/workbook.xml.rels', '<Relationships xmlns="%s"><Relationship Id="rId1" Type="%s/worksheet" Target="worksheets/sheet1.xml"/></Relationships>' % (rel_ns, r))
        workbook.writestr('xl/worksheets/sheet1.xml', ET.tostring(worksheet, encoding='utf-8', xml_declaration=True))
    basename = 'webpilot-' + posixpath.basename(chart_path).replace('.xml', '.xlsx')
    workbook_path = 'ppt/embeddings/' + basename
    if workbook_path in entries:
        raise RuntimeError('Authored chart workbook would overwrite an existing embedded asset.')
    entries[workbook_path] = buffer.getvalue()
    rel_path = posixpath.join(posixpath.dirname(chart_path), '_rels', posixpath.basename(chart_path) + '.rels')
    rel_xml = entries[rel_path].decode('utf-8') if rel_path in entries else '<Relationships xmlns="%s"></Relationships>' % rel_ns
    ids = {item.get('Id') for item in ET.fromstring(rel_xml)}
    rel_id = 'rIdWebpilotData'
    while rel_id in ids:
        rel_id += '_'
    # Preserve OPC's default-namespace spelling: some LibreOffice package
    # readers reject an otherwise equivalent ns0-prefixed Types/Relationships.
    relationship = '<Relationship Id="%s" Type="%s/package" Target="../embeddings/%s"/>' % (rel_id, r, basename)
    if rel_xml.count('</Relationships>') != 1:
        raise RuntimeError('Cannot safely extend the authored chart relationship part.')
    entries[rel_path] = rel_xml.replace('</Relationships>', relationship + '</Relationships>').encode('utf-8')
    types_xml = entries['[Content_Types].xml'].decode('utf-8')
    override = '<Override PartName="/%s" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>' % workbook_path
    if types_xml.count('</Types>') != 1:
        raise RuntimeError('Cannot safely extend the Office package content types.')
    entries['[Content_Types].xml'] = types_xml.replace('</Types>', override + '</Types>').encode('utf-8')
    external = '<c:externalData r:id="%s"><c:autoUpdate val="0"/></c:externalData>' % rel_id
    # CT_ChartSpace externalData follows txPr and precedes printSettings/userShapes/extLst.
    before = re.search(r'<c:(?:printSettings|userShapes|extLst)\b', xml[xml.index('</c:chart>') + len('</c:chart>'):])
    offset = xml.index('</c:chart>') + len('</c:chart>')
    at = offset + before.start() if before else xml.rfind('</c:chartSpace>')
    return xml[:at] + external + xml[at:]


def _patch_pptx_chart_style(job, entries):
    """Persist authored chart intent where Office clients disagree on omitted defaults.

    Resolve shape names through slide relationships; never rewrite imported charts
    merely because they happen to have the same chart type or package index.
    """
    requests = job.ooxml_patches.get('nativeChartStyle') or {}
    if not requests:
        return entries
    ns = {'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
          'c': 'http://schemas.openxmlformats.org/drawingml/2006/chart',
          'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
    for slide_path in list(entries):
        if not re.fullmatch(r'ppt/slides/slide\d+\.xml', slide_path):
            continue
        root = ET.fromstring(entries[slide_path])
        rel_path = posixpath.join(posixpath.dirname(slide_path), '_rels', posixpath.basename(slide_path) + '.rels')
        if rel_path not in entries:
            continue
        relations = {item.get('Id'): item.get('Target') for item in ET.fromstring(entries[rel_path])
                     if item.get('TargetMode') != 'External'}
        for frame in root.findall('.//p:graphicFrame', ns):
            name = frame.find('.//p:cNvPr', ns)
            chart = frame.find('.//c:chart', ns)
            request = requests.get(name.get('name')) if name is not None else None
            if request is None or chart is None:
                continue
            target = relations.get(chart.get('{%s}id' % ns['r']))
            if not target:
                raise RuntimeError('Authored chart has no exported relationship.')
            chart_path = posixpath.normpath(posixpath.join(posixpath.dirname(slide_path), target)) if not target.startswith('/') else target.lstrip('/')
            if not chart_path.startswith('ppt/charts/') or chart_path not in entries:
                raise RuntimeError('Authored chart relationship did not resolve to a PPTX chart part.')
            xml = entries[chart_path].decode('utf-8')
            if request['kind'] == 'bubble':
                def labels(match):
                    block = re.sub(r'<c:showBubbleSize\b[^>]*/>', '', match.group(0))
                    value = '1' if request['showValues'] else '0'
                    # showBubbleSize has its own OOXML default, independent of showVal.
                    block = re.sub(r'(<c:showPercent\b[^>]*/>)', r'\1<c:showBubbleSize val="' + value + '"/>', block, count=1)
                    return block
                xml = re.sub(r'<c:dLbls\b[^>]*>.*?</c:dLbls>', labels, xml, flags=re.DOTALL)
            if request['kind'] == 'stock':
                def stock_series(match):
                    block = re.sub(r'<c:marker\b[^>]*>.*?</c:marker>', '', match.group(0), flags=re.DOTALL)
                    # CT_LineSer marker follows spPr and precedes dPt/dLbls/data.
                    marker = '<c:marker><c:symbol val="none"/></c:marker>'
                    if '</c:spPr>' in block:
                        block = block.replace('</c:spPr>', '</c:spPr>' + marker, 1)
                    else:
                        block = re.sub(r'(<c:order\b[^>]*/>)', r'\1' + marker, block, count=1)
                    return block
                xml = re.sub(r'<c:ser\b[^>]*>.*?</c:ser>', stock_series, xml, flags=re.DOTALL)
            entries[chart_path] = _materialize_authored_chart_data(entries, chart_path, xml).encode('utf-8')
    return entries


def _patch_pptx_slide_order(job, entries):
    order = list(job.ooxml_patches.get('slideOrder') or [])
    if not order:
        return entries
    name = 'ppt/presentation.xml'
    xml = entries.get(name, b'').decode('utf-8', errors='replace')

    def replace_list(match):
        items = re.findall(r'<p:sldId\b[^>]*/>', match.group(2))
        if len(items) != len(order) or sorted(order) != list(range(1, len(items) + 1)):
            raise ValueError(
                f'Cannot persist slide order: package has {len(items)} slides but logical order is {order!r}.'
            )
        reordered = ''.join(items[index - 1] for index in order)
        return match.group(1) + reordered + match.group(3)

    xml, count = re.subn(
        r'(<p:sldIdLst>)(.*?)(</p:sldIdLst>)', replace_list, xml,
        count=1, flags=re.DOTALL,
    )
    if count != 1:
        raise ValueError('Cannot persist slide order because ppt/presentation.xml has no p:sldIdLst.')
    entries[name] = xml.encode('utf-8')
    return entries


def _pptx_animation_target_id(xml, artifact_name):
    for match in re.finditer(r'<p:cNvPr\b[^>]*>', xml):
        tag = match.group(0)
        name = re.search(r'\bname="([^"]*)"', tag)
        shape_id = re.search(r'\bid="(\d+)"', tag)
        if name and shape_id and unescape(name.group(1)) == artifact_name:
            return int(shape_id.group(1))
    return None


def _pptx_animation_node(shape_id, request, base_id):
    speed = str(request.get('speed') or 'medium').strip().lower()
    duration = {'slow': 1000, 'medium': 500, 'fast': 300}.get(speed, 500)
    effect = str(request.get('effect') or 'appear').strip().lower()
    preset_id = {'appear': 1, 'fade': 10}.get(effect, 2)
    preset_subtype = {
        'fly-left': 8, 'fly-right': 2, 'fly-up': 1, 'fly-down': 4,
    }.get(effect, 0)
    behavior = (
        f'<p:cBhvr><p:cTn id="{base_id + 3}" dur="{duration}" fill="hold"/>'
        f'<p:tgtEl><p:spTgt spid="{shape_id}"/></p:tgtEl>'
        '<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst>'
        '</p:cBhvr>'
    )
    if effect == 'fade':
        action = f'<p:animEffect transition="in" filter="fade">{behavior}</p:animEffect>'
    elif effect.startswith('fly-'):
        starts = {
            'fly-left': '-1 0', 'fly-right': '1 0',
            'fly-up': '0 -1', 'fly-down': '0 1',
        }
        action = (
            f'<p:animMotion origin="layout" path="M {starts[effect]} L 0 0 E">'
            f'{behavior}</p:animMotion>'
        )
    else:
        action = f'<p:set>{behavior}<p:to><p:strVal val="visible"/></p:to></p:set>'
    return (
        f'<p:par><p:cTn id="{base_id}" presetID="{preset_id}" presetClass="entr" '
        f'presetSubtype="{preset_subtype}" fill="hold" nodeType="clickEffect">'
        '<p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>'
        f'{action}</p:childTnLst></p:cTn></p:par>'
    )


def _patch_pptx_shape_animations(job, entries):
    requests = list(job.ooxml_patches.get('shapeAnimations') or [])
    if not requests:
        return entries
    slide_xml = {
        name: value.decode('utf-8', errors='replace')
        for name, value in entries.items()
        if re.fullmatch(r'ppt/slides/slide\d+\.xml', name)
    }
    by_slide = {}
    for request in requests:
        marker = str(request.get('artifactName') or '')
        preferred = f'ppt/slides/slide{int(request.get("slide") or 0)}.xml'
        matches = [
            name for name, xml in slide_xml.items()
            if _pptx_animation_target_id(xml, marker) is not None
        ]
        if preferred in matches:
            target = preferred
        elif len(matches) == 1:
            # Slide duplication and logical reordering change the physical
            # slideN.xml number after animation registration. Resolve by the
            # stable exported shape marker instead of trusting a stale index.
            target = matches[0]
        else:
            raise ValueError(
                f'Cannot persist shape animation because marker {marker!r} '
                f'matched {len(matches)} physical slide parts.'
            )
        by_slide.setdefault(target, []).append(request)
    for name, slide_requests in by_slide.items():
        xml = slide_xml[name]
        # If LibreOffice serialized native timing, retain its complete timing
        # graph. Some releases accept the legacy Effect property but silently
        # omit the graph; synthesize the equivalent entrance sequence only in
        # that case.
        if '<p:timing' in xml:
            continue
        nodes = []
        next_id = 5
        for request in slide_requests:
            shape_id = _pptx_animation_target_id(xml, str(request.get('artifactName') or ''))
            if shape_id is None:
                raise ValueError(
                    f'Cannot persist shape animation because marker {request.get("artifactName")!r} '
                    f'was not found in {name}.'
                )
            nodes.append(_pptx_animation_node(shape_id, request, next_id))
            next_id += 5
        timing = (
            '<p:timing><p:tnLst><p:par>'
            '<p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>'
            '<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq">'
            '<p:childTnLst><p:par><p:cTn id="3" fill="hold">'
            '<p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst>'
            '<p:par><p:cTn id="4" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst>'
            f'<p:childTnLst>{"".join(nodes)}</p:childTnLst></p:cTn></p:par>'
            '</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn>'
            '<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>'
            '<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst>'
            '</p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>'
        )
        xml, count = re.subn(r'</p:sld>\s*$', timing + '</p:sld>', xml, count=1)
        if count != 1:
            raise ValueError(f'Cannot persist shape animation because {name} has no p:sld root.')
        entries[name] = xml.encode('utf-8')
    return entries


def _patch_docx_protection(job, entries):
    request = job.ooxml_patches.get('writerProtection')
    if not request:
        return entries
    name = 'word/settings.xml'
    xml = entries.get(name, b'').decode('utf-8', errors='replace')
    if not xml:
        raise ValueError('Cannot apply Writer protection because DOCX has no word/settings.xml.')
    password = str(request.get('password') or '')
    spin_count = 100000
    salt = hashlib.sha256(f'webpilot-writer:{password}'.encode('utf-8')).digest()[:16]
    digest = hashlib.sha512(salt + password.encode('utf-16le')).digest()
    for index in range(spin_count):
        digest = hashlib.sha512(index.to_bytes(4, 'little') + digest).digest()
    attributes = (
        'w:edit="readOnly" w:enforcement="1" '
        'w:cryptProviderType="rsaAES" w:cryptAlgorithmClass="hash" '
        'w:cryptAlgorithmType="typeAny" w:cryptAlgorithmSid="14" '
        f'w:cryptSpinCount="{spin_count}" '
        f'w:hash="{base64.b64encode(digest).decode("ascii")}" '
        f'w:salt="{base64.b64encode(salt).decode("ascii")}"'
    )
    protection = f'<w:documentProtection {attributes}/>'
    if re.search(r'<w:documentProtection\b[^>]*/>', xml):
        xml = re.sub(r'<w:documentProtection\b[^>]*/>', protection, xml, count=1)
    else:
        xml, count = re.subn(r'(<w:settings\b[^>]*>)', r'\1' + protection, xml, count=1)
        if count != 1:
            raise ValueError('Cannot apply Writer protection because word/settings.xml has no w:settings root.')
    entries[name] = xml.encode('utf-8')
    return entries


def postprocess_ooxml(job):
    """Apply small deterministic fixes for properties LibreOffice drops on export."""
    suffix = job.output_path.suffix.lower()
    if suffix not in {'.xlsx', '.pptx', '.docx'} or not job.ooxml_patches:
        return
    with zipfile.ZipFile(job.output_path, 'r') as source:
        infos = source.infolist()
        entries = {info.filename: source.read(info.filename) for info in infos}
    if suffix == '.xlsx':
        entries = _patch_xlsx_freeze_panes(job, entries)
        entries = _patch_xlsx_subtotal_formulas(job, entries)
    elif suffix == '.pptx':
        entries = _patch_pptx_native_bullets(job, entries)
        entries = _patch_pptx_slide_order(job, entries)
        entries = _patch_pptx_shape_animations(job, entries)
        entries = _patch_pptx_chart_style(job, entries)
    elif suffix == '.docx':
        entries = _patch_docx_protection(job, entries)
    temporary = job.output_path.with_name(f'.{job.output_path.name}.{uuid.uuid4().hex}.tmp')
    try:
        with zipfile.ZipFile(temporary, 'w') as output:
            for info in infos:
                output.writestr(info, entries[info.filename])
            original_names = {info.filename for info in infos}
            for name, content in entries.items():
                if name not in original_names:
                    output.writestr(name, content, compress_type=zipfile.ZIP_DEFLATED)
        temporary.replace(job.output_path)
    finally:
        if temporary.exists():
            temporary.unlink()


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


def connect_office(soffice: Path, profile: Path, existing_pipe=None):
    profile.mkdir(parents=True, exist_ok=True)
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', local)
    last_error = None
    if existing_pipe:
        accept = f'pipe,name={existing_pipe};urp;StarOffice.ComponentContext'
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                context = resolver.resolve(f'uno:{accept}')
                desktop = context.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', context)
                return None, context, desktop
            except Exception as error:
                last_error = error
                time.sleep(.2)
        raise RuntimeError(f'Unable to connect to persistent LibreOffice UNO pipe {existing_pipe!r}: {last_error}')
    for attempt in range(3):
        attempt_profile = profile / f'launch-{attempt + 1}'
        attempt_profile.mkdir(parents=True, exist_ok=True)
        pipe_name = f'webpilot_{uuid.uuid4().hex}'
        accept = f'pipe,name={pipe_name};urp;StarOffice.ComponentContext'
        process = subprocess.Popen([
            str(soffice), '--headless', '--nologo', '--nodefault', '--nofirststartwizard', '--norestore', '--nolockcheck',
            f'-env:UserInstallation={attempt_profile.as_uri()}', f'--accept={accept}',
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                context = resolver.resolve(f'uno:{accept}')
                desktop = context.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop', context)
                return process, context, desktop
            except Exception as error:
                last_error = error
                if process.poll() is not None:
                    break
                time.sleep(.2)
        try:
            process.terminate()
            process.wait(timeout=3)
        except Exception:
            pass
        time.sleep(.5)
    raise RuntimeError(f'Unable to connect to LibreOffice UNO: {last_error}')


def shutdown_office(process, desktop):
    # A None process means this worker borrowed the server-owned persistent
    # LibreOffice host. Never terminate that shared Desktop.
    if process is None:
        return
    if desktop is not None:
        try:
            desktop.terminate()
        except Exception:
            pass
    if process is not None:
        try:
            process.wait(timeout=5)
        except Exception:
            try:
                process.terminate()
            except Exception:
                pass


@dataclass(frozen=True)
class DocumentJob:
    """Actual UNO handles. The model program owns document creation and layout."""
    output_path: Path
    assets_path: Path
    document_type: str
    context: object
    desktop: object
    source_path: Path
    opened_documents: set = field(default_factory=set, compare=False)
    element_records: dict = field(default_factory=dict, compare=False)
    layout_issues: list = field(default_factory=list, compare=False)
    runtime_diagnostics: list = field(default_factory=list, compare=False)
    feature_counts: dict = field(default_factory=dict, compare=False)
    ooxml_patches: dict = field(default_factory=dict, compare=False)

    def __post_init__(self):
        configure_cjk_font(self)

    @property
    def output_url(self):
        return self.output_path.as_uri()

    def asset_path(self, name: str):
        candidate = (self.assets_path / name).resolve()
        if candidate != self.assets_path and self.assets_path not in candidate.parents:
            raise ValueError('Asset paths must stay within job.assets_path')
        if not candidate.is_file():
            assets = self.list_assets()
            requested = Path(str(name)).name.lower()
            exact_case_insensitive = [item for item in assets if item['name'].lower() == requested]
            suffix_matches = [
                item for item in assets
                if Path(item['name']).suffix.lower() == Path(requested).suffix.lower()
                and Path(item['name']).stem.lower().endswith(Path(requested).stem.lower())
            ]
            matches = exact_case_insensitive or suffix_matches
            if len(matches) == 1:
                return (self.assets_path / matches[0]['name']).resolve()
            available = ', '.join(item['name'] for item in assets) or '(none)'
            raise FileNotFoundError(f'Asset {name!r} is not in this conversation workspace. Available assets: {available}')
        return candidate

    def list_assets(self):
        """Return the complete read-only conversation asset workspace."""
        try:
            return [
                {'name': item.name, 'bytes': item.stat().st_size}
                for item in sorted(self.assets_path.iterdir(), key=lambda entry: entry.name.lower())
                if item.is_file() and not item.name.startswith('.')
            ]
        except FileNotFoundError:
            return []

    def document_bounds(self, component):
        """Read the current document's native usable geometry (1/100 mm)."""
        if component.supportsService('com.sun.star.presentation.PresentationDocument'):
            page = component.DrawPages.getByIndex(0)
            return {'kind': 'presentation', 'width': int(page.Width), 'height': int(page.Height)}
        if component.supportsService('com.sun.star.text.TextDocument'):
            styles = component.StyleFamilies.getByName('PageStyles')
            style = styles.getByName(styles.getElementNames()[0])
            width, height = int(style.Width), int(style.Height)
            left, right = int(style.LeftMargin), int(style.RightMargin)
            top, bottom = int(style.TopMargin), int(style.BottomMargin)
            return {
                'kind': 'word', 'pageWidth': width, 'pageHeight': height,
                'leftMargin': left, 'rightMargin': right, 'topMargin': top, 'bottomMargin': bottom,
                'contentWidth': width - left - right, 'contentHeight': height - top - bottom,
            }
        return {'kind': 'spreadsheet', 'unit': '1/100 mm'}

    def property(self, name, value):
        return property_value(name, value)

    def _new_document(self, kind=None):
        aliases = {
            'word': 'word', 'writer': 'word', 'swriter': 'word',
            'spreadsheet': 'spreadsheet', 'calc': 'spreadsheet', 'scalc': 'spreadsheet',
            'presentation': 'presentation', 'impress': 'presentation', 'simpress': 'presentation',
        }
        kind = aliases.get(str(kind or self.document_type).strip().lower())
        factories = {'word': 'private:factory/swriter', 'spreadsheet': 'private:factory/scalc', 'presentation': 'private:factory/simpress'}
        if kind not in factories:
            raise ValueError(f'Unsupported document type: {kind}')
        component = self.desktop.loadComponentFromURL(factories[kind], '_blank', 0, (self.property('Hidden', True),))
        if component is None:
            raise RuntimeError(f'UNO_WORKER_INTERNAL_ERROR: LibreOffice returned no component for {kind}; source validation did not complete.')
        # New documents get explicit CJK defaults; imported document styles are
        # never globally rewritten by opening them for a local edit.
        if kind in {'word', 'spreadsheet'}:
            family = component.StyleFamilies.getByName('ParagraphStyles' if kind == 'word' else 'CellStyles')
            standard = family.getByName('Standard' if kind == 'word' else 'Default')
            apply_text_font(standard, font_name=_CJK_FONT, font_size=11)
        # Built-in headings and slide styles can override the Standard style's
        # Asian font. Normalize only the CJK family, preserving Latin design.
        for family_name in component.StyleFamilies.getElementNames():
            if kind == 'word' and family_name != 'ParagraphStyles':
                continue
            if kind == 'spreadsheet' and family_name != 'CellStyles':
                continue
            family = component.StyleFamilies.getByName(family_name)
            for style_name in family.getElementNames():
                target = family.getByName(style_name)
                # Impress table templates are style containers, not text
                # styles; their property-set metadata can be None.
                info = target.getPropertySetInfo()
                if info is not None and info.hasPropertyByName('CharFontNameAsian'):
                    target.CharFontNameAsian = _CJK_FONT
        return component

    def new_document(self, kind=None):
        raise RuntimeError("Direct job.new_document() is worker-owned. Use job.writer(), job.presentation(), or job.spreadsheet().")

    def _open_document(self, name: str):
        """Open an existing workspace Office file for in-place editing."""
        source = self.asset_path(name)
        component = self.desktop.loadComponentFromURL(
            source.as_uri(), '_blank', 0,
            (self.property('Hidden', True), self.property('ReadOnly', False)),
        )
        if component is None:
            raise RuntimeError(f'LibreOffice could not open source asset {name!r}')
        if not component.supportsService(expected_service(self.document_type)):
            close_component(component)
            raise ValueError(f'Source asset {name!r} is not a {self.document_type} document')
        self.opened_documents.add(name)
        return component

    def open_document(self, name: str):
        raise RuntimeError("Direct job.open_document() is worker-owned. Pass source_name to the matching high-level facade.")

    def close(self, component):
        close_component(component)
        if self.output_path.exists():
            postprocess_ooxml(self)

    def _source_location(self):
        expected = str(self.source_path.resolve())
        matches = []
        for frame in inspect.stack():
            try:
                if str(Path(frame.filename).resolve()) == expected:
                    matches.append({'line': int(frame.lineno), 'column': 1})
            except Exception:
                continue
        if not matches:
            return {}
        # inspect.stack() is ordered from the innermost frame outwards. The
        # first authored frame is the real facade call inside a reusable
        # helper; that is the line whose geometry or text policy must change.
        # Preserve the outer call separately for dependency context without
        # mislabeling it as the failing add_* statement.
        location = dict(matches[0])
        if matches[-1]['line'] != matches[0]['line']:
            location['callLine'] = matches[-1]['line']
            location['callColumn'] = matches[-1]['column']
        return location

    def register_element(self, element_id, kind, target=None, locator=None, force_artifact_name=False,
                         update_existing=False):
        requested_value = str(element_id or '').strip()
        if (not requested_value or len(requested_value) > 128
                or re.search(r'[\x00-\x20\x7f]', requested_value)):
            raise ValueError(
                'elementId must contain 1-128 non-whitespace characters. Unicode names, including Chinese, are supported.'
            )

        source_location = self._source_location()
        previous = self.element_records.get(requested_value)
        # Setters may legitimately change the same Calc target more than once.
        # Compare target coordinates, not mutable dimensions; real collisions
        # (different kind/target, or object creation) still get a unique ID.
        mutable_keys = {'row-height': {'height'}, 'column-width': {'width'}}.get(kind, set())
        def target_identity(value):
            return {key: item for key, item in (value or {}).items() if key not in mutable_keys}
        if (update_existing and previous and locator
                and previous['kind'] == kind
                and target_identity(previous.get('locator')) == target_identity(locator)):
            for key in ('line', 'column', 'callLine', 'callColumn'):
                previous.pop(key, None)
            previous.update({**source_location, 'locator': dict(locator)})
            return previous

        value = requested_value
        duplicate_index = 1
        while value in self.element_records:
            duplicate_index += 1
            suffix = f'-{duplicate_index}'
            value = f'{requested_value[:128 - len(suffix)]}{suffix}'

        if value != requested_value:
            first = self.element_records[requested_value]
            self.runtime_diagnostics.append({
                'code': 'ELEMENT_ID_AUTO_DISAMBIGUATED',
                'severity': 'warning',
                'message': (
                    f'Duplicate requested elementId {requested_value!r} was registered as {value!r}. '
                    'The artifact remains valid, but reusable helpers should derive role-specific IDs from a caller prefix.'
                ),
                'requestedElementId': requested_value,
                'elementId': value,
                'firstLine': first.get('line'),
                **source_location,
            })

        artifact_base = 'wp_' + re.sub(r'[^A-Za-z0-9_]', '_', value)
        artifact_name = artifact_base
        used_artifact_names = {record.get('artifactName') for record in self.element_records.values()}
        artifact_index = 1
        while artifact_name in used_artifact_names:
            artifact_index += 1
            artifact_name = f'{artifact_base}_{artifact_index}'
        record = {
            'elementId': value, 'artifactName': artifact_name, 'kind': str(kind),
            **source_location, 'locator': dict(locator or {}),
            **({'requestedElementId': requested_value, 'duplicateIndex': duplicate_index} if value != requested_value else {}),
        }
        self.element_records[value] = record
        if target is not None:
            for property_name in ('Name', 'Title'):
                try:
                    if hasattr(target, property_name) and (force_artifact_name or not str(getattr(target, property_name, '') or '')):
                        setattr(target, property_name, artifact_name)
                        # Default drawing-service names can reappear during
                        # PPTX export. For newly authored shapes, mirror the
                        # stable marker into Title as a second DrawingML path.
                        if not force_artifact_name:
                            break
                except Exception:
                    pass
        return record

    def writer(self, element_id, component=None, source_name=None):
        """Create the default flow-first Writer facade."""
        target = component or (self._open_document(source_name) if source_name else self._new_document('writer'))
        if not target.supportsService('com.sun.star.text.TextDocument'):
            raise ValueError('job.writer() requires a Writer document')
        self.register_element(element_id, 'word-document', target, {'role': 'document'})
        return WriterLayout(self, target)

    def presentation(self, element_id, component=None, source_name=None):
        target = component or (self._open_document(source_name) if source_name else self._new_document('presentation'))
        if not target.supportsService('com.sun.star.presentation.PresentationDocument'):
            raise ValueError('job.presentation() requires an Impress document')
        self.register_element(element_id, 'presentation', target, {'role': 'document'})
        return PresentationLayout(
            self, target,
            normalize_wide=component is None and source_name is None,
        )

    def spreadsheet(self, element_id, component=None, source_name=None):
        target = component or (self._open_document(source_name) if source_name else self._new_document('spreadsheet'))
        if not target.supportsService('com.sun.star.sheet.SpreadsheetDocument'):
            raise ValueError('job.spreadsheet() requires a Calc document')
        self.register_element(element_id, 'workbook', target, {'role': 'document'})
        return SpreadsheetLayout(self, target)

    def expert(self, reason):
        value = str(reason or '').strip()
        if len(value) < 8:
            raise ValueError('Expert mode requires a concrete reason of at least 8 characters')
        return UnoExpertAccess(self, value)

    def element_map(self):
        return list(self.element_records.values())

    def record_feature(self, name, count=1):
        key = str(name or '').strip()
        if not key:
            raise ValueError('Feature name must be non-empty')
        self.feature_counts[key] = int(self.feature_counts.get(key, 0)) + max(0, int(count))


class UnoExpertAccess:
    """Explicit escape hatch for features not modeled by the stable facades."""

    def __init__(self, job, reason):
        self.job, self.reason = job, reason
        self.context, self.desktop, self.uno = job.context, job.desktop, uno

    def new_document(self, kind=None):
        return self.job._new_document(kind)

    def open_document(self, name):
        return self.job._open_document(name)

    def component(self, layout):
        """Return the raw component behind a worker-owned stable facade.

        Keeping this escape hatch on the expert object prevents authored
        programs from guessing private facade attributes such as ``_component``
        or silently receiving ``None`` from ``getattr``.
        """
        component = getattr(layout, '_component', None)
        if component is None:
            raise ValueError(
                'expert.component(layout) requires a facade returned by '
                'job.writer(), job.presentation(), or job.spreadsheet().'
            )
        return component

    def tag(self, target, element_id, kind='expert-element', locator=None,
            layout_role=None, allow_overlap=None):
        """Register a raw UNO object and, for Impress, its layout intent.

        Raw ``shape`` objects follow the stable facade's default and are
        decorative unless the author explicitly marks them as content. This
        prevents a card/background rectangle from being diagnosed as
        colliding with the text it is intentionally behind.
        """
        metadata = dict(locator or {})
        if layout_role is not None:
            role = str(layout_role).strip().lower()
            if role not in {'background', 'container', 'content', 'decoration'}:
                raise ValueError(
                    f'Unknown presentation layout_role {layout_role!r}; '
                    "expected background, container, content, or decoration."
                )
            metadata['layoutRole'] = role
        if allow_overlap is not None:
            metadata['allowOverlap'] = bool(allow_overlap)
        return self.job.register_element(element_id, kind, target, metadata, force_artifact_name=True)


class OfficeUnitConversion:
    """Shared conversion helpers for UNO's 1/100 mm geometry unit."""

    @staticmethod
    def mm(value):
        return int(round(float(value) * 100.0))

    @staticmethod
    def cm(value):
        return int(round(float(value) * 1000.0))

    @staticmethod
    def inch(value):
        return int(round(float(value) * 2540.0))

    @staticmethod
    def pt(value):
        return int(round(float(value) * POINT_TO_100TH_MM))


class WriterLayout(OfficeUnitConversion):
    """Stable flow-layout helpers backed by native UNO Writer objects.

    The facade is the default authoring surface because paragraphs, tables and
    inline media participate in Writer pagination. Advanced features use
    versioned facade recipes rather than model-authored UNO.
    """

    def __init__(self, job, component):
        self.job = job
        self._component = component
        self._paragraph_count = 0
        self._tables = {}

    def _end_cursor(self):
        cursor = self._component.Text.createTextCursor()
        cursor.gotoEnd(False)
        return cursor

    def _paragraph_cursor(self, paragraph_style=None):
        cursor = self._end_cursor()
        # Keep explicit page breaks and inline fields, but do not inherit the
        # preceding heading/list/hyperlink's direct formatting.
        for name in ('CharStyleName', 'CharFontName', 'CharFontNameAsian', 'CharFontNameComplex',
                     'CharHeight', 'CharHeightAsian', 'CharHeightComplex', 'CharWeight',
                     'CharWeightAsian', 'CharWeightComplex', 'CharPosture', 'CharPostureAsian',
                     'CharPostureComplex', 'CharColor', 'CharUnderline', 'HyperLinkURL',
                     'ParaKeepTogether', 'ParaSplit', 'ParaLeftMargin', 'ParaRightMargin',
                     'ParaFirstLineIndent', 'ParaAdjust', 'ParaLineSpacing', 'ParaTopMargin',
                     'ParaBottomMargin', 'ParaBackColor'):
            cursor.setPropertyToDefault(name)
        cursor.ParaStyleName = str(paragraph_style or 'Standard')
        cursor.NumberingStyleName = ''
        cursor.CharHidden = False
        cursor.ParaOrphans, cursor.ParaWidows = 2, 2
        cursor.ParaIsForbiddenRules = True
        return cursor

    def _finish_block(self, cursor):
        cursor.gotoEnd(False)
        self._component.Text.insertControlCharacter(
            cursor, uno.getConstantByName('com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK'), False)
        self._paragraph_cursor()

    def _page_style(self):
        styles = self._component.StyleFamilies.getByName('PageStyles')
        return styles.getByName(styles.getElementNames()[0])

    def _insert_bookmarked_text(self, text, cursor, record, value):
        """Insert text and anchor the exported element marker to a real range.

        LibreOffice drops collapsed/zero-length Writer bookmarks while saving
        DOCX. Selecting the inserted content keeps the marker in OOXML. Empty
        structural paragraphs receive a hidden word-joiner so their bookmark
        also survives without producing visible text.
        """
        content = str(value)
        marker_content = content or '\u2060'
        text.insertString(cursor, marker_content, False)
        marker_cursor = text.createTextCursorByRange(cursor)
        marker_cursor.goLeft(len(marker_content), True)
        if not content:
            try:
                marker_cursor.CharHidden = True
            except Exception:
                pass
        bookmark = self._component.createInstance('com.sun.star.text.Bookmark')
        bookmark.Name = record['artifactName']
        text.insertTextContent(marker_cursor, bookmark, True)
        # Do not leak the hidden marker formatting into following flow content.
        # LibreOffice otherwise exports later runs with w:vanish and may reduce
        # inline graphics to the height of a single hidden text line.
        try:
            cursor.CharHidden = False
        except Exception:
            pass

    @staticmethod
    def _column_name(index):
        value = int(index) + 1
        name = ''
        while value > 0:
            value, remainder = divmod(value - 1, 26)
            name = chr(65 + remainder) + name
        return name

    def set_page(self, element_id, width=21000, height=29700, margins=(2000, 2000, 1800, 1800)):
        left, right, top, bottom = [int(value) for value in margins]
        if min(width, height, left, right, top, bottom) < 0:
            raise ValueError('Writer page geometry cannot be negative')
        if left + right >= width or top + bottom >= height:
            raise ValueError('Writer margins leave no usable page area')
        style = self._page_style()
        style.Width, style.Height = int(width), int(height)
        style.LeftMargin, style.RightMargin = left, right
        style.TopMargin, style.BottomMargin = top, bottom
        self.job.register_element(element_id, 'page-style', style, {'role': 'page-style'})
        return self

    def set_header_footer(self, header='', footer='', header_element_id=None, footer_element_id=None):
        style = self._page_style()
        style.HeaderIsOn = bool(header)
        style.FooterIsOn = bool(footer)
        if header:
            if not header_element_id:
                raise ValueError('header_element_id is required when header text is present')
            style.HeaderIsShared = True
            style.HeaderIsDynamicHeight = False
            style.HeaderHeight = 700
            style.HeaderBodyDistance = 300
            style.HeaderText.String = str(header)
            record = self.job.register_element(header_element_id, 'header', style.HeaderText, {'role': 'header'})
            cursor = style.HeaderText.createTextCursor()
            cursor.gotoStart(False)
            cursor.goRight(len(str(header)), True)
            bookmark = self._component.createInstance('com.sun.star.text.Bookmark')
            bookmark.Name = record['artifactName']
            style.HeaderText.insertTextContent(cursor, bookmark, True)
        if footer:
            if not footer_element_id:
                raise ValueError('footer_element_id is required when footer text is present')
            style.FooterIsShared = True
            style.FooterIsDynamicHeight = False
            style.FooterHeight = 700
            style.FooterBodyDistance = 250
            style.FooterText.String = str(footer)
            record = self.job.register_element(footer_element_id, 'footer', style.FooterText, {'role': 'footer'})
            cursor = style.FooterText.createTextCursor()
            cursor.gotoStart(False)
            cursor.goRight(len(str(footer)), True)
            bookmark = self._component.createInstance('com.sun.star.text.Bookmark')
            bookmark.Name = record['artifactName']
            style.FooterText.insertTextContent(cursor, bookmark, True)
        return self

    def add_paragraph(self, element_id, value='', font_size=None, bold=None, italic=None, color=None,
                      align=None, line_spacing=None, space_before=None, space_after=None,
                      paragraph_style=None, font_name=None, keep_with_next=None):
        cursor = self._paragraph_cursor(paragraph_style)
        if not paragraph_style:
            font_size = 11 if font_size is None else font_size
            bold, italic = bool(bold), bool(italic)
            color = 0x000000 if color is None else color
            align = align or 'LEFT'
            line_spacing = 1.3 if line_spacing is None else line_spacing
            space_before = 0 if space_before is None else space_before
            space_after = 180 if space_after is None else space_after
        apply_text_font(cursor, font_name=font_name, font_size=font_size, bold=bold, italic=italic)
        if color is not None:
            cursor.CharColor = office_color(color, 'Writer text color')
        if align is not None:
            cursor.ParaAdjust = uno.Enum('com.sun.star.style.ParagraphAdjust', str(align).upper())
        if line_spacing is not None:
            spacing = uno.createUnoStruct('com.sun.star.style.LineSpacing')
            spacing.Mode, spacing.Height = 0, max(100, int(float(line_spacing) * 100))
            cursor.ParaLineSpacing = spacing
        if space_before is not None:
            cursor.ParaTopMargin = max(0, int(space_before))
        if space_after is not None:
            cursor.ParaBottomMargin = max(0, int(space_after))
        if keep_with_next is not None:
            cursor.ParaKeepTogether = bool(keep_with_next)
            cursor.ParaSplit = not bool(keep_with_next)
        self._paragraph_count += 1
        record = self.job.register_element(element_id, 'paragraph', None, {'paragraph': self._paragraph_count})
        self._insert_bookmarked_text(self._component.Text, cursor, record, value)
        paragraph_break = uno.getConstantByName('com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK')
        self._component.Text.insertControlCharacter(cursor, paragraph_break, False)
        return self

    def add_heading(self, element_id, value, level=1, color=0x1F2937, align='LEFT', font_name=None,
                    font_size=None):
        sizes = {1: 24, 2: 18, 3: 15, 4: 13}
        level = min(4, max(1, int(level)))
        return self.add_paragraph(
            element_id, value,
            font_size=float(font_size) if font_size is not None else sizes[level],
            bold=True,
            color=color,
            align=align,
            line_spacing=1.15,
            space_before=220 if level > 1 else 0,
            space_after=180,
            paragraph_style=f'Heading {level}',
            font_name=font_name,
            keep_with_next=True,
        )

    def add_title(self, element_id, value, color=0x1F2937, align='LEFT', font_name=None,
                  font_size=None):
        """Add a document title without exposing Writer style internals."""
        return self.add_heading(
            element_id, value, level=1, color=color, align=align,
            font_name=font_name, font_size=font_size,
        )

    def add_bullets(self, element_id, values, level=0, font_size=11, color=0x000000, font_name=None):
        list_level = max(0, int(level))
        for index, value in enumerate(values):
            cursor = self._paragraph_cursor()
            apply_text_font(cursor, font_name=font_name, font_size=font_size, bold=False, italic=False)
            cursor.CharColor = office_color(color, 'Writer list color')
            cursor.ParaBottomMargin = 80
            cursor.NumberingStyleName = 'List 1'
            cursor.NumberingLevel = list_level
            self._paragraph_count += 1
            record = self.job.register_element(
                f'{element_id}/{index + 1}', 'list-item', None,
                {'paragraph': self._paragraph_count, 'level': list_level},
            )
            self._insert_bookmarked_text(self._component.Text, cursor, record, value)
            paragraph_break = uno.getConstantByName('com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK')
            self._component.Text.insertControlCharacter(cursor, paragraph_break, False)
        trailing_cursor = self._end_cursor()
        trailing_cursor.NumberingStyleName = ''
        trailing_cursor.CharHidden = False
        return self

    def add_numbered_list(self, element_id, values, level=0, font_size=11, color=0x000000, font_name=None,
                          start=1, continue_numbering=False):
        """Start a new native list; opt into continuing the preceding list."""
        list_level = max(0, int(level))
        for index, value in enumerate(values):
            cursor = self._paragraph_cursor()
            apply_text_font(cursor, font_name=font_name, font_size=font_size, bold=False, italic=False)
            cursor.CharColor = office_color(color, 'Writer list color')
            cursor.ParaBottomMargin = 80
            cursor.NumberingStyleName = 'Numbering 123'
            cursor.NumberingLevel = list_level
            cursor.ParaIsNumberingRestart = index == 0 and not continue_numbering
            if index == 0 and not continue_numbering:
                cursor.NumberingStartValue = max(1, min(32767, int(start)))
            self._paragraph_count += 1
            record = self.job.register_element(
                f'{element_id}/{index + 1}', 'numbered-list-item', None,
                {'paragraph': self._paragraph_count, 'level': list_level},
            )
            self._insert_bookmarked_text(self._component.Text, cursor, record, value)
            paragraph_break = uno.getConstantByName('com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK')
            self._component.Text.insertControlCharacter(cursor, paragraph_break, False)
        trailing_cursor = self._end_cursor()
        trailing_cursor.NumberingStyleName = ''
        trailing_cursor.CharHidden = False
        return self

    def feature(self, feature_name, element_id, **params):
        """Apply one versioned Writer recipe through the stable facade."""
        name = str(feature_name or '').strip().lower()
        if name == 'writer.page-style@1':
            return self.set_page(element_id, **params)
        if name == 'writer.header-footer@1':
            if params.get('header') and not params.get('header_element_id'):
                params['header_element_id'] = f'{element_id}/header'
            if params.get('footer') and not params.get('footer_element_id'):
                params['footer_element_id'] = f'{element_id}/footer'
            return self.set_header_footer(**params)
        raise ValueError(
            f'Unsupported Writer feature recipe {feature_name!r}. '
            'Query the corresponding unoApi module and use one of its installed facade examples.'
        )

    def add_table(self, element_id, rows, column_widths=None, header=True, font_size=10,
                  font_name=None, header_fill=0xE8EEF7, header_color=0x0F172A,
                  body_color=0x1E293B):
        data = [list(row) for row in rows]
        if not data or not data[0]:
            raise ValueError('Writer table requires at least one row and one column')
        column_count = len(data[0])
        if any(len(row) != column_count for row in data):
            raise ValueError('Writer table rows must all have the same column count')
        cursor = self._end_cursor()
        cursor.CharHidden = False
        record = self.job.register_element(element_id, 'table', None, {'table': len(self._component.TextTables.ElementNames) + 1})
        self._insert_bookmarked_text(self._component.Text, cursor, record, '')
        table = self._component.createInstance('com.sun.star.text.TextTable')
        table.initialize(len(data), column_count)
        self._component.Text.insertTextContent(cursor, table, False)
        table.RelativeWidth = 100
        if header:
            table.RepeatHeadline = True
            table.HeaderRowCount = 1
        if column_widths is not None:
            widths = [float(value) for value in column_widths]
            if len(widths) != column_count or any(value <= 0 for value in widths):
                raise ValueError('column_widths must contain one positive value per table column')
            total = sum(widths)
            separators = list(table.TableColumnSeparators)
            cumulative = 0.0
            for index, separator in enumerate(separators):
                cumulative += widths[index]
                separator.Position = int(table.TableColumnRelativeSum * cumulative / total)
            table.TableColumnSeparators = tuple(separators)
        for row_index, row in enumerate(data):
            for column_index, value in enumerate(row):
                name = f'{self._column_name(column_index)}{row_index + 1}'
                cell = table.getCellByName(name)
                cell.String = '' if value is None else str(value)
                cell_cursor = cell.createTextCursor()
                cell_cursor.gotoEnd(True)
                apply_text_font(cell_cursor, font_name=font_name, font_size=font_size,
                                bold=bool(header and row_index == 0), italic=False)
                cell_cursor.CharColor = office_color(
                    header_color if header and row_index == 0 else body_color,
                    'Writer table text color',
                )
                if header and row_index == 0:
                    cell.BackColor = office_color(header_fill, 'Writer table header fill')
        # Establish an ordinary flow paragraph after the table. Without this,
        # Writer can anchor the next inline object to the table's terminal row
        # and export it with a one-line height in DOCX.
        cursor.gotoEnd(False)
        cursor.NumberingStyleName = ''
        cursor.CharHidden = False
        paragraph_break = uno.getConstantByName('com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK')
        self._component.Text.insertControlCharacter(cursor, paragraph_break, False)
        self._paragraph_count += 1
        self._tables[str(element_id)] = table
        return table

    def add_inline_image(self, element_id, asset_name, width=None, height=None, align='CENTER', space_after=180,
                         alt_text=None, title=None):
        cursor = self._paragraph_cursor()
        cursor.ParaAdjust = uno.Enum('com.sun.star.style.ParagraphAdjust', str(align).upper())
        cursor.ParaBottomMargin = max(0, int(space_after))
        image = self._component.createInstance('com.sun.star.text.TextGraphicObject')
        self.job.register_element(element_id, 'image', image, {'image': len(self.job.element_records)})
        asset_path = self.job.asset_path(asset_name)
        asset_url = uno.systemPathToFileUrl(str(asset_path))
        try:
            provider = self.job.context.ServiceManager.createInstanceWithContext(
                'com.sun.star.graphic.GraphicProvider', self.job.context
            )
            graphic = provider.queryGraphic((self.job.property('URL', asset_url),))
        except Exception:
            graphic = None
        if graphic is not None:
            image.Graphic = graphic
        else:
            image.GraphicURL = asset_url
        try:
            image.Description = str(alt_text or '')
            image.Title = str(title or '')
        except Exception:
            pass
        image.AnchorType = uno.Enum('com.sun.star.text.TextContentAnchorType', 'AS_CHARACTER')
        bounds = self.job.document_bounds(self._component)
        intrinsic = source_image_dimensions(asset_path)
        try:
            natural_size = image.Graphic.Size100thMM
            natural_width, natural_height = int(natural_size.Width), int(natural_size.Height)
        except Exception:
            natural_width, natural_height = 12000, 7000
        ratio_width, ratio_height = intrinsic or (natural_width, natural_height)
        ratio_valid = float(ratio_width or 0) > 0 and float(ratio_height or 0) > 0
        if width is not None and height is None and ratio_valid:
            height = int(round(float(width) * float(ratio_height) / float(ratio_width)))
        elif height is not None and width is None and ratio_valid:
            width = int(round(float(height) * float(ratio_width) / float(ratio_height)))
        elif width is None and height is None:
            if ratio_valid:
                width = min(bounds['contentWidth'], natural_width if natural_width > 100 else bounds['contentWidth'])
                height = int(round(float(width) * float(ratio_height) / float(ratio_width)))
                if height > bounds['contentHeight']:
                    height = bounds['contentHeight']
                    width = int(round(float(height) * float(ratio_width) / float(ratio_height)))
            else:
                width, height = min(12000, bounds['contentWidth']), min(7000, bounds['contentHeight'])
        target_width = min(int(width or natural_width), bounds['contentWidth'])
        target_height = min(int(height or natural_height), bounds['contentHeight'])
        if target_width <= 0 or target_height <= 0:
            raise ValueError('Writer inline image dimensions must be positive')
        image.Width, image.Height = target_width, target_height
        self._component.Text.insertTextContent(cursor, image, False)
        # Writer may replace one dimension with lazy graphic metadata during insertion.
        # Apply the exact box again after the object is anchored in the document.
        try:
            image.setSize(size(target_width, target_height))
        except Exception:
            image.Width, image.Height = target_width, target_height
        paragraph_break = uno.getConstantByName('com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK')
        self._component.Text.insertControlCharacter(cursor, paragraph_break, False)
        self._paragraph_count += 1
        return image

    def add_page_break(self, element_id):
        cursor = self._end_cursor()
        cursor.NumberingStyleName = ''
        cursor.CharHidden = False
        # Page breaks must live on a neutral flow paragraph. Writer otherwise
        # inherits the previous paragraph's margins/style onto the break and
        # the first paragraph of the next page. That can make alternating pages
        # begin inside the header, especially after captions or list items.
        try:
            cursor.ParaStyleName = 'Standard'
        except Exception:
            pass
        cursor.ParaTopMargin = 0
        cursor.ParaBottomMargin = 0
        record = self.job.register_element(element_id, 'page-break', None, {'paragraph': self._paragraph_count + 1})
        self._insert_bookmarked_text(self._component.Text, cursor, record, '')
        paragraph_break = uno.getConstantByName('com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK')
        self._component.Text.insertControlCharacter(cursor, paragraph_break, False)
        following_cursor = self._end_cursor()
        following_cursor.NumberingStyleName = ''
        following_cursor.CharHidden = False
        try:
            following_cursor.ParaStyleName = 'Standard'
            # A Writer page break is a paragraph property.  Apply it only to the
            # following paragraph; applying PAGE_BEFORE to both sides produces
            # a blank page between every two authored sections after DOCX export.
            following_cursor.BreakType = uno.Enum('com.sun.star.style.BreakType', 'PAGE_BEFORE')
        except Exception:
            pass
        following_cursor.ParaTopMargin = 0
        following_cursor.ParaBottomMargin = 0
        self._paragraph_count += 1
        return self

    def replace_text(self, element_id, old_text, new_text, replace_all=True):
        old_text = str(old_text)
        if not old_text:
            raise ValueError('Writer replace_text requires non-empty old_text.')
        descriptor = self._component.createSearchDescriptor()
        descriptor.SearchString = old_text
        descriptor.SearchCaseSensitive = True
        found = self._component.findFirst(descriptor)
        count = 0
        while found is not None:
            found.String = str(new_text)
            count += 1
            if not replace_all:
                break
            found = self._component.findNext(found.End, descriptor)
        if not count:
            raise ValueError(f'Writer could not find exact text {old_text!r}.')
        self.job.register_element(element_id, 'text-replacement', self._component.Text, {'replacements': count})
        return count

    def add_rich_paragraph(self, element_id, runs, align='LEFT', line_spacing=1.3,
                           space_before=0, space_after=180, paragraph_style=None):
        values = list(runs or [])
        if not values:
            raise ValueError('Writer rich paragraph requires at least one run.')
        text = self._component.Text
        cursor = self._paragraph_cursor(paragraph_style)
        cursor.ParaAdjust = uno.Enum('com.sun.star.style.ParagraphAdjust', str(align).upper())
        spacing = uno.createUnoStruct('com.sun.star.style.LineSpacing')
        spacing.Mode, spacing.Height = 0, max(100, int(float(line_spacing) * 100))
        cursor.ParaLineSpacing = spacing
        cursor.ParaTopMargin, cursor.ParaBottomMargin = max(0, int(space_before)), max(0, int(space_after))
        base_font = cursor.CharFontName
        base_size, base_weight, base_posture, base_color = cursor.CharHeight, cursor.CharWeight, cursor.CharPosture, cursor.CharColor
        inserted = 0
        for item in values:
            run = dict(item) if isinstance(item, dict) else {'text': str(item)}
            value = str(run.get('text', ''))
            if not value:
                continue
            link = run.get('link') or run.get('url')
            text.insertString(cursor, value, False)
            run_cursor = text.createTextCursorByRange(cursor)
            run_cursor.goLeft(len(value), True)
            run_cursor.HyperLinkURL = str(link or '')
            if link:
                run_cursor.HyperLinkTarget = '_blank'
                self.job.record_feature('externalHyperlink')
            apply_text_font(run_cursor, font_name=run.get('font_name') or base_font,
                            font_size=run.get('font_size', base_size), bold=run.get('bold', base_weight > 100),
                            italic=run.get('italic', base_posture.value != 'NONE'))
            run_cursor.CharColor = office_color(run.get('color', base_color if base_color >= 0 else 0), 'Writer rich-text color')
            run_cursor.CharUnderline = uno.getConstantByName(
                'com.sun.star.awt.FontUnderline.SINGLE' if run.get('underline') else 'com.sun.star.awt.FontUnderline.NONE')
            inserted += len(value)
        if inserted <= 0:
            raise ValueError('Writer rich paragraph contains no visible text.')
        marker = text.createTextCursorByRange(cursor)
        marker.goLeft(inserted, True)
        record = self.job.register_element(element_id, 'rich-paragraph', None, {'paragraph': self._paragraph_count + 1})
        bookmark = self._component.createInstance('com.sun.star.text.Bookmark')
        bookmark.Name = record['artifactName']
        text.insertTextContent(marker, bookmark, True)
        paragraph_break = uno.getConstantByName('com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK')
        text.insertControlCharacter(cursor, paragraph_break, False)
        self._paragraph_count += 1
        return self

    def define_paragraph_style(self, element_id, name, parent='Standard', **style):
        family = self._component.StyleFamilies.getByName('ParagraphStyles')
        if family.hasByName(str(name)):
            target = family.getByName(str(name))
        else:
            target = self._component.createInstance('com.sun.star.style.ParagraphStyle')
            family.insertByName(str(name), target)
        if parent:
            try:
                target.ParentStyle = str(parent)
            except Exception:
                pass
        mapping = {
            'space_before': ('ParaTopMargin', int), 'space_after': ('ParaBottomMargin', int),
            'keep_with_next': ('ParaKeepTogether', bool),
        }
        apply_text_font(target, font_name=style.get('font_name'), font_size=style.get('font_size'),
                        bold=style.get('bold'), italic=style.get('italic'))
        for key, (property_name, converter) in mapping.items():
            if key in style:
                setattr(target, property_name, converter(style[key]))
        if 'color' in style:
            target.CharColor = office_color(style['color'], 'Writer paragraph-style color')
        if 'background' in style:
            target.ParaBackColor = office_color(style['background'], 'Writer paragraph-style background')
        if 'line_spacing' in style:
            spacing = uno.createUnoStruct('com.sun.star.style.LineSpacing')
            spacing.Mode, spacing.Height = 0, max(100, int(float(style['line_spacing']) * 100))
            target.ParaLineSpacing = spacing
        if 'align' in style:
            target.ParaAdjust = uno.Enum('com.sun.star.style.ParagraphAdjust', str(style['align']).upper())
        self.job.register_element(element_id, 'paragraph-style', target, {'style': str(name)})
        self.job.record_feature('paragraphStyle')
        return self

    def add_hyperlink(self, element_id, text, url, font_size=11, color=0x2563EB):
        cursor = self._end_cursor()
        value = str(text)
        self._component.Text.insertString(cursor, value, False)
        link_cursor = self._component.Text.createTextCursorByRange(cursor)
        link_cursor.goLeft(len(value), True)
        link_cursor.HyperLinkURL = str(url)
        link_cursor.HyperLinkTarget = '_blank'
        apply_text_font(link_cursor, font_size=font_size)
        link_cursor.CharColor = office_color(color, 'Writer link color')
        link_cursor.CharUnderline = uno.getConstantByName('com.sun.star.awt.FontUnderline.SINGLE')
        record = self.job.register_element(element_id, 'hyperlink', None, {'url': str(url)})
        bookmark = self._component.createInstance('com.sun.star.text.Bookmark')
        bookmark.Name = record['artifactName']
        self._component.Text.insertTextContent(link_cursor, bookmark, True)
        paragraph_break = uno.getConstantByName('com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK')
        self._component.Text.insertControlCharacter(cursor, paragraph_break, False)
        self.job.record_feature('externalHyperlink')
        return self

    def add_bookmark(self, element_id, name, text=''):
        cursor = self._end_cursor()
        value = str(text) or '\u2060'
        self._component.Text.insertString(cursor, value, False)
        marker = self._component.Text.createTextCursorByRange(cursor)
        marker.goLeft(len(value), True)
        bookmark = self._component.createInstance('com.sun.star.text.Bookmark')
        bookmark.Name = str(name)
        self._component.Text.insertTextContent(marker, bookmark, True)
        self.job.register_element(element_id, 'bookmark', bookmark, {'name': str(name)})
        self.job.record_feature('bookmark')
        return self

    def add_field(self, element_id, field_type='page-number', text_before='', text_after=''):
        services = {
            'page-number': 'com.sun.star.text.TextField.PageNumber',
            'page-count': 'com.sun.star.text.TextField.PageCount',
            'date': 'com.sun.star.text.TextField.DateTime',
            'file-name': 'com.sun.star.text.TextField.FileName',
            'title': 'com.sun.star.text.TextField.DocInfo.Title',
        }
        key = str(field_type).strip().lower().replace('_', '-')
        if key not in services:
            raise ValueError(f'Unsupported Writer field {field_type!r}; expected one of {sorted(services)}.')
        cursor = self._end_cursor()
        if text_before:
            self._component.Text.insertString(cursor, str(text_before), False)
        field = self._component.createInstance(services[key])
        if key in {'page-number', 'page-count'} and hasattr(field, 'NumberingType'):
            # Force Arabic digits for portable DOCX output. Otherwise the field
            # can inherit a section/page-style Roman numbering format even when
            # it appears inline in ordinary report body text.
            field.NumberingType = uno.getConstantByName('com.sun.star.style.NumberingType.ARABIC')
        self._component.Text.insertTextContent(cursor, field, False)
        if text_after:
            self._component.Text.insertString(cursor, str(text_after), False)
        self.job.register_element(element_id, 'field', field, {'fieldType': key})
        self.job.record_feature('field')
        return self

    def _index_cursor(self):
        """Reserve a normal flow paragraph after a Writer index section."""
        cursor = self._end_cursor()
        paragraph_break = uno.getConstantByName('com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK')
        self._component.Text.insertControlCharacter(cursor, paragraph_break, False)
        self._component.Text.insertControlCharacter(cursor, paragraph_break, False)
        cursor.goLeft(1, False)
        return cursor

    def add_toc(self, element_id, title='Contents', create_from_outline=True):
        cursor = self._index_cursor()
        index = self._component.createInstance('com.sun.star.text.ContentIndex')
        index.Title = str(title)
        index.CreateFromOutline = bool(create_from_outline)
        self._component.Text.insertTextContent(cursor, index, False)
        self.job.register_element(element_id, 'table-of-contents', index, {'title': str(title)})
        self.job.record_feature('tableOfContents')
        return self

    def add_index(self, element_id, title='Index'):
        cursor = self._index_cursor()
        index = self._component.createInstance('com.sun.star.text.DocumentIndex')
        index.Title = str(title)
        self._component.Text.insertTextContent(cursor, index, False)
        self.job.register_element(element_id, 'alphabetical-index', index, {'title': str(title)})
        self.job.record_feature('documentIndex')
        return self

    def add_cross_reference(self, element_id, bookmark_name, part='text', text_before='', text_after=''):
        parts = {
            'text': 'TEXT', 'page': 'PAGE', 'chapter': 'CHAPTER',
            'number': 'NUMBER', 'number-no-context': 'NUMBER_NO_CONTEXT',
        }
        key = str(part).strip().lower().replace('_', '-')
        if key not in parts:
            raise ValueError(f'Unsupported Writer reference part {part!r}.')
        try:
            field = self._component.createInstance('com.sun.star.text.TextField.GetReference')
            field.ReferenceFieldSource = uno.getConstantByName(
                'com.sun.star.text.ReferenceFieldSource.BOOKMARK'
            )
            field.SourceName = str(bookmark_name)
            field.ReferenceFieldPart = uno.getConstantByName(
                f'com.sun.star.text.ReferenceFieldPart.{parts[key]}'
            )
            cursor = self._end_cursor()
            if text_before:
                self._component.Text.insertString(cursor, str(text_before), False)
            self._component.Text.insertTextContent(cursor, field, False)
            if text_after:
                self._component.Text.insertString(cursor, str(text_after), False)
        except Exception as error:
            raise ValueError('Writer could not create the requested bookmark cross-reference.') from error
        self.job.register_element(element_id, 'cross-reference', field, {
            'bookmark': str(bookmark_name), 'part': key,
        })
        self.job.record_feature('crossReference')
        return self

    def add_note(self, element_id, text, kind='footnote', label=None, text_before='', text_after=''):
        normalized = str(kind).strip().lower()
        if normalized not in {'footnote', 'endnote'}:
            raise ValueError("Writer note kind must be 'footnote' or 'endnote'.")
        service = 'com.sun.star.text.Footnote' if normalized == 'footnote' else 'com.sun.star.text.Endnote'
        note = self._component.createInstance(service)
        if label:
            note.Label = str(label)
        cursor = self._end_cursor()
        if text_before:
            self._component.Text.insertString(cursor, str(text_before), False)
        self._component.Text.insertTextContent(cursor, note, False)
        if text_after:
            self._component.Text.insertString(cursor, str(text_after), False)
        note.String = str(text)
        self.job.register_element(element_id, normalized, note, {'kind': normalized})
        self.job.record_feature(normalized)
        return self

    def add_comment(self, element_id, text, author='User'):
        cursor = self._end_cursor()
        annotation = self._component.createInstance('com.sun.star.text.TextField.Annotation')
        annotation.Content, annotation.Author = str(text), str(author)
        self._component.Text.insertTextContent(cursor, annotation, False)
        self.job.register_element(element_id, 'comment', annotation, {'author': str(author)})
        self.job.record_feature('comment')
        return self

    def merge_table_cells(self, element_id, table_element_id, start_cell, end_cell):
        table = self._tables.get(str(table_element_id))
        if table is None:
            raise ValueError(f'Writer table {table_element_id!r} was not created by this facade instance.')
        cursor = table.createCursorByCellName(str(start_cell))
        if not cursor.gotoCellByName(str(end_cell), True):
            raise ValueError(f'Writer table cannot select range {start_cell}:{end_cell}.')
        cursor.mergeRange()
        self.job.register_element(element_id, 'merged-table-cells', table, {
            'tableElementId': str(table_element_id), 'range': f'{start_cell}:{end_cell}',
        })
        self.job.record_feature('mergedTableCells')
        return self

    def add_text_frame(self, element_id, text, width, height, anchor='AS_CHARACTER', background=None,
                       x=None, y=None, wrap='NONE'):
        frame = self._component.createInstance('com.sun.star.text.TextFrame')
        frame.Size = size(int(width), int(height))
        frame.AnchorType = uno.Enum('com.sun.star.text.TextContentAnchorType', str(anchor).upper())
        if background is not None:
            frame.BackColor = office_color(background, 'Writer frame background')
        if x is not None:
            frame.HoriOrient = uno.getConstantByName('com.sun.star.text.HoriOrientation.NONE')
            frame.HoriOrientPosition = int(x)
        if y is not None:
            frame.VertOrient = uno.getConstantByName('com.sun.star.text.VertOrientation.NONE')
            frame.VertOrientPosition = int(y)
        try:
            frame.Surround = uno.Enum('com.sun.star.text.WrapTextMode', str(wrap).upper())
        except Exception:
            pass
        cursor = self._end_cursor()
        self._component.Text.insertTextContent(cursor, frame, False)
        frame.String = str(text)
        self.job.register_element(element_id, 'text-frame', frame, {'anchor': str(anchor).upper()})
        self.job.record_feature('textFrame')
        if str(anchor).upper() == 'AS_CHARACTER':
            self._finish_block(cursor)
        return self

    def add_section(self, element_id, name, columns=1, protected=False):
        section = self._component.createInstance('com.sun.star.text.TextSection')
        section.Name = str(name)
        section.IsProtected = bool(protected)
        cursor = self._end_cursor()
        self._component.Text.insertTextContent(cursor, section, False)
        if int(columns) > 1:
            text_columns = section.TextColumns
            text_columns.ColumnCount = int(columns)
            section.TextColumns = text_columns
        self.job.register_element(element_id, 'section', section, {'name': str(name), 'columns': int(columns)})
        self.job.record_feature('section')
        return self

    def add_content_control(self, element_id, text='', tag=None, title=None, locked=False):
        try:
            control = self._component.createInstance('com.sun.star.text.ContentControl')
            if tag is not None:
                control.Tag = str(tag)
            if title is not None:
                control.Alias = str(title)
            if hasattr(control, 'LockContentControl'):
                control.LockContentControl = bool(locked)
            cursor = self._end_cursor()
            self._component.Text.insertTextContent(cursor, control, False)
            if hasattr(control, 'String'):
                control.String = str(text)
            elif hasattr(control, 'Text'):
                content_cursor = control.Text.createTextCursor()
                control.Text.insertString(content_cursor, str(text), False)
        except Exception as error:
            raise ValueError('This LibreOffice build cannot create a native Writer content control.') from error
        self.job.register_element(element_id, 'content-control', control, {'tag': str(tag or '')})
        self.job.record_feature('contentControl')
        return self

    def add_mail_merge_field(self, element_id, database, table, column):
        try:
            master = self._component.createInstance('com.sun.star.text.FieldMaster.Database')
            master.DataBaseName = str(database)
            master.DataTableName = str(table)
            master.DataColumnName = str(column)
            if hasattr(master, 'CommandType'):
                master.CommandType = 0
            elif hasattr(master, 'DataCommandType'):
                master.DataCommandType = 0
            try:
                master.Name = f'{database}.{table}.{column}'
            except Exception:
                pass
            field = self._component.createInstance('com.sun.star.text.TextField.Database')
            field.attachTextFieldMaster(master)
            field.Content = f'<{column}>'
            field.CurrentPresentation = f'<{column}>'
            cursor = self._end_cursor()
            self._component.Text.insertTextContent(cursor, field, False)
        except Exception as error:
            raise ValueError('Writer could not create the requested database mail-merge field.') from error
        self.job.register_element(element_id, 'mail-merge-field', field, {
            'database': str(database), 'table': str(table), 'column': str(column),
        })
        self.job.record_feature('mailMergeField')
        return self

    def add_formula(self, element_id, formula, width=5000, height=1800):
        try:
            embedded = self._component.createInstance('com.sun.star.text.TextEmbeddedObject')
            embedded.CLSID = '078B7ABA-54FC-457F-8551-6147e776a997'
            embedded.AnchorType = uno.Enum('com.sun.star.text.TextContentAnchorType', 'AS_CHARACTER')
            embedded.Size = size(int(width), int(height))
            cursor = self._paragraph_cursor()
            self._component.Text.insertTextContent(cursor, embedded, False)
            embedded.Model.Formula = str(formula)
            self._finish_block(cursor)
        except Exception as error:
            raise ValueError('Writer could not create the requested native formula object.') from error
        self.job.register_element(element_id, 'formula', embedded, {'formula': str(formula)})
        self.job.record_feature('formulaObject')
        return self

    def add_chart(self, element_id, categories, values, width=12000, height=7000,
                  chart_type='column', series_name='Values', title=None,
                  x_axis_title=None, y_axis_title=None, show_legend=False,
                  show_values=True, series_color=0x0B4F8A, background=0xFFFFFF,
                  wall_color=0xF8FAFC, grid_color=0xD5DEE8, text_color=0x111827):
        if len(categories) != len(values) or not categories:
            raise ValueError('Writer chart categories and values must be non-empty and have equal length.')
        try:
            embedded = self._component.createInstance('com.sun.star.text.TextEmbeddedObject')
            embedded.CLSID = '12DCAE26-281F-416F-A234-C3086127382E'
            embedded.AnchorType = uno.Enum('com.sun.star.text.TextContentAnchorType', 'AS_CHARACTER')
            embedded.Size = size(int(width), int(height))
            cursor = self._paragraph_cursor()
            self._component.Text.insertTextContent(cursor, embedded, False)
            chart = embedded.Model
            diagrams = {
                'column': 'com.sun.star.chart.BarDiagram', 'bar': 'com.sun.star.chart.BarDiagram',
                'line': 'com.sun.star.chart.LineDiagram', 'pie': 'com.sun.star.chart.PieDiagram',
                'area': 'com.sun.star.chart.AreaDiagram',
            }
            key = str(chart_type).strip().lower()
            if key not in diagrams:
                raise ValueError(f'Unsupported Writer chart type {chart_type!r}.')
            diagram = chart.createInstance(diagrams[key])
            chart.setDiagram(diagram)
            # Chart1 replaces its internal data sequences when a diagram is
            # installed. Populate data afterwards and then restore ROWS, or a
            # DOCX may contain numeric 1..N categories and one series per
            # category even though semantic labels were supplied.
            chart.Data.setData((tuple(float(value) for value in values),))
            chart.Data.setRowDescriptions((str(series_name),))
            chart.Data.setColumnDescriptions(tuple(str(value) for value in categories))
            try:
                diagram.DataRowSource = uno.Enum('com.sun.star.chart.ChartDataRowSource', 'ROWS')
            except Exception:
                pass
            if key in {'column', 'bar'}:
                # Chart1 uses Vertical=True for horizontal bars.
                diagram.Vertical = key == 'bar'
            chart.HasLegend = bool(show_legend)
            if title:
                chart.HasMainTitle = True
                chart.Title.String = str(title)
            for enabled_property, title_property, value in (
                ('HasXAxisTitle', 'XAxisTitle', x_axis_title),
                ('HasYAxisTitle', 'YAxisTitle', y_axis_title),
            ):
                if not str(value or '').strip():
                    continue
                for target in (diagram, chart):
                    try:
                        setattr(target, enabled_property, True)
                        getattr(target, title_property).String = str(value)
                        break
                    except Exception:
                        continue
            if show_values:
                try:
                    diagram.DataCaption = int(uno.getConstantByName('com.sun.star.chart.ChartDataCaption.VALUE'))
                except Exception:
                    pass
            # Chart1 exposes styling through several optional UNO property
            # sets. Apply a restrained default palette where available while
            # keeping compatibility with older LibreOffice builds.
            for target, property_name, value, label in (
                (chart.Area, 'FillColor', background, 'Writer chart background'),
                (getattr(diagram, 'Wall', None), 'FillColor', wall_color, 'Writer chart wall'),
            ):
                if target is None:
                    continue
                try:
                    setattr(target, property_name, office_color(value, label))
                except Exception:
                    pass
            try:
                series = diagram.getDataRowProperties(0)
                series.FillColor = office_color(series_color, 'Writer chart series')
                series.LineColor = office_color(series_color, 'Writer chart series line')
            except Exception:
                pass
            try:
                diagram.YAxis.MainGrid.LineColor = office_color(grid_color, 'Writer chart grid')
            except Exception:
                pass
            for target in (
                getattr(chart, 'Title', None), getattr(diagram, 'XAxis', None),
                getattr(diagram, 'YAxis', None), getattr(diagram, 'XAxisTitle', None),
                getattr(diagram, 'YAxisTitle', None),
            ):
                if target is None:
                    continue
                try:
                    target.CharColor = office_color(text_color, 'Writer chart text')
                    apply_text_font(target, font_name=_CJK_FONT)
                except Exception:
                    pass
        except ValueError:
            raise
        except Exception as error:
            raise ValueError('Writer could not create the requested native editable chart.') from error
        self.job.register_element(element_id, 'chart', embedded, {'chartType': str(chart_type)})
        self.job.record_feature('nativeChart')
        self._finish_block(cursor)
        return self

    def set_doc_info(self, title=None, subject=None, author=None, description=None, keywords=None):
        properties = self._component.DocumentProperties
        for name, value in (('Title', title), ('Subject', subject), ('Author', author), ('Description', description)):
            if value is not None:
                setattr(properties, name, str(value))
        if keywords is not None:
            properties.Keywords = tuple(str(value) for value in keywords)
        self.job.record_feature('documentProperties')
        return self

    def protect(self, password=''):
        self.job.ooxml_patches['writerProtection'] = {'password': str(password)}
        self.job.record_feature('documentProtection')
        return self

    @staticmethod
    def unsupported(feature_name):
        raise ValueError(
            f'Office capability {feature_name!r} is unsupported for authored UNO generation. '
            'Do not emulate it with raw UNO.'
        )

    def save(self):
        suffix = self.job.output_path.suffix.lower()
        filters = {
            '.doc': 'MS Word 97', '.docx': 'Office Open XML Text',
            '.odt': 'writer8', '.pdf': 'writer_pdf_Export',
        }
        if suffix not in filters:
            raise ValueError(f'Unsupported Writer output extension: {suffix}')
        # Refresh native TOCs and indexes after the full document has been
        # authored so exported DOCX/PDF previews contain the final headings.
        try:
            indexes = self._component.DocumentIndexes
            for index in range(indexes.Count):
                indexes.getByIndex(index).update()
        except Exception:
            # Older LibreOffice builds may expose indexes without update().
            # Saving must remain available in that compatibility case.
            pass
        save_document(self._component, self.job)
        return self

    def close(self):
        self.job.close(self._component)


class PresentationShape:
    """Editable high-level handle for one existing or newly created slide shape."""

    def __init__(self, slide, shape, element_id):
        self.slide = slide
        self.deck = slide.deck
        self._shape = shape
        self.element_id = str(element_id)

    def set_text(self, value, style=None):
        if not hasattr(self._shape, 'String'):
            raise ValueError(f'Presentation shape {self.element_id!r} is not a text shape.')
        self._shape.String = str(value)
        self.deck._format_text_shape(self._shape, **self.deck._normalized_text_options(style or {}))
        return self

    def replace_text(self, old_text, new_text, replace_all=True):
        current = str(getattr(self._shape, 'String', '') or '')
        old_text = str(old_text)
        if not old_text or old_text not in current:
            raise ValueError(f'Presentation shape {self.element_id!r} does not contain {old_text!r}.')
        self._shape.String = current.replace(old_text, str(new_text)) if replace_all else current.replace(old_text, str(new_text), 1)
        return self

    def set_box(self, box):
        area = self.deck._rect(box, default_unit='in')
        self._shape.Position = point(area['x'], area['y'])
        self._shape.Size = size(area['width'], area['height'])
        record = self.deck.job.element_records.get(self.element_id)
        if record is not None:
            record['layout'] = {**dict(record.get('layout') or {}), **area}
        return self

    def set_style(self, **style):
        shape_keys = {
            'fill', 'background', 'line', 'border', 'line_width', 'lineWidth',
            'borderWidth', 'fill_transparency', 'fillTransparency', 'transparency',
            'background_transparency', 'backgroundTransparency', 'rotation', 'rotate',
            'gradient',
        }
        text_keys = {
            'font_size', 'fontSize', 'min_font_size', 'minFontSize', 'font_name',
            'fontFamily', 'fontFace', 'color', 'fontColor', 'fontColour', 'bold',
            'fontWeight', 'italic', 'underline', 'strike', 'strikeout', 'align',
            'textAlign', 'padding', 'valign', 'verticalAlign', 'line_spacing',
            'lineSpacing', 'layout_role', 'layoutRole', 'allow_overlap', 'allowOverlap',
            'link',
        }
        unknown = sorted(set(style) - shape_keys - text_keys)
        if unknown:
            raise ValueError(
                f'Unsupported presentation shape style key(s): {", ".join(unknown)}. '
                f'Use one of: {", ".join(sorted(shape_keys | text_keys))}.'
            )
        normalized_shape = dict(style)
        for alias, target in {
            'lineWidth': 'line_width', 'borderWidth': 'line_width',
            'fillTransparency': 'fill_transparency',
            'backgroundTransparency': 'transparency',
            'background_transparency': 'transparency', 'rotate': 'rotation',
        }.items():
            if alias in normalized_shape and target not in normalized_shape:
                normalized_shape[target] = normalized_shape.pop(alias)
        gradient = normalized_shape.pop('gradient', None)
        self.deck._apply_shape_style(
            self._shape,
            **{key: value for key, value in normalized_shape.items() if key in {
                'fill', 'background', 'line', 'border', 'line_width',
                'fill_transparency', 'transparency', 'rotation',
            }},
        )
        if gradient is not None:
            self.deck._apply_shape_gradient(self._shape, gradient)
        if hasattr(self._shape, 'Text'):
            text_style = {key: value for key, value in style.items() if key in text_keys}
            self.deck._format_text_shape(self._shape, **self.deck._normalized_text_options(text_style))
        return self

    def remove(self):
        self.slide._page.remove(self._shape)
        self.deck.job.element_records.pop(self.element_id, None)
        return self.slide

    def bring_to_front(self):
        try:
            self._shape.ZOrder = max(0, int(self.slide._page.getCount()) - 1)
        except Exception as error:
            raise ValueError('This LibreOffice build cannot change the selected shape z-order.') from error
        return self

    def send_to_back(self):
        try:
            self._shape.ZOrder = 0
        except Exception as error:
            raise ValueError('This LibreOffice build cannot change the selected shape z-order.') from error
        return self


class PresentationTable(PresentationShape):
    """High-level native Impress table editor."""

    @property
    def _table(self):
        return self._shape.Model

    def set_cell(self, column, row, value, **style):
        columns, rows = self._table.Columns.Count, self._table.Rows.Count
        if (isinstance(column, bool) or isinstance(row, bool)
                or not isinstance(column, int) or not isinstance(row, int)
                or not 0 <= column < columns or not 0 <= row < rows):
            raise ValueError(
                f'PRESENTATION_TABLE_CELL_OUT_OF_RANGE: table.set_cell(column, row, value) uses ZERO-based '
                f'column then row indices. Received column={column!r}, row={row!r}; '
                f'valid columns are 0..{columns - 1}, rows 0..{rows - 1}. '
                'Correct the intended cell coordinates; do not remove the table edit.'
            )
        cell = self._table.getCellByPosition(column, row)
        cell.String = '' if value is None else str(value)
        cursor = cell.createTextCursor()
        cursor.gotoEnd(True)
        apply_text_font(cursor, font_name=style.get('font_name'), font_size=style.get('font_size'),
                        bold=style.get('bold'), italic=style.get('italic'))
        if 'color' in style:
            cursor.CharColor = office_color(style['color'], 'table text color')
        if 'background' in style:
            cell.FillColor = office_color(style['background'], 'table background')
        if 'align' in style:
            cursor.ParaAdjust = uno.Enum('com.sun.star.style.ParagraphAdjust', str(style['align']).upper())
        return self

    def merge(self, start_cell, end_cell):
        try:
            def coordinates(value):
                match = re.fullmatch(r'([A-Za-z]+)([1-9][0-9]*)', str(value).strip())
                if not match:
                    raise ValueError(f'Invalid Impress table cell address: {value!r}.')
                column = 0
                for character in match.group(1).upper():
                    column = column * 26 + ord(character) - 64
                return column - 1, int(match.group(2)) - 1

            start_column, start_row = coordinates(start_cell)
            end_column, end_row = coordinates(end_cell)
            left, right = sorted((start_column, end_column))
            top, bottom = sorted((start_row, end_row))
            if right >= self._table.Columns.Count or bottom >= self._table.Rows.Count:
                raise ValueError(
                    f'PRESENTATION_TABLE_CELL_OUT_OF_RANGE: merge({start_cell!r}, {end_cell!r}) exceeds '
                    f'the {self._table.Rows.Count}-row, {self._table.Columns.Count}-column table. '
                    'Use existing A1 cell addresses. Merge changes data and layout; it is not a no-op.'
                )
            cell_range = self._table.getCellRangeByPosition(left, top, right, bottom)
            if cell_range is None:
                raise ValueError(f'Cannot select table range {start_cell}:{end_cell}.')
            cursor = self._table.createCursorByRange(cell_range)
            mergeable = cursor.queryInterface(
                uno.getTypeByName('com.sun.star.table.XMergeableCellRange')
            )
            if mergeable is None or not mergeable.isMergeable():
                raise ValueError(f'Cannot merge table range {start_cell}:{end_cell}.')
            mergeable.merge()
        except ValueError:
            raise
        except Exception as error:
            raise ValueError('This LibreOffice build cannot merge the requested Impress table cells.') from error
        self.deck.job.record_feature('mergedTableCells')
        return self


class PresentationSlide:
    """PptxGenJS-like slide facade that never exposes the raw UNO page."""

    def __init__(self, deck, page, element_id, layout='title-content'):
        self.deck = deck
        self._page = page
        self.element_id = str(element_id)
        self.layout = str(layout or 'title-content').strip().lower().replace('_', '-')
        self._slots = deck.layout_slots(self.layout)

    def _id(self, value):
        child = str(value or '').strip().strip('/')
        child = re.sub(r'[\s\x00-\x1f\x7f]+', '-', child).strip('-')
        if not child:
            raise ValueError('Slide child elementId must be non-empty.')
        prefix = f'{self.element_id}/'
        child = child[:max(0, 128 - len(prefix))].rstrip('-')
        if not child:
            raise ValueError('Slide child elementId is too long for its slide prefix.')
        return f'{prefix}{child}'

    def slot(self, name='body'):
        key = str(name or 'body').strip().lower().replace('_', '-')
        if key not in self._slots:
            raise ValueError(
                f'Layout {self.layout!r} has no slot {name!r}; '
                f'available slots: {", ".join(sorted(self._slots))}.'
            )
        return dict(self._slots[key])

    def _box(self, slot=None, box=None):
        if box is not None:
            return self.deck._rect(box, default_unit='in')
        return self.deck._rect(self.slot(slot or 'body'))

    def _text_box(self, slot=None, box=None):
        if box is None:
            return self._box(slot, box)
        if isinstance(box, dict) and 'height' not in box and 'h' not in box:
            provisional = {**box, 'height': 1}
            area = self.deck._rect(provisional, default_unit='in')
            area.pop('height', None)
            return area
        return self._box(slot, box)

    def grid(self, columns, rows, slot='body', box=None, gap=0.24,
             column_weights=None, row_weights=None):
        """PptxGenJS-like inch grid whose cells can be passed back unchanged."""
        if isinstance(gap, (list, tuple)):
            if len(gap) != 2:
                raise ValueError('Slide grid gap must be inches or a two-item inch tuple.')
            resolved_gap = tuple(self.deck.inch(value) for value in gap)
        else:
            resolved_gap = self.deck.inch(gap)
        cells = self.deck.grid(
            columns, rows, box=self._box(slot, box), gap=resolved_gap,
            column_weights=column_weights, row_weights=row_weights,
        )
        # The low-level deck allocator works in UNO 1/100-mm units. The slide
        # facade is deliberately PptxGenJS-like, so callers must receive inch
        # floats as well as passable unit tags. Otherwise harmless arithmetic
        # such as cell['x'] + 0.15 is interpreted as millions of inches.
        return [{
            'x': cell['x'] / 2540.0,
            'y': cell['y'] / 2540.0,
            'width': cell['width'] / 2540.0,
            'height': cell['height'] / 2540.0,
            'w': cell['width'] / 2540.0,
            'h': cell['height'] / 2540.0,
            '_unit': 'in',
        } for cell in cells]

    def stack(self, count, slot='body', box=None, direction='vertical', gap=0.18, weights=None):
        """PptxGenJS-like inch stack whose cells can be used in arithmetic."""
        cells = self.deck.stack(
            count, box=self._box(slot, box), direction=direction,
            gap=self.deck.inch(gap), weights=weights,
        )
        return [{
            'x': cell['x'] / 2540.0,
            'y': cell['y'] / 2540.0,
            'width': cell['width'] / 2540.0,
            'height': cell['height'] / 2540.0,
            'w': cell['width'] / 2540.0,
            'h': cell['height'] / 2540.0,
            '_unit': 'in',
        } for cell in cells]

    def add_text(self, element_id, text, slot=None, box=None, style=None, **options):
        auto_height = bool(options.pop('auto_height', options.pop('autoHeight', False)))
        resolved = self.deck._normalized_text_options({**dict(style or {}), **options})
        if 'padding' in resolved:
            padding_value = float(resolved['padding'])
            # Slide facade geometry mirrors PptxGenJS and defaults to inches.
            # Preserve explicit deck.mm(...) values, which are necessarily much
            # larger than a practical inch padding value.
            resolved['padding'] = self.deck.inch(padding_value) if abs(padding_value) <= 2 else int(padding_value)
        area = self._text_box(slot, box)
        if auto_height:
            area.pop('height', None)
        if 'height' not in area:
            inset = self.deck.mm(1) if resolved.get('padding') is None else max(0, int(resolved['padding']))
            minimum = resolved.get('min_font_size', resolved.get('font_size', 18))
            metrics = self.deck.estimate_text_box(
                text, area['width'], resolved.get('font_size', 18), inset, minimum,
                resolved.get('line_spacing', 1.15),
            )
            area['height'] = metrics['height']
        background = resolved.pop('background', resolved.pop('fill', None))
        border = resolved.pop('border', resolved.pop('line', None))
        background_transparency = resolved.pop('background_transparency', resolved.pop('fill_transparency', 0))
        border_width = resolved.pop('line_width', None)
        link = resolved.pop('link', None)
        surface = None
        if background is not None or border is not None:
            surface = self.deck.add_shape(
                self._id(f'{element_id}/surface'), self._page,
                area['x'], area['y'], area['width'], area['height'],
                fill=background, line=border, line_width=border_width,
                fill_transparency=background_transparency,
                layout_role='container', allow_overlap=True,
            )
        if not str(text or '').strip() and surface is not None:
            # A blank/whitespace text box used only as a colored panel is a
            # common model mistake. Materialize the intended native shape and
            # do not add an invisible content text box that can collide with
            # real labels.
            return surface
        if link:
            destination = dict(link) if isinstance(link, dict) else {'url': str(link)}
            return self.deck.add_text_link(
                self._id(element_id), self._page, text, area,
                url=destination.get('url'), target_slide_id=destination.get('target_slide_id'), **resolved,
            )
        return self.deck.add_text_box(self._id(element_id), self._page, text, area, **resolved)

    def add_link(self, element_id, text, slot=None, box=None, url=None, target_slide_id=None,
                 style=None, **options):
        resolved = dict(style or {})
        resolved.update(options)
        resolved['link'] = {'url': url, 'target_slide_id': target_slide_id}
        # Route through add_text so link cards receive the same normalized
        # style, padding, optional background/border surface, and collision
        # semantics as ordinary facade text. This mirrors PptxGenJS hyperlink
        # text instead of leaking lower-level add_text_link parameters.
        return self.add_text(element_id, text, slot=slot, box=box, style=resolved)

    def add_image(self, element_id, asset_name, slot=None, box=None, contain=True, padding=0, **options):
        area = self._box(slot, box)
        if contain:
            return self.deck.add_image_contain(
                self._id(element_id), self._page, asset_name, area, padding=padding, **options,
            )
        return self.deck.add_image(
            self._id(element_id), self._page, asset_name,
            area['x'], area['y'], area['width'], area['height'], **options,
        )

    def add_captioned_image(self, element_id, asset_name, caption, slot=None, box=None,
                            source=None, alt_text=None, contain=True, padding=0,
                            caption_height=0.62, gap=0.08, caption_style=None, **options):
        """Add an identified image plus a visible caption/source block."""
        area = self._box(slot, box)
        caption_size = self.deck.inch(caption_height)
        gap_size = self.deck.inch(gap)
        image_height = area['height'] - caption_size - gap_size
        if image_height <= 0:
            raise ValueError(
                f'Captioned image {element_id!r} needs a taller box; caption and gap leave no image area.'
            )
        image_box = {**area, 'height': image_height}
        metadata = {
            'title': str(caption),
            'alt_text': str(alt_text or caption),
            'source': source,
        }
        metadata.update(options)
        scoped_image_id = self._id(f'{element_id}/image')
        if contain:
            image = self.deck.add_image_contain(
                scoped_image_id, self._page, asset_name, image_box,
                padding=padding, **metadata,
            )
        else:
            image = self.deck.add_image(
                scoped_image_id, self._page, asset_name,
                image_box['x'], image_box['y'], image_box['width'], image_box['height'],
                **metadata,
            )
        visible = str(caption)
        if source:
            visible += f'\nSource: {source}'
        style = {
            'font_size': 10, 'min_font_size': 8, 'color': 0x475569,
            'padding': 0, 'valign': 'TOP', 'align': 'LEFT',
        }
        style.update(caption_style or {})
        caption_box = {
            'x': area['x'], 'y': area['y'] + image_height + gap_size,
            'width': area['width'], 'height': caption_size,
        }
        self.deck.add_text_box(
            self._id(f'{element_id}/caption'), self._page, visible, caption_box,
            **self.deck._normalized_text_options(style),
        )
        self.deck.job.record_feature('captionedImage')
        return image

    def add_table(self, element_id, rows, slot=None, box=None, **options):
        if 'col_widths' in options:
            if 'column_weights' in options:
                raise ValueError("Presentation table accepts either 'column_weights' or its 'col_widths' alias, not both.")
            options['column_weights'] = options.pop('col_widths')
        scoped_id = self._id(element_id)
        shape = self.deck.add_native_table(
            scoped_id, self._page, self._box(slot, box), rows, **options,
        )
        return PresentationTable(self, shape, scoped_id)

    def add_chart(self, element_id, chart_type, categories, slot=None, box=None, **options):
        return self.deck.add_chart(
            self._id(element_id), self._page, self._box(slot, box), chart_type, categories, **options,
        )

    def add_card(self, element_id, title, body='', slot=None, box=None, fill=0xFFFFFF,
                 line=None, accent=None, title_size=20, body_size=14,
                 title_color=0x0F172A, body_color=0x334155, padding=None, gap=None):
        return self.deck.add_card(
            self._id(element_id), self._page, self._box(slot, box), title, body,
            fill=fill, line=line, accent=accent, title_size=title_size,
            body_size=body_size, title_color=title_color, body_color=body_color,
            padding=padding, gap=gap,
        )

    def add_timeline(self, element_id, events, slot=None, box=None, colors=None,
                     title_size=14, body_size=10, text_color=0x334155,
                     max_items_per_row=6):
        """Add a timeline using the complete installed option contract."""
        return self.deck.add_timeline(
            self._id(element_id), self._page, self._box(slot, box), events,
            colors=colors, title_size=title_size, body_size=body_size,
            text_color=text_color, max_items_per_row=max_items_per_row,
        )

    def add_header(self, element_id, left='', center='', right='', height=None,
                   background=None, accent=None, font_size=10, color=0x64748B,
                   padding=None, left_url=None, center_url=None, right_url=None):
        """Add header chrome inside the layout's reserved top margin."""
        resolved_height = None if height is None else (
            self.deck.inch(height) if abs(float(height)) <= 2 else int(height)
        )
        resolved_padding = None if padding is None else (
            self.deck.inch(padding) if abs(float(padding)) <= 2 else int(padding)
        )
        return self.deck.add_header(
            self._id(element_id), self._page, left=left, center=center, right=right,
            height=resolved_height, background=background, accent=accent,
            font_size=font_size, color=color, padding=resolved_padding,
            left_url=left_url, center_url=center_url, right_url=right_url,
        )

    def add_footer(self, element_id, left='', center='', right='', height=None,
                   background=None, accent=None, font_size=10, color=0x64748B,
                   padding=None, left_url=None, center_url=None, right_url=None):
        """Add footer chrome inside the layout's reserved bottom margin."""
        resolved_height = None if height is None else (
            self.deck.inch(height) if abs(float(height)) <= 2 else int(height)
        )
        resolved_padding = None if padding is None else (
            self.deck.inch(padding) if abs(float(padding)) <= 2 else int(padding)
        )
        return self.deck.add_footer(
            self._id(element_id), self._page, left=left, center=center, right=right,
            height=resolved_height, background=background, accent=accent,
            font_size=font_size, color=color, padding=resolved_padding,
            left_url=left_url, center_url=center_url, right_url=right_url,
        )

    def add_shape(self, element_id, slot=None, box=None, **options):
        area = self._box(slot, box)
        shape_type = options.pop('shape_type', options.pop('type', 'rectangle'))
        scoped_id = self._id(element_id)
        shape = self.deck.add_shape(
            scoped_id, self._page,
            area['x'], area['y'], area['width'], area['height'],
            shape_type=shape_type, **options,
        )
        return PresentationShape(self, shape, scoped_id)

    def add_rich_text(self, element_id, runs, slot=None, box=None, style=None):
        values = list(runs or [])
        if not values:
            raise ValueError('Presentation rich text requires at least one run.')
        base = self.deck._normalized_text_options(style or {})
        plain = ''.join(str(item.get('text', '')) if isinstance(item, dict) else str(item) for item in values)
        shape = self.deck.add_text_box(self._id(element_id), self._page, plain, self._box(slot, box), **base)
        shape.String = ''
        cursor = shape.Text.createTextCursor()
        for item in values:
            run = dict(item) if isinstance(item, dict) else {'text': str(item)}
            value = str(run.get('text', ''))
            if not value:
                continue
            link = run.get('link') or run.get('url')
            if link:
                field = self.deck._component.createInstance('com.sun.star.text.TextField.URL')
                field.URL, field.Representation = str(link), value
                shape.Text.insertTextContent(cursor, field, False)
                self.deck.job.record_feature('externalHyperlink')
            else:
                shape.Text.insertString(cursor, value, False)
            run_cursor = shape.Text.createTextCursorByRange(cursor)
            run_cursor.goLeft(len(value), True)
            options = self.deck._normalized_text_options({**base, **run})
            apply_text_font(run_cursor, font_name=options.get('font_name') or _CJK_FONT,
                            font_size=options.get('font_size'), bold=bool(options.get('bold')), italic=bool(options.get('italic')))
            if 'color' in options:
                run_cursor.CharColor = office_color(options['color'], 'rich-text color')
            run_cursor.CharUnderline = uno.getConstantByName(
                'com.sun.star.awt.FontUnderline.SINGLE' if options.get('underline') else 'com.sun.star.awt.FontUnderline.NONE')
        return shape

    def add_bullets(self, element_id, items, slot=None, box=None, level=0, style=None):
        values = [str(item) for item in items]
        if not values:
            raise ValueError('Presentation bullet list requires at least one item.')
        shape = self.add_text(element_id, '\n'.join(values), slot=slot, box=box, style=style)
        cursor = shape.Text.createTextCursor()
        cursor.gotoEnd(True)
        try:
            rules = cursor.NumberingRules
            rule = list(rules.getByIndex(max(0, int(level))))
            for property_value in rule:
                if property_value.Name == 'NumberingType':
                    property_value.Value = uno.getConstantByName('com.sun.star.style.NumberingType.CHAR_SPECIAL')
                elif property_value.Name == 'BulletChar':
                    property_value.Value = '\u2022'
            rules.replaceByIndex(max(0, int(level)), tuple(rule))
            cursor.NumberingRules = rules
            cursor.NumberingLevel = max(0, int(level))
        except Exception:
            shape.String = '\n'.join('\u2022 ' + value for value in values)
        record = self.deck.job.element_records.get(self._id(element_id)) or {}
        artifact_name = str(record.get('artifactName') or '')
        if artifact_name:
            self.deck.job.ooxml_patches.setdefault('nativeBullets', []).append(artifact_name)
        self.deck.job.record_feature('bulletList')
        return shape

    def set_background(self, color, *gradient_args, transparency=0, gradient=None):
        """Set a solid or gradient slide background.

        Supported forms are ``set_background('#F8FAFC', transparency=0)``,
        ``set_background('linear', '#020617', '#1E3A8A', 135)``, and
        ``set_background('#020617', gradient={...})``. The positional gradient
        form is intentionally accepted because it is the natural counterpart
        to PptxGenJS-style background recipes and avoids forcing a full-slide
        decorative shape into user-authored layout calculations.
        """
        fill = color
        gradient_values = dict(gradient or {}) if gradient is not None else None
        if gradient_args:
            style = str(color or '').strip().lower()
            if style not in {'linear', 'axial', 'radial', 'elliptical', 'square', 'rectangular'}:
                raise ValueError(
                    'PresentationSlide.set_background positional gradient form requires '
                    "style 'linear', 'axial', 'radial', 'elliptical', 'square', or 'rectangular'."
                )
            if len(gradient_args) not in {2, 3}:
                raise ValueError(
                    'PresentationSlide.set_background gradient form is '
                    'set_background(style, start_color, end_color, angle=0).'
                )
            fill = gradient_args[0]
            gradient_values = {
                'style': style,
                'start_color': gradient_args[0],
                'end_color': gradient_args[1],
                'angle': gradient_args[2] if len(gradient_args) == 3 else 0,
            }
        bounds = self.deck.bounds()
        background = self.deck.add_shape(
            self._id('background'), self._page, 0, 0, bounds['width'], bounds['height'],
            fill=fill, fill_transparency=transparency, gradient=gradient_values,
            layout_role='background', allow_overlap=True,
        )
        # slide(..., title=...) creates the title before callers normally set
        # the background. A newly added full-slide shape otherwise covers that
        # title and every earlier object in LibreOffice's paint order.
        try:
            background.ZOrder = 0
        except Exception:
            pass
        return background

    def shapes(self):
        result = []
        for index in range(self._page.getCount()):
            shape = self._page.getByIndex(index)
            result.append({
                'index': index + 1,
                'name': str(getattr(shape, 'Name', '') or ''),
                'title': str(getattr(shape, 'Title', '') or ''),
                'text': str(getattr(shape, 'String', '') or '')[:160],
                'x': int(shape.Position.X), 'y': int(shape.Position.Y),
                'width': int(shape.Size.Width), 'height': int(shape.Size.Height),
            })
        return result

    def select_shape(self, element_id, index=None, name=None, text=None):
        matches = []
        for shape_index in range(self._page.getCount()):
            shape = self._page.getByIndex(shape_index)
            if index is not None and shape_index + 1 != int(index):
                continue
            if name is not None and str(name) not in {
                str(getattr(shape, 'Name', '') or ''), str(getattr(shape, 'Title', '') or ''),
            }:
                continue
            if text is not None and str(text) not in str(getattr(shape, 'String', '') or ''):
                continue
            matches.append((shape_index, shape))
        if len(matches) != 1:
            raise ValueError(
                f'Presentation shape selector matched {len(matches)} shapes; provide one exact index/name/text selector.'
            )
        shape_index, shape = matches[0]
        scoped_id = self._id(element_id)
        record = self.deck.job.register_element(scoped_id, 'existing-shape', shape, {
            'slide': self.deck._page_index(self._page), 'shape': shape_index + 1,
        })
        record['layout'] = {
            'role': 'content', 'allowOverlap': False,
            'x': int(shape.Position.X), 'y': int(shape.Position.Y),
            'width': int(shape.Size.Width), 'height': int(shape.Size.Height),
        }
        return PresentationShape(self, shape, scoped_id)

    def replace_text(self, element_id, old_text, new_text, replace_all=True):
        count = 0
        for index in range(self._page.getCount()):
            shape = self._page.getByIndex(index)
            current = str(getattr(shape, 'String', '') or '')
            if str(old_text) not in current:
                continue
            shape.String = current.replace(str(old_text), str(new_text)) if replace_all else current.replace(str(old_text), str(new_text), 1)
            count += current.count(str(old_text)) if replace_all else 1
            if not replace_all:
                break
        if not count:
            raise ValueError(f'No text on slide {self.element_id!r} contains {old_text!r}.')
        self.deck.job.register_element(self._id(element_id), 'text-replacement', self._page, {
            'slide': self.deck._page_index(self._page), 'replacements': count,
        })
        return count

    def connect(self, element_id, source_box, target_box, **options):
        def resolved_box(value):
            if isinstance(value, str):
                scoped = self._id(value)
                record = self.deck.job.element_records.get(scoped)
                layout = record.get('layout') if isinstance(record, dict) else None
                if not isinstance(layout, dict) or not all(key in layout for key in ('x', 'y', 'width', 'height')):
                    raise ValueError(
                        f'Presentation connector endpoint {value!r} was not found on slide {self.element_id!r}. '
                        'Pass a child element ID already created on this slide, or pass a box.'
                    )
                return {key: int(layout[key]) for key in ('x', 'y', 'width', 'height')}
            return self.deck._rect(value, default_unit='in')
        aliases = {
            'width': 'line_width', 'lineWidth': 'line_width',
            'startArrow': 'start_arrow', 'endArrow': 'end_arrow',
            'startArrowWidth': 'start_arrow_width', 'endArrowWidth': 'end_arrow_width',
        }
        resolved_options = {
            aliases.get(key, key): value
            for key, value in options.items()
            if key != 'kind'
        }
        for key in ('line_width', 'start_arrow_width', 'end_arrow_width'):
            if key not in resolved_options or resolved_options[key] is None:
                continue
            numeric = float(resolved_options[key])
            resolved_options[key] = self.deck.pt(numeric) if abs(numeric) <= 24 else int(numeric)
        for key in ('start_arrow', 'end_arrow'):
            if key in resolved_options and isinstance(resolved_options[key], str):
                resolved_options[key] = resolved_options[key].strip().lower() not in {'', 'none', 'false', '0', 'no'}
        return self.deck.add_connector_between(
            self._id(element_id), self._page,
            resolved_box(source_box), resolved_box(target_box), **resolved_options,
        )

    def feature(self, feature_name, element_id, **params):
        return self.deck.feature(feature_name, self._id(element_id), slide=self, **params)

    def set_transition(self, effect='fade', speed='medium'):
        return self.feature(
            'presentation.transition@1', 'transition', effect=effect, speed=speed,
        )

    def set_notes(self, element_id, text):
        return self.deck.set_notes(self._id(element_id), self, text)

    def add_comment(self, element_id, text, author='User'):
        return self.deck.add_comment(self._id(element_id), self, text, author=author)

    def add_media(self, element_id, asset_name, slot=None, box=None, media_type='auto', **options):
        return self.deck.add_media(
            self._id(element_id), self, asset_name, self._box(slot, box),
            media_type=media_type, **options,
        )

    def animate(self, shape, effect='fade', speed='medium'):
        if isinstance(shape, PresentationShape):
            target = shape
        elif isinstance(shape, dict) and shape and set(shape) <= {'index', 'name', 'text'}:
            target = self.select_shape('animation-target', **shape)
        else:
            raise ValueError(
                'PRESENTATION_ANIMATION_TARGET_INVALID: slide.animate exists, but shape must be the '
                'PresentationShape returned by slide.add_shape()/select_shape(), or an index/name/text '
                'selector dictionary. A bare elementId string is not a shape. Keep the returned shape '
                'in a variable and pass it to animate; do not remove animation as unsupported.'
            )
        if target.slide is not self:
            raise ValueError('PRESENTATION_ANIMATION_TARGET_INVALID: the animation target belongs to another slide.')
        return self.deck.set_animation(target, effect=effect, speed=speed)

    def apply_master(self, index=None, name=None):
        return self.deck.apply_master(self, index=index, name=name)

    def group(self, element_id, shapes):
        values = list(shapes or [])
        if not values or not all(isinstance(value, PresentationShape) for value in values):
            raise ValueError('slide.group requires PresentationShape objects returned by slide.select_shape().')
        collection = self.deck.job.context.ServiceManager.createInstanceWithContext(
            'com.sun.star.drawing.ShapeCollection', self.deck.job.context,
        )
        for value in values:
            collection.add(value._shape)
        grouped = self._page.group(collection)
        scoped_id = self._id(element_id)
        self.deck.job.register_element(scoped_id, 'shape-group', grouped, {
            'slide': self.deck._page_index(self._page),
        })
        self.deck.job.record_feature('shapeGroup')
        return PresentationShape(self, grouped, scoped_id)

    def add_field(self, element_id, field_type='page-number', slot=None, box=None, style=None):
        return self.deck.add_field(
            self._id(element_id), self, field_type, self._box(slot, box), style=style,
        )


class PresentationLayout(OfficeUnitConversion):
    """Stable Impress geometry helpers. Expert mode covers unmodeled services."""

    _LAYOUT_ROLES = {'content', 'container', 'decoration', 'background'}

    @staticmethod
    def _rotation(value):
        # PowerPoint/PptxGenJS angles increase clockwise; UNO drawing angles
        # increase counter-clockwise. Normalize at the facade boundary.
        return int(round((-float(value)) % 360.0 * 100))

    def __init__(self, job, component, normalize_wide=False):
        self.job, self._component = job, component
        self._slide_count = 0
        self._reuse_factory_page = bool(normalize_wide)
        self._logical_pages = [
            self._component.DrawPages.getByIndex(index)
            for index in range(self._component.DrawPages.Count)
        ]
        if normalize_wide:
            # Match the coordinate contract models already know from
            # PptxGenJS: LAYOUT_WIDE is 13.333 x 7.5 inches. LibreOffice's
            # factory default has the same ratio but a smaller physical page,
            # which otherwise makes valid PptxGenJS-style boxes appear out of
            # bounds after an inch conversion.
            wide_width, wide_height = self.inch(13.333), self.inch(7.5)
            for pages in (self._component.DrawPages, self._component.MasterPages):
                for index in range(pages.Count):
                    page = pages.getByIndex(index)
                    page.Width, page.Height = wide_width, wide_height

    @staticmethod
    def text_height(font_size, lines=1, padding=0, line_spacing=1.15):
        return presentation_text_height(font_size, lines=lines, padding=padding, line_spacing=line_spacing)

    @staticmethod
    def _rect(box, default_unit=None):
        if isinstance(box, (list, tuple)) and len(box) == 4:
            normalized = dict(zip(('x', 'y', 'width', 'height'), box))
        elif isinstance(box, dict):
            normalized = dict(box)
        else:
            raise ValueError(
                'Presentation box must be {x, y, width/height}, {x, y, w/h}, '
                'or a four-item (x, y, width, height) sequence.'
            )
        if 'width' not in normalized and 'w' in normalized:
            normalized['width'] = normalized['w']
        if 'height' not in normalized and 'h' in normalized:
            normalized['height'] = normalized['h']
        missing = [key for key in ('x', 'y', 'width', 'height') if key not in normalized]
        if missing:
            raise ValueError(f'Presentation box is missing {missing[0]!r}.')
        unit = str(normalized.get('unit', normalized.get('_unit', default_unit or 'hmm'))).strip().lower()
        factors = {
            'hmm': 1.0, '1/100 mm': 1.0, '100th-mm': 1.0,
            'mm': 100.0, 'cm': 1000.0,
            'in': 2540.0, 'inch': 2540.0, 'inches': 2540.0,
            'pt': POINT_TO_100TH_MM,
        }
        if unit not in factors:
            raise ValueError("Presentation box unit must be 'in', 'mm', 'cm', 'pt', or 'hmm'.")
        factor = factors[unit]
        result = {key: int(round(float(normalized[key]) * factor)) for key in ('x', 'y', 'width', 'height')}
        if result['x'] < 0 or result['y'] < 0 or result['width'] <= 0 or result['height'] <= 0:
            raise ValueError(
                'Presentation box requires non-negative x/y and positive width/height after unit conversion: '
                f'{result} (source unit={unit!r}).'
            )
        return result

    @staticmethod
    def _normalized_text_options(options):
        aliases = {
            'fontSize': 'font_size', 'minFontSize': 'min_font_size',
            'fontFamily': 'font_name', 'fontFace': 'font_name',
            'fontColor': 'color', 'fontColour': 'color',
            'verticalAlign': 'valign',
            'textAlign': 'align', 'lineSpacing': 'line_spacing',
            'backgroundColor': 'background', 'fillColor': 'fill',
            'borderColor': 'border', 'lineColor': 'line',
            'borderWidth': 'line_width', 'lineWidth': 'line_width',
            'fillTransparency': 'fill_transparency',
            'backgroundTransparency': 'background_transparency',
            'allowOverlap': 'allow_overlap', 'layoutRole': 'layout_role',
            'strikeout': 'strike', 'rotate': 'rotation',
        }
        allowed = {
            'font_size', 'color', 'bold', 'italic', 'underline', 'strike',
            'align', 'font_name', 'min_font_size', 'padding', 'valign',
            'layout_role', 'allow_overlap', 'rotation', 'line_spacing',
            'background', 'fill', 'border', 'line', 'background_transparency',
            'fill_transparency', 'line_width', 'link',
        }
        result = {}
        unknown = []
        for key, value in dict(options or {}).items():
            target = aliases.get(key, key)
            if target in allowed:
                result[target] = value
            elif key == 'fontWeight':
                result['bold'] = str(value).strip().lower() == 'bold' or (
                    isinstance(value, (int, float)) and float(value) >= 600
                )
            elif key not in {'text', 'url'}:
                unknown.append(str(key))
        if unknown:
            raise ValueError(
                f'Unsupported presentation text style key(s): {", ".join(sorted(unknown))}. '
                f'Use one of: {", ".join(sorted(allowed | set(aliases) | {"fontWeight"}))}.'
            )
        return result

    @staticmethod
    def _format_text_shape(shape, font_size=None, color=None, bold=None, italic=None,
                           underline=None, strike=None, align=None, font_name=None,
                           rotation=None, line_spacing=None, **_unused):
        cursor = shape.Text.createTextCursor()
        cursor.gotoEnd(True)
        apply_text_font(cursor, font_name=font_name, font_size=font_size, bold=bold, italic=italic)
        if not font_name and not str(cursor.CharFontNameAsian or '').strip():
            cursor.CharFontNameAsian = _CJK_FONT
        if color is not None:
            cursor.CharColor = office_color(color, 'text color')
        if underline is not None:
            cursor.CharUnderline = uno.getConstantByName(
                'com.sun.star.awt.FontUnderline.SINGLE' if underline else 'com.sun.star.awt.FontUnderline.NONE'
            )
        if strike is not None:
            cursor.CharStrikeout = uno.getConstantByName(
                'com.sun.star.awt.FontStrikeout.SINGLE' if strike else 'com.sun.star.awt.FontStrikeout.NONE'
            )
        if align is not None:
            cursor.ParaAdjust = uno.Enum('com.sun.star.style.ParagraphAdjust', str(align).upper())
        if line_spacing is not None:
            spacing = uno.createUnoStruct('com.sun.star.style.LineSpacing')
            spacing.Mode, spacing.Height = 0, max(100, int(float(line_spacing) * 100))
            cursor.ParaLineSpacing = spacing
        if rotation is not None:
            shape.RotateAngle = PresentationLayout._rotation(rotation)
        return shape

    @staticmethod
    def _apply_shape_style(shape, fill=None, background=None, line=None, border=None,
                           line_width=None, fill_transparency=None, transparency=None,
                           rotation=None, **_unused):
        resolved_fill = fill if fill is not None else background
        resolved_line = line if line is not None else border
        if resolved_fill is not None:
            shape.FillStyle = uno.Enum('com.sun.star.drawing.FillStyle', 'SOLID')
            shape.FillColor = office_color(resolved_fill, 'shape fill')
        if fill_transparency is not None or transparency is not None:
            shape.FillTransparence = max(0, min(100, int(fill_transparency if fill_transparency is not None else transparency)))
        if resolved_line is not None:
            if isinstance(resolved_line, dict):
                line_options = dict(resolved_line)
                unknown = sorted(set(line_options) - {'color', 'fill', 'width', 'line_width', 'transparency'})
                if unknown:
                    raise ValueError(
                        f'Unsupported presentation line style key(s): {", ".join(unknown)}. '
                        'Use color, width, line_width, or transparency.'
                    )
                resolved_line = line_options.get('color', line_options.get('fill', 0x000000))
                if line_width in (None, 0):
                    line_width = line_options.get('width', line_options.get('line_width'))
                if line_options.get('transparency') is not None:
                    try:
                        shape.LineTransparence = max(0, min(100, int(line_options['transparency'])))
                    except Exception:
                        pass
            shape.LineStyle = uno.Enum('com.sun.star.drawing.LineStyle', 'SOLID')
            shape.LineColor = office_color(resolved_line, 'shape line color')
        if line_width is not None:
            nested_width = isinstance(line if line is not None else border, dict)
            shape.LineWidth = max(0, PresentationLayout.pt(line_width) if nested_width else int(line_width))
        if rotation is not None:
            shape.RotateAngle = PresentationLayout._rotation(rotation)
        return shape

    @staticmethod
    def _apply_shape_gradient(shape, gradient):
        values = dict(gradient or {})
        unknown = sorted(set(values) - {
            'style', 'start_color', 'startColor', 'end_color', 'endColor', 'angle',
            'border', 'x_offset', 'xOffset', 'y_offset', 'yOffset',
            'start_intensity', 'startIntensity', 'end_intensity', 'endIntensity',
        })
        if unknown:
            raise ValueError(
                f'Unsupported presentation gradient key(s): {", ".join(unknown)}. '
                'Use style, start_color, end_color, angle, border, x_offset, y_offset, '
                'start_intensity, or end_intensity.'
            )
        native_gradient = uno.createUnoStruct('com.sun.star.awt.Gradient')
        native_gradient.Style = uno.Enum(
            'com.sun.star.awt.GradientStyle', str(values.get('style', 'LINEAR')).upper()
        )
        native_gradient.StartColor = office_color(
            values.get('start_color', values.get('startColor', 0xFFFFFF)), 'gradient start color'
        )
        native_gradient.EndColor = office_color(
            values.get('end_color', values.get('endColor', 0x000000)), 'gradient end color'
        )
        native_gradient.Angle = int(round(float(values.get('angle', 0)) * 10))
        native_gradient.Border = max(0, min(100, int(values.get('border', 0))))
        native_gradient.XOffset = max(0, min(100, int(values.get('x_offset', values.get('xOffset', 50)))))
        native_gradient.YOffset = max(0, min(100, int(values.get('y_offset', values.get('yOffset', 50)))))
        native_gradient.StartIntensity = max(0, min(100, int(values.get(
            'start_intensity', values.get('startIntensity', 100)
        ))))
        native_gradient.EndIntensity = max(0, min(100, int(values.get(
            'end_intensity', values.get('endIntensity', 100)
        ))))
        shape.FillStyle = uno.Enum('com.sun.star.drawing.FillStyle', 'GRADIENT')
        shape.FillGradient = native_gradient
        return shape

    def _page_index(self, page):
        for index, candidate in enumerate(self._logical_pages):
            if candidate == page:
                return index + 1
        return 1

    def estimate_text_box(self, text, width, font_size=18, padding=0, min_font_size=None,
                          line_spacing=1.15):
        """Return safe text metrics without relying on TextShape minimum-frame noise."""
        requested_size = max(1.0, float(font_size))
        minimum_size = requested_size if min_font_size is None else max(1.0, float(min_font_size))
        requested_lines = presentation_text_line_count(text, width, requested_size, padding)
        minimum_lines = presentation_text_line_count(text, width, minimum_size, padding)
        return {
            'lines': requested_lines,
            'height': presentation_text_height(requested_size, requested_lines, padding, line_spacing),
            'minimumLines': minimum_lines,
            'minimumHeight': presentation_text_height(minimum_size, minimum_lines, padding, line_spacing),
            'unit': '1/100 mm',
        }

    def bounds(self):
        """Return exact slide width/height in 1/100 mm for facade geometry."""
        return self.job.document_bounds(self._component)

    def content_box(self, margins=(1600, 1600, 1400, 1200)):
        """Return a safe content rectangle inside the current slide bounds.

        Prefer a named mapping with ``left``, ``right``, ``top`` and ``bottom``
        values. The legacy tuple form is ``(left, right, top, bottom)``. Named
        margins remove the easy-to-miss CSS-order ambiguity while keeping old
        programs compatible.
        """
        if isinstance(margins, dict):
            allowed = {'left', 'right', 'top', 'bottom'}
            unknown = sorted(set(margins) - allowed)
            if unknown:
                raise ValueError(
                    f'Unknown presentation margin {unknown[0]!r}; expected left, right, top, or bottom.'
                )
            left, right, top, bottom = [
                max(0, int(margins.get(key, 0))) for key in ('left', 'right', 'top', 'bottom')
            ]
            resolved_margins = {'left': left, 'right': right, 'top': top, 'bottom': bottom}
        elif isinstance(margins, (list, tuple)) and len(margins) == 4:
            left, right, top, bottom = [max(0, int(value)) for value in margins]
            resolved_margins = (left, right, top, bottom)
        else:
            raise ValueError(
                'Presentation margins must be a {left, right, top, bottom} mapping '
                'or legacy (left, right, top, bottom) tuple.'
            )
        bounds = self.bounds()
        width = int(bounds['width']) - left - right
        height = int(bounds['height']) - top - bottom
        if width <= 0 or height <= 0:
            raise ValueError(
                f'Presentation margins leave no usable content area: margins={resolved_margins}, '
                f'slideWidth={int(bounds["width"])}, slideHeight={int(bounds["height"])}'
            )
        return {'x': left, 'y': top, 'width': width, 'height': height, '_unit': 'hmm'}

    @staticmethod
    def _normalized_weights(count, weights):
        if weights is None:
            return [1.0] * count
        values = [float(value) for value in weights]
        if len(values) != count or any(value <= 0 for value in values):
            raise ValueError('Layout weights must contain one positive value per track.')
        return values

    def grid(self, columns, rows, box=None, gap=500, column_weights=None, row_weights=None):
        """Partition a rectangle into deterministic non-overlapping cells."""
        columns, rows = int(columns), int(rows)
        if columns <= 0 or rows <= 0:
            raise ValueError('Presentation grid requires positive columns and rows.')
        area = dict(box or self.content_box())
        x, y = int(area['x']), int(area['y'])
        width, height = int(area['width']), int(area['height'])
        if isinstance(gap, (list, tuple)):
            if len(gap) != 2:
                raise ValueError('Presentation grid gap must be a number or (horizontal, vertical).')
            gap_x, gap_y = [max(0, int(value)) for value in gap]
        else:
            gap_x = gap_y = max(0, int(gap))
        available_width = width - gap_x * (columns - 1)
        available_height = height - gap_y * (rows - 1)
        if available_width <= 0 or available_height <= 0:
            raise ValueError('Presentation grid gaps leave no usable cell area.')
        column_values = self._normalized_weights(columns, column_weights)
        row_values = self._normalized_weights(rows, row_weights)
        column_widths = [int(available_width * value / sum(column_values)) for value in column_values]
        row_heights = [int(available_height * value / sum(row_values)) for value in row_values]
        column_widths[-1] += available_width - sum(column_widths)
        row_heights[-1] += available_height - sum(row_heights)
        cells, cell_y = [], y
        for row, row_height in enumerate(row_heights):
            cell_x = x
            for column, column_width in enumerate(column_widths):
                cells.append({
                    'x': cell_x, 'y': cell_y,
                    'width': column_width, 'height': row_height,
                    '_unit': 'hmm',
                })
                cell_x += column_width + gap_x
            cell_y += row_height + gap_y
        return cells

    def stack(self, count, box=None, direction='vertical', gap=400, weights=None):
        """Partition a rectangle into a vertical or horizontal content stack."""
        count = int(count)
        if count <= 0:
            raise ValueError('Presentation stack requires a positive item count.')
        direction = str(direction or 'vertical').strip().lower()
        if direction == 'vertical':
            return self.grid(1, count, box=box, gap=(0, gap), row_weights=weights)
        if direction == 'horizontal':
            return self.grid(count, 1, box=box, gap=(gap, 0), column_weights=weights)
        raise ValueError("Presentation stack direction must be 'vertical' or 'horizontal'.")

    def layout_slots(self, layout='title-content'):
        """Return deterministic named slots for the model-facing slide facade."""
        name = str(layout or 'title-content').strip().lower().replace('_', '-')
        safe = self.content_box(margins={
            'left': self.mm(16), 'right': self.mm(16),
            'top': self.mm(10), 'bottom': self.mm(14),
        })
        title_height = self.mm(16)
        gap = self.mm(6)
        title = {'x': safe['x'], 'y': safe['y'], 'width': safe['width'], 'height': title_height}
        body = {
            'x': safe['x'], 'y': safe['y'] + title_height + gap,
            'width': safe['width'], 'height': safe['height'] - title_height - gap,
        }
        def tagged(box):
            return {**box, '_unit': 'hmm'}
        aliases = {
            'title-cover': 'cover', 'title-slide': 'cover',
            'title-section': 'section', 'section-header': 'section', 'section-slide': 'section',
            'comparison': 'title-two-column',
            'dashboard': 'title-three-column',
        }
        name = aliases.get(name, name)
        if name == 'blank':
            return {'body': tagged(safe), 'full': tagged(safe)}
        if name == 'cover':
            cover = self.content_box(margins={
                'left': self.mm(20), 'right': self.mm(20),
                'top': self.mm(38), 'bottom': self.mm(28),
            })
            cover_title, cover_subtitle = self.stack(2, box=cover, gap=self.mm(7), weights=(1.5, 1))
            return {'title': tagged(cover_title), 'subtitle': tagged(cover_subtitle), 'body': tagged(cover_subtitle), 'full': tagged(safe)}
        if name == 'section':
            section = self.content_box(margins={
                'left': self.mm(24), 'right': self.mm(24),
                'top': self.mm(48), 'bottom': self.mm(38),
            })
            section_title, section_body = self.stack(2, box=section, gap=self.mm(5), weights=(1.2, 1))
            return {'title': tagged(section_title), 'body': tagged(section_body), 'subtitle': tagged(section_body), 'full': tagged(safe)}
        if name == 'title-only':
            return {'title': tagged(title), 'body': tagged(body), 'full': tagged(safe)}
        if name == 'title-content':
            return {'title': tagged(title), 'body': tagged(body), 'full': tagged(safe)}
        if name == 'title-two-column':
            left, right = self.grid(2, 1, box=body, gap=self.mm(8))
            return {'title': tagged(title), 'body': tagged(body), 'left': tagged(left), 'right': tagged(right), 'full': tagged(safe)}
        if name == 'title-three-column':
            left, center, right = self.grid(3, 1, box=body, gap=self.mm(6))
            return {
                'title': tagged(title), 'body': tagged(body), 'left': tagged(left), 'center': tagged(center),
                'right': tagged(right), 'full': tagged(safe),
            }
        raise ValueError(
            f'Unsupported presentation layout {layout!r}; expected blank, cover/title-cover, '
            'section/title-section, '
            'title-only, title-content, title-two-column/comparison, or title-three-column/dashboard.'
        )

    def add_slide(self, element_id):
        if self._slide_count == 0 and self._reuse_factory_page and self._component.DrawPages.Count == 1:
            page = self._component.DrawPages.getByIndex(0)
            while page.getCount():
                page.remove(page.getByIndex(0))
        else:
            page = self._component.DrawPages.insertNewByIndex(self._component.DrawPages.Count)
            self._logical_pages.append(page)
        self._slide_count += 1
        self.job.register_element(
            element_id,
            'slide',
            page,
            {'slide': self._page_index(page)},
            force_artifact_name=True,
        )
        return page

    def slide(self, element_id, layout='title-content', title=None, title_style=None):
        """Create one slide and return the only model-facing slide object."""
        result = PresentationSlide(self, self.add_slide(element_id), element_id, layout=layout)
        if title is not None:
            style = {
                'font_size': 28, 'min_font_size': 24, 'bold': True,
                'color': 0x172033, 'padding': 0, 'valign': 'CENTER',
            }
            style.update(title_style or {})
            if 'title' in result._slots:
                result.add_text('title', title, slot='title', style=style)
            else:
                result.add_text('title', title, box=(0.7, 0.5, 11.93, 0.72), style=style)
        return result

    def slides(self):
        result = []
        for index, page in enumerate(self._logical_pages):
            texts = []
            for shape_index in range(page.getCount()):
                value = str(getattr(page.getByIndex(shape_index), 'String', '') or '').strip()
                if value:
                    texts.append(value[:120])
            result.append({'index': index + 1, 'name': str(getattr(page, 'Name', '') or ''), 'text': texts})
        return result

    def select_slide(self, element_id, index=None, name=None, text=None, layout='blank'):
        matches = []
        for page_index, page in enumerate(self._logical_pages):
            if index is not None and page_index + 1 != int(index):
                continue
            if name is not None and str(getattr(page, 'Name', '') or '') != str(name):
                continue
            if text is not None:
                page_text = '\n'.join(str(getattr(page.getByIndex(i), 'String', '') or '') for i in range(page.getCount()))
                if str(text) not in page_text:
                    continue
            matches.append((page_index, page))
        if len(matches) != 1:
            raise ValueError(f'Presentation slide selector matched {len(matches)} slides; provide one exact index/name/text selector.')
        page_index, page = matches[0]
        self.job.register_element(element_id, 'slide', page, {'slide': page_index + 1}, force_artifact_name=True)
        return PresentationSlide(self, page, element_id, layout=layout)

    def remove_slide(self, index):
        resolved = int(index) - 1
        if resolved < 0 or resolved >= len(self._logical_pages):
            raise ValueError(f'Presentation slide index {index!r} is outside 1-{len(self._logical_pages)}.')
        page = self._logical_pages.pop(resolved)
        page_name = str(getattr(page, 'Name', '') or '')
        page_record = next((
            record for record in self.job.element_records.values()
            if record.get('kind') == 'slide' and record.get('artifactName') == page_name
        ), None)
        if page_record:
            page_element_id = str(page_record.get('elementId') or '')
            for registered_id in list(self.job.element_records):
                if registered_id == page_element_id or registered_id.startswith(page_element_id + '/'):
                    self.job.element_records.pop(registered_id, None)
        self._component.DrawPages.remove(page)
        return self

    def move_slide(self, from_index, to_index):
        source_index, target_index = int(from_index) - 1, int(to_index) - 1
        if min(source_index, target_index) < 0 or max(source_index, target_index) >= len(self._logical_pages):
            raise ValueError(f'Presentation move indices must stay within 1-{len(self._logical_pages)}.')
        if source_index == target_index:
            return self
        page = self._logical_pages.pop(source_index)
        self._logical_pages.insert(target_index, page)
        return self

    def duplicate_slide(self, element_id, index):
        source = self.select_slide(f'{element_id}/source', index=index)
        page = self._component.duplicate(source._page)
        source_index = self._logical_pages.index(source._page)
        self._logical_pages.insert(source_index + 1, page)
        self.job.register_element(element_id, 'slide', page, {'slide': self._page_index(page)}, force_artifact_name=True)
        return PresentationSlide(self, page, element_id, layout='blank')

    def set_doc_info(self, title=None, subject=None, author=None, description=None, keywords=None):
        properties = self._component.DocumentProperties
        if title is not None:
            properties.Title = str(title)
        if subject is not None:
            properties.Subject = str(subject)
        if author is not None:
            properties.Author = str(author)
        if description is not None:
            properties.Description = str(description)
        if keywords is not None:
            properties.Keywords = tuple(str(value) for value in keywords)
        self.job.record_feature('documentProperties')
        return self

    def feature(self, feature_name, element_id, slide=None, **params):
        """Apply a versioned presentation recipe without exposing UNO objects."""
        name = str(feature_name or '').strip().lower()
        if name != 'presentation.transition@1':
            raise ValueError(
                f'Unsupported presentation feature recipe {feature_name!r}. '
                'Query the corresponding unoApi module and use one of its installed facade examples.'
            )
        if not isinstance(slide, PresentationSlide):
            raise ValueError('presentation.transition@1 requires the PresentationSlide returned by deck.slide().')
        effects = {
            'none': 'NONE',
            'fade': 'FADE_FROM_CENTER',
            'wipe': 'MOVE_FROM_RIGHT',
            'wipe-left': 'MOVE_FROM_RIGHT',
            'wipe-right': 'MOVE_FROM_LEFT',
            'wipe-up': 'MOVE_FROM_BOTTOM',
            'wipe-down': 'MOVE_FROM_TOP',
        }
        speeds = {'slow': 'SLOW', 'medium': 'MEDIUM', 'fast': 'FAST'}
        effect = str(params.get('effect', 'fade')).strip().lower().replace('_', '-')
        speed = str(params.get('speed', 'medium')).strip().lower()
        if effect not in effects:
            raise ValueError(f'Unsupported transition effect {effect!r}; expected one of {sorted(effects)}.')
        if speed not in speeds:
            raise ValueError(f'Unsupported transition speed {speed!r}; expected slow, medium, or fast.')
        slide._page.Effect = uno.Enum('com.sun.star.presentation.FadeEffect', effects[effect])
        slide._page.Speed = uno.Enum('com.sun.star.presentation.AnimationSpeed', speeds[speed])
        self.job.register_element(element_id, 'slide-transition', slide._page, {
            'slideId': slide.element_id, 'effect': effect, 'speed': speed,
        })
        self.job.record_feature('slideTransition')
        return slide

    def _add_shape(self, page, element_id, service, x, y, width, height, kind,
                   layout_role='content', allow_overlap=False):
        if min(int(x), int(y)) < 0 or int(width) <= 0 or int(height) <= 0:
            raise ValueError(
                'Presentation geometry requires non-negative position and positive size: '
                f'elementId={element_id!r}, x={int(x)}, y={int(y)}, width={int(width)}, height={int(height)}'
            )
        page_bounds = self.bounds()
        if int(x) + int(width) > int(page_bounds['width']) or int(y) + int(height) > int(page_bounds['height']):
            self.job.layout_issues.append({
                'code': 'PRESENTATION_GEOMETRY_INVALID', 'severity': 'error', 'elementId': str(element_id),
                **self.job._source_location(),
                'message': (
                    'Presentation geometry exceeds slide bounds: '
                    f'x={int(x)}, y={int(y)}, width={int(width)}, height={int(height)}, '
                    f'slideWidth={int(page_bounds["width"])}, slideHeight={int(page_bounds["height"])}'
                ),
            })
        page_name = str(getattr(page, 'Name', '') or '')
        page_record = next((item for item in self.job.element_records.values() if item.get('artifactName') == page_name), None)
        page_index = int((page_record or {}).get('locator', {}).get('slide') or self._page_index(page))
        role = str(layout_role or 'content').strip().lower()
        if role not in self._LAYOUT_ROLES:
            raise ValueError(f'Unknown presentation layout_role {layout_role!r}; expected one of {sorted(self._LAYOUT_ROLES)}.')
        if role == 'content' and not bool(allow_overlap):
            candidate = {'x': int(x), 'y': int(y), 'width': int(width), 'height': int(height), 'kind': str(kind)}
            for existing in self.job.element_records.values():
                locator = existing.get('locator') if isinstance(existing.get('locator'), dict) else {}
                layout = existing.get('layout') if isinstance(existing.get('layout'), dict) else {}
                if int(locator.get('slide') or 0) != page_index:
                    continue
                if str(layout.get('role') or 'content') != 'content' or bool(layout.get('allowOverlap')):
                    continue
                if not all(key in layout for key in ('x', 'y', 'width', 'height')):
                    continue
                overlap_width = max(0, min(candidate['x'] + candidate['width'], int(layout['x']) + int(layout['width'])) - max(candidate['x'], int(layout['x'])))
                overlap_height = max(0, min(candidate['y'] + candidate['height'], int(layout['y']) + int(layout['height'])) - max(candidate['y'], int(layout['y'])))
                if overlap_width < 120 or overlap_height < 120:
                    continue
                smaller = min(candidate['width'] * candidate['height'], int(layout['width']) * int(layout['height']))
                ratio = overlap_width * overlap_height / max(1, smaller)
                existing_kind = str(existing.get('kind') or '')
                threshold = 0.02 if kind == existing_kind == 'text' else (0.05 if kind == existing_kind == 'image' else 0.08)
                if ratio < threshold:
                    continue
                issue = {
                    'code': 'PRESENTATION_OVERLAP', 'severity': 'error',
                    'elementId': str(element_id),
                    'elementIds': [str(existing.get('elementId') or ''), str(element_id)],
                    **self.job._source_location(),
                    'message': (
                        f'Presentation content {element_id!r} overlaps existing {existing.get("elementId")!r} '
                        f'by {ratio:.0%} of the smaller box. Use another layout slot/box, shorten the text, '
                        'and allocate separate space for independently readable content. '
                        'Do not add allow_overlap or fade an image merely to bypass this error; '
                        'intentional layering must be justified by the design brief and inspected visually.'
                    ),
                }
                self.job.layout_issues.append(issue)
        shape = self._component.createInstance(service)
        shape.Position, shape.Size = point(int(x), int(y)), size(int(width), int(height))
        page.add(shape)
        # Newly authored drawing services may arrive with LibreOffice default
        # names (notably CaptionShape and MeasureShape). Always replace that
        # transient name with the stable artifact marker before serialization.
        record = self.job.register_element(
            element_id, kind, shape, {'slide': page_index, 'shape': int(page.getCount())},
            force_artifact_name=True,
        )
        record['layout'] = {
            'role': role,
            'allowOverlap': bool(allow_overlap),
            'x': int(x), 'y': int(y), 'width': int(width), 'height': int(height),
        }
        return shape

    def add_text(self, element_id, page, text, x, y, width, height, font_size=18, color=0x000000,
                 bold=False, italic=False, align='LEFT', font_name=None, fit='shrink', min_font_size=8,
                 padding=0, valign='TOP', layout_role='content', allow_overlap=False,
                 underline=False, strike=False, rotation=0, line_spacing=None, _unit=None):
        shape = self._add_shape(
            page, element_id, 'com.sun.star.drawing.TextShape', x, y, width, height, 'text',
            layout_role=layout_role, allow_overlap=allow_overlap,
        )
        # Let Impress measure wrapped text with its installed fonts, then lock
        # the authored box. This is more reliable than estimating CJK/Latin
        # glyph metrics in JavaScript and prevents exporter-side growth.
        requested_width, requested_height = int(width), int(height)
        shape.TextAutoGrowHeight = False
        shape.TextAutoGrowWidth = False
        shape.TextFitToSize = uno.Enum('com.sun.star.drawing.TextFitToSizeType', 'NONE')
        try:
            shape.TextMinimumFrameHeight = 0
            shape.TextMinimumFrameWidth = 0
            shape.TextMaximumFrameHeight = int(self.bounds()['height'])
            shape.TextMaximumFrameWidth = requested_width
        except Exception:
            pass
        inset = max(0, int(padding))
        for property_name in ('TextLeftDistance', 'TextRightDistance', 'TextUpperDistance', 'TextLowerDistance'):
            try:
                setattr(shape, property_name, inset)
            except Exception:
                pass
        try:
            vertical_aliases = {'MIDDLE': 'CENTER', 'CENTRE': 'CENTER'}
            vertical = vertical_aliases.get(str(valign).strip().upper(), str(valign).strip().upper())
            if vertical not in {'TOP', 'CENTER', 'BOTTOM'}:
                raise ValueError("Presentation text valign must be 'top', 'middle/center', or 'bottom'.")
            shape.TextVerticalAdjust = uno.Enum('com.sun.star.drawing.TextVerticalAdjust', vertical)
        except ValueError:
            raise
        except Exception as error:
            raise ValueError(f'LibreOffice could not apply text valign={valign!r}.') from error
        shape.String = str(text)
        cursor = shape.Text.createTextCursor()
        cursor.gotoEnd(True)
        # A new Impress text shape can still inherit a Latin-only Asian font
        # despite document style defaults. Set the new text's CJK family
        # explicitly; do not rewrite fonts on imported/selected shapes.
        if not font_name:
            cursor.CharFontNameAsian = _CJK_FONT
        self._format_text_shape(
            shape, font_size=font_size, color=color, bold=bold, italic=italic,
            underline=underline, strike=strike, align=align, font_name=font_name,
            rotation=rotation, line_spacing=line_spacing,
        )
        requested_font_size = max(1.0, float(font_size))
        minimum_font_size = max(1.0, float(min_font_size))
        if minimum_font_size > requested_font_size:
            raise ValueError(
                f'Presentation min_font_size={minimum_font_size:g} cannot exceed font_size={requested_font_size:g} '
                f'for elementId={element_id!r}.'
            )
        estimated_lines = presentation_text_line_count(text, requested_width, requested_font_size, inset)
        effective_line_spacing = 1.15 if line_spacing is None else float(line_spacing)
        estimated_height = presentation_text_height(requested_font_size, estimated_lines, inset, effective_line_spacing)
        minimum_lines = presentation_text_line_count(text, requested_width, minimum_font_size, inset)
        minimum_height = presentation_text_height(minimum_font_size, minimum_lines, inset, effective_line_spacing)
        shape.Position, shape.Size = point(int(x), int(y)), size(requested_width, requested_height)
        shape.TextAutoGrowHeight = True
        libreoffice_height = max(requested_height, int(getattr(shape.Size, 'Height', requested_height)))
        # Impress reports a renderer-dependent minimum TextShape frame height
        # (commonly 763/1163/1525 in 1/100 mm) even when the authored text fits.
        # It is not the rendered glyph height and must not override a successful
        # mixed-script measurement; doing so creates false overflow cascades.
        measured_height = estimated_height if estimated_height <= requested_height else max(estimated_height, libreoffice_height)
        fit_mode = str(fit or 'shrink').strip().lower()
        if fit_mode not in {'none', 'shrink'}:
            raise ValueError("Presentation text fit must be 'shrink' or 'none'.")
        if measured_height > requested_height:
            scale = requested_height / measured_height
            fitted_font_size = requested_font_size * scale
            tolerance = 0.75
            unreadable = fit_mode == 'none' or fitted_font_size + tolerance < minimum_font_size
            if unreadable:
                record = self.job.element_records.get(str(element_id), {})
                suggested_height = max(estimated_height, libreoffice_height)
                self.job.layout_issues.append({
                    'code': 'PRESENTATION_TEXT_OVERFLOW', 'severity': 'error', 'elementId': str(element_id),
                    'line': record.get('line'), 'column': record.get('column'),
                    'callLine': record.get('callLine'), 'locator': record.get('locator'),
                    'message': (
                        f'Text requires an estimated {fitted_font_size:.2f}pt font to fit '
                        f'{requested_width}x{requested_height} (1/100 mm), '
                        f'fit={fit_mode}, min_font_size={minimum_font_size:g}; requestedFontSize={requested_font_size:g}, '
                        f'estimatedLines={estimated_lines}, estimatedHeight={estimated_height}, '
                        f'minimumHeight={minimum_height}, libreOfficeHeight={libreoffice_height}, '
                        f'effectiveMeasuredHeight={measured_height}, lineSpacing={effective_line_spacing:g}. '
                        f'At the current width and requested font, try a height of at least '
                        f'{math.ceil(suggested_height / 2540 * 100) / 100:.2f} inches '
                        f'({math.ceil(suggested_height / 100 * 10) / 10:.1f} mm). '
                        'Reallocate the surrounding layout too; do not expand into adjacent content. '
                        'Alternatively shorten the copy or split the layout; preserve the readable font size.'
                    ),
                })
            if fit_mode == 'shrink':
                shape.TextFitToSize = uno.Enum('com.sun.star.drawing.TextFitToSizeType', 'PROPORTIONAL')
        shape.TextAutoGrowHeight = False
        shape.Position, shape.Size = point(int(x), int(y)), size(requested_width, requested_height)
        self.job.record_feature('TextShape')
        return shape

    def add_text_box(self, element_id, page, text, box, font_size=18, color=0x000000,
                     bold=False, italic=False, align='LEFT', font_name=None, min_font_size=None,
                     padding=None, valign='TOP', layout_role='content', allow_overlap=False,
                     underline=False, strike=False, rotation=0, line_spacing=None):
        """Add text to a semantic rectangle, deriving a safe height when omitted."""
        if not isinstance(box, dict):
            raise ValueError('Presentation text box must be a dict containing x, y, and width.')
        missing = [key for key in ('x', 'y', 'width') if key not in box]
        if missing:
            raise ValueError(f'Presentation text box is missing {missing[0]!r}.')
        inset = self.mm(1) if padding is None else max(0, int(padding))
        minimum = float(font_size) if min_font_size is None else float(min_font_size)
        metrics = self.estimate_text_box(text, int(box['width']), font_size, inset, minimum)
        height = int(box.get('height', metrics['height']))
        return self.add_text(
            element_id, page, text, int(box['x']), int(box['y']), int(box['width']), height,
            font_size=font_size, color=color, bold=bold, italic=italic, align=align,
            font_name=font_name, fit='shrink', min_font_size=minimum, padding=inset,
            valign=valign, layout_role=layout_role, allow_overlap=allow_overlap,
            underline=underline, strike=strike, rotation=rotation, line_spacing=line_spacing,
        )

    def add_text_link(self, element_id, page, text, box, url=None, target_slide_id=None,
                      font_size=18, color=0x2563EB, bold=False, italic=False,
                      align='LEFT', font_name=None, min_font_size=None, padding=0,
                      valign='CENTER', layout_role='content', allow_overlap=False,
                      underline=True, strike=False, rotation=0, line_spacing=None):
        """Add clickable text for an external URL or a stable slide-element destination."""
        if bool(url) == bool(target_slide_id):
            raise ValueError('Presentation text link requires exactly one of url or target_slide_id.')
        destination = str(url or '').strip()
        feature = 'externalHyperlink'
        if target_slide_id:
            target = str(target_slide_id).strip()
            if not target or len(target) > 128 or re.search(r'[\x00-\x20\x7f]', target):
                raise ValueError('target_slide_id must be a stable facade element ID.')
            destination = '#wp_' + re.sub(r'[^A-Za-z0-9_]', '_', target)
            feature = 'internalSlideHyperlink'
        if not destination:
            raise ValueError('Presentation text link destination must be non-empty.')
        shape = self.add_text_box(
            element_id, page, text, box, font_size=font_size, color=color,
            bold=bold, italic=italic, align=align, font_name=font_name,
            min_font_size=min_font_size, padding=padding, valign=valign,
            layout_role=layout_role, allow_overlap=allow_overlap,
            underline=underline, strike=strike, rotation=rotation, line_spacing=line_spacing,
        )
        shape.String = ''
        cursor = shape.Text.createTextCursor()
        field = self._component.createInstance('com.sun.star.text.TextField.URL')
        field.URL = destination
        field.Representation = str(text)
        field.TargetFrame = '_blank' if feature == 'externalHyperlink' else ''
        shape.Text.insertTextContent(cursor, field, False)
        cursor = shape.Text.createTextCursor()
        cursor.gotoEnd(True)
        self._format_text_shape(
            shape, font_size=font_size, color=color, bold=bold, italic=italic,
            underline=underline, strike=strike, align=align, font_name=font_name,
            rotation=rotation, line_spacing=line_spacing,
        )
        self.job.record_feature(feature)
        return shape

    def add_card(self, element_id, page, box, title, body='', fill=0xFFFFFF, line=None,
                 accent=None, title_size=20, body_size=14, title_color=0x0F172A,
                 body_color=0x334155, padding=None, gap=None):
        """Add a collision-safe card with an optional accent and measured text."""
        area = self._rect(box)
        inset = self.mm(4) if padding is None else max(0, int(padding))
        spacing = self.mm(2) if gap is None else max(0, int(gap))
        self.add_shape(
            f'{element_id}/surface', page, **area, fill=fill, line=line,
            line_width=self.mm(0.3) if line is not None else 0,
            layout_role='container', allow_overlap=True,
        )
        accent_width = self.mm(1.2) if accent is not None else 0
        if accent is not None:
            self.add_shape(
                f'{element_id}/accent', page, area['x'], area['y'], accent_width, area['height'],
                fill=accent, layout_role='decoration', allow_overlap=True,
            )
        inner = {
            'x': area['x'] + inset + accent_width,
            'y': area['y'] + inset,
            'width': area['width'] - inset * 2 - accent_width,
            'height': area['height'] - inset * 2,
        }
        if inner['width'] <= 0 or inner['height'] <= 0:
            raise ValueError(f'Presentation card {element_id!r} padding leaves no usable content area.')
        title_metrics = self.estimate_text_box(title, inner['width'], title_size, 0, title_size)
        title_height = int(title_metrics['height'])
        if title_height > inner['height']:
            raise ValueError(f'Presentation card {element_id!r} title does not fit its content area.')
        title_box = {**inner, 'height': title_height}
        self.add_text_box(
            f'{element_id}/title', page, title, title_box, font_size=title_size,
            min_font_size=title_size, color=title_color, bold=True, padding=0,
        )
        body_shape = None
        if str(body or '').strip():
            body_box = {
                'x': inner['x'], 'y': inner['y'] + title_height + spacing,
                'width': inner['width'], 'height': inner['height'] - title_height - spacing,
            }
            if body_box['height'] <= 0:
                raise ValueError(f'Presentation card {element_id!r} has no room for body text.')
            body_shape = self.add_text_box(
                f'{element_id}/body', page, body, body_box, font_size=body_size,
                min_font_size=body_size, color=body_color, padding=0,
            )
        return {'surface': self.job.element_records.get(f'{element_id}/surface'), 'body': body_shape, 'box': area}

    def add_header(self, element_id, page, left='', center='', right='', height=None,
                   background=None, accent=None, font_size=10, color=0x64748B, padding=None,
                   left_url=None, center_url=None, right_url=None):
        """Add measured header chrome above the standard title slot."""
        bounds = self.bounds()
        inset = self.mm(2) if padding is None else max(0, int(padding))
        safe_height = max(self.mm(7), self.text_height(font_size, padding=inset)) if height is None else int(height)
        # Standard facade layouts begin at y=10 mm. Keep a deterministic gap
        # so an accent rule can never cut through a title as manual y=0.55 in
        # decorations commonly did.
        safe_height = min(safe_height, self.mm(8))
        side = self.mm(16)
        area = {'x': side, 'y': 0, 'width': int(bounds['width']) - side * 2, 'height': safe_height}
        if background is not None:
            self.add_shape(
                f'{element_id}/surface', page, 0, 0, int(bounds['width']), safe_height,
                fill=background, layout_role='background', allow_overlap=True,
            )
        text_height = safe_height - (self.mm(0.4) if accent is not None else 0)
        cells = self.grid(3, 1, box={**area, 'height': text_height}, gap=0)
        values = (
            (left, 'LEFT', 'left', left_url),
            (center, 'CENTER', 'center', center_url),
            (right, 'RIGHT', 'right', right_url),
        )
        self._add_three_zone_text(element_id, page, cells, values, font_size, color)
        if accent is not None:
            self.add_shape(
                f'{element_id}/accent', page, area['x'], safe_height - self.mm(0.4),
                area['width'], self.mm(0.4), fill=accent,
                layout_role='decoration', allow_overlap=True,
            )
        return area

    def add_footer(self, element_id, page, left='', center='', right='', height=None,
                   background=None, accent=None, font_size=10, color=0x64748B, padding=None,
                   left_url=None, center_url=None, right_url=None):
        """Add a measured three-zone footer aligned to the exact slide bounds."""
        bounds = self.bounds()
        inset = self.mm(2) if padding is None else max(0, int(padding))
        safe_height = max(self.mm(8), self.text_height(font_size, padding=inset)) if height is None else int(height)
        area = {'x': 0, 'y': int(bounds['height']) - safe_height, 'width': int(bounds['width']), 'height': safe_height}
        if background is not None:
            self.add_shape(
                f'{element_id}/surface', page, **area, fill=background,
                layout_role='background', allow_overlap=True,
            )
        if accent is not None:
            self.add_shape(
                f'{element_id}/accent', page, 0, area['y'], area['width'], self.mm(0.4),
                fill=accent, layout_role='decoration', allow_overlap=True,
            )
        cells = self.grid(3, 1, box={
            'x': inset, 'y': area['y'], 'width': area['width'] - inset * 2, 'height': area['height'],
        }, gap=0)
        values = (
            (left, 'LEFT', 'left', left_url),
            (center, 'CENTER', 'center', center_url),
            (right, 'RIGHT', 'right', right_url),
        )
        self._add_three_zone_text(element_id, page, cells, values, font_size, color)
        return area

    def _add_three_zone_text(self, element_id, page, cells, values, font_size, color):
        for cell, (value, align, suffix, link) in zip(cells, values):
            if not str(value or '').strip():
                continue
            text_options = {
                'font_size': font_size,
                'min_font_size': font_size,
                'color': color,
                'align': align,
                'padding': 0,
                'valign': 'CENTER',
            }
            if str(link or '').strip():
                self.add_text_link(
                    f'{element_id}/{suffix}', page, value, cell, url=link, **text_options,
                )
            else:
                self.add_text_box(
                    f'{element_id}/{suffix}', page, value, cell, **text_options,
                )

    def add_shape(self, element_id, page, x, y, width, height, service=None, shape_type='rectangle',
                  fill=None, line=None, line_width=0, fill_transparency=0,
                  layout_role='decoration', allow_overlap=True, rotation=0, gradient=None,
                  transparency=None, _unit=None):
        services = {
            'rectangle': 'com.sun.star.drawing.RectangleShape',
            'round-rectangle': 'com.sun.star.drawing.RectangleShape',
            'rounded-rectangle': 'com.sun.star.drawing.RectangleShape',
            'ellipse': 'com.sun.star.drawing.EllipseShape',
            'circle': 'com.sun.star.drawing.EllipseShape',
            'line': 'com.sun.star.drawing.LineShape',
            'caption': 'com.sun.star.drawing.CaptionShape',
            'measure': 'com.sun.star.drawing.MeasureShape',
        }
        custom_shape_types = {
            'diamond': 'diamond',
            'triangle': 'isosceles-triangle',
            'right-triangle': 'right-triangle',
            'parallelogram': 'parallelogram',
            'trapezoid': 'trapezoid',
            'pentagon': 'pentagon',
            'hexagon': 'hexagon',
            'octagon': 'octagon',
            'star': 'star5',
        }
        normalized_type = str(shape_type or 'rectangle').strip().lower().replace('_', '-')
        resolved_service = service or services.get(normalized_type) or (
            'com.sun.star.drawing.CustomShape' if normalized_type in custom_shape_types else None
        )
        if not resolved_service:
            supported = sorted(set(services) | set(custom_shape_types))
            raise ValueError(f'Unsupported presentation shape_type {shape_type!r}; expected one of {supported}.')
        if resolved_service in {
            'com.sun.star.drawing.CaptionShape',
            'com.sun.star.drawing.MeasureShape',
        }:
            # LibreOffice can author these native UNO services, but its PPTX
            # exporter drops both objects entirely. Exercise the requested
            # native capability in the live document and add one named,
            # editable DrawingML fallback at the same geometry so the saved
            # presentation remains visible, mappable, and repairable.
            native_shape = self._component.createInstance(resolved_service)
            native_shape.Position, native_shape.Size = (
                point(int(x), int(y)), size(int(width), int(height))
            )
            page.add(native_shape)
            self._apply_shape_style(
                native_shape, fill=fill, line=line, line_width=line_width,
                fill_transparency=fill_transparency, transparency=transparency,
                rotation=rotation,
            )
            if fill is not None and line is None:
                native_shape.LineStyle = uno.Enum('com.sun.star.drawing.LineStyle', 'NONE')
            if gradient:
                self._apply_shape_gradient(native_shape, gradient)

            fallback_service = (
                'com.sun.star.drawing.CustomShape'
                if resolved_service.endswith('CaptionShape')
                else 'com.sun.star.drawing.LineShape'
            )
            shape = self._add_shape(
                page, element_id, fallback_service, x, y, width, height, 'shape',
                layout_role=layout_role, allow_overlap=allow_overlap,
            )
            if resolved_service.endswith('CaptionShape'):
                shape.CustomShapeGeometry = (
                    property_value('Type', 'rectangular-callout'),
                )
            self._apply_shape_style(
                shape, fill=fill, line=line, line_width=line_width,
                fill_transparency=fill_transparency, transparency=transparency,
                rotation=rotation,
            )
            if fill is not None and line is None:
                shape.LineStyle = uno.Enum('com.sun.star.drawing.LineStyle', 'NONE')
            if gradient:
                self._apply_shape_gradient(shape, gradient)
            if resolved_service.endswith('MeasureShape'):
                for property_name in ('LineStartName', 'LineEndName'):
                    try:
                        setattr(shape, property_name, 'Arrow')
                    except Exception:
                        pass
            self.job.record_feature(
                'CaptionShape' if resolved_service.endswith('CaptionShape') else 'MeasureShape'
            )
            self.job.record_feature(
                'CustomShape' if fallback_service.endswith('CustomShape') else 'LineShape'
            )
            return shape
        shape = self._add_shape(
            page, element_id, resolved_service, x, y, width, height, 'shape',
            layout_role=layout_role, allow_overlap=allow_overlap,
        )
        if normalized_type in custom_shape_types and service is None:
            shape.CustomShapeGeometry = (
                property_value('Type', custom_shape_types[normalized_type]),
            )
        self._apply_shape_style(
            shape, fill=fill, line=line, line_width=line_width,
            fill_transparency=fill_transparency, transparency=transparency,
            rotation=rotation,
        )
        if fill is not None and line is None:
            shape.LineStyle = uno.Enum('com.sun.star.drawing.LineStyle', 'NONE')
        if gradient:
            self._apply_shape_gradient(shape, gradient)
        if normalized_type in ('round-rectangle', 'rounded-rectangle'):
            try:
                shape.CornerRadius = min(int(width), int(height)) // 8
            except Exception:
                pass
        shape_features = {
            'com.sun.star.drawing.RectangleShape': 'RectangleShape',
            'com.sun.star.drawing.EllipseShape': 'EllipseShape',
            'com.sun.star.drawing.CustomShape': 'CustomShape',
            'com.sun.star.drawing.CaptionShape': 'CaptionShape',
            'com.sun.star.drawing.LineShape': 'LineShape',
            'com.sun.star.drawing.MeasureShape': 'MeasureShape',
        }
        if resolved_service in shape_features:
            self.job.record_feature(shape_features[resolved_service])
        return shape

    def add_connector(self, element_id, page, x1, y1, x2, y2, color=0x64748B,
                      line_width=100, start_arrow=False, end_arrow=False,
                      start_arrow_width=None, end_arrow_width=None,
                      layout_role='decoration', allow_overlap=True):
        """Add a stable straight connector without exposing raw ConnectorShape lifecycle.

        LibreOffice ConnectorShape endpoints are unusually sensitive to mutation
        order and can dispose the remote bridge in large decks. A two-point
        PolyLineShape is stable across PPTX save/reopen, preserves rising versus
        falling direction, and supports optional native arrow heads.
        """
        x1, y1, x2, y2 = [int(value) for value in (x1, y1, x2, y2)]
        x, y = min(x1, x2), min(y1, y2)
        width, height = max(1, abs(x2 - x1)), max(1, abs(y2 - y1))
        shape = self._add_shape(
            page, element_id, 'com.sun.star.drawing.PolyLineShape', x, y, width, height, 'connector',
            layout_role=layout_role, allow_overlap=allow_overlap,
        )
        # Position+Size alone cannot encode whether a diagonal runs from the
        # lower-left to upper-right. LineShape therefore silently mirrored
        # every rising segment after PPTX export. Preserve the authored
        # endpoints as an explicit two-point polyline instead of reconstructing
        # direction from a directionless bounding box.
        shape.PolyPolygon = ((point(x1, y1), point(x2, y2)),)
        shape.LineStyle = uno.Enum('com.sun.star.drawing.LineStyle', 'SOLID')
        shape.LineColor = office_color(color, 'connector color')
        shape.LineWidth = max(0, int(line_width))
        if start_arrow:
            try:
                shape.LineStartName = 'Arrow'
                shape.LineStartWidth = max(
                    self.mm(1.6), min(self.mm(3.2), int(
                        start_arrow_width if start_arrow_width is not None else max(1, int(line_width)) * 3
                    ))
                )
                shape.LineStartCenter = False
            except Exception:
                pass
        if end_arrow:
            try:
                shape.LineEndName = 'Arrow'
                shape.LineEndWidth = max(
                    self.mm(1.6), min(self.mm(3.2), int(
                        end_arrow_width if end_arrow_width is not None else max(1, int(line_width)) * 3
                    ))
                )
                shape.LineEndCenter = False
            except Exception:
                pass
        # ConnectorShape is the verified facade capability. Its serialized
        # implementation is intentionally PolyLineShape because LibreOffice's
        # raw ConnectorShape can dispose the bridge in large presentations.
        self.job.record_feature('ConnectorShape')
        return shape

    def add_connector_between(self, element_id, page, source_box, target_box, color=0x64748B,
                              line_width=100, start_arrow=False, end_arrow=True, axis='auto',
                              source_inset=0, target_inset=0, start_arrow_width=None,
                              end_arrow_width=None, layout_role='decoration', allow_overlap=True):
        """Connect two allocated layout boxes without hand-authored endpoint arithmetic."""
        source, target = self._rect(source_box), self._rect(target_box)
        source_center = (
            source['x'] + source['width'] // 2,
            source['y'] + source['height'] // 2,
        )
        target_center = (
            target['x'] + target['width'] // 2,
            target['y'] + target['height'] // 2,
        )
        direction = str(axis or 'auto').strip().lower()
        if direction == 'auto':
            direction = 'horizontal' if abs(target_center[0] - source_center[0]) >= abs(target_center[1] - source_center[1]) else 'vertical'
        if direction not in {'horizontal', 'vertical'}:
            raise ValueError("Presentation connector axis must be 'auto', 'horizontal', or 'vertical'.")
        source_gap = max(0, int(source_inset))
        target_gap = max(0, int(target_inset))
        if direction == 'horizontal':
            if target_center[0] >= source_center[0]:
                x1, x2 = source['x'] + source['width'] - source_gap, target['x'] + target_gap
            else:
                x1, x2 = source['x'] + source_gap, target['x'] + target['width'] - target_gap
            y1, y2 = source_center[1], target_center[1]
        else:
            if target_center[1] >= source_center[1]:
                y1, y2 = source['y'] + source['height'] - source_gap, target['y'] + target_gap
            else:
                y1, y2 = source['y'] + source_gap, target['y'] + target['height'] - target_gap
            x1, x2 = source_center[0], target_center[0]
        return self.add_connector(
            element_id, page, x1, y1, x2, y2, color=color, line_width=line_width,
            start_arrow=start_arrow, end_arrow=end_arrow,
            start_arrow_width=start_arrow_width, end_arrow_width=end_arrow_width,
            layout_role=layout_role, allow_overlap=allow_overlap,
        )

    @staticmethod
    def _apply_image_metadata(shape, alt_text=None, title=None, source=None):
        if title is not None:
            try:
                shape.Title = str(title)
            except Exception:
                pass
        description_lines = []
        if title:
            description_lines.append(str(title).strip())
        if alt_text:
            description_lines.append(str(alt_text).strip())
        if source:
            description_lines.append(f'Source: {source}')
        description = '\n'.join(value for value in description_lines if value)
        if description:
            try:
                shape.Description = description
            except Exception:
                pass

    @staticmethod
    def _apply_image_crop(shape, crop=None):
        if not crop:
            return
        values = dict(crop)
        graphic_crop = uno.createUnoStruct('com.sun.star.text.GraphicCrop')
        graphic_crop.Left = int(values.get('left', 0))
        graphic_crop.Right = int(values.get('right', 0))
        graphic_crop.Top = int(values.get('top', 0))
        graphic_crop.Bottom = int(values.get('bottom', 0))
        shape.GraphicCrop = graphic_crop

    def add_image(self, element_id, page, asset_name, x, y, width, height,
                  layout_role='content', allow_overlap=False, crop=None,
                  rotation=0, transparency=0, alt_text=None, title=None,
                  source=None, _unit=None):
        shape = self._add_shape(
            page, element_id, 'com.sun.star.drawing.GraphicObjectShape', x, y, width, height, 'image',
            layout_role=layout_role, allow_overlap=allow_overlap,
        )
        shape.GraphicURL = uno.systemPathToFileUrl(str(self.job.asset_path(asset_name)))
        self._apply_image_crop(shape, crop)
        self._apply_image_metadata(shape, alt_text=alt_text, title=title, source=source)
        shape.RotateAngle = self._rotation(rotation)
        try:
            shape.Transparency = max(0, min(100, int(transparency)))
        except Exception:
            pass
        self.job.record_feature('GraphicObject')
        return shape

    def add_image_contain(self, element_id, page, asset_name, box, padding=0,
                          layout_role='content', allow_overlap=False,
                          crop=None, rotation=0, transparency=0,
                          alt_text=None, title=None, source=None):
        """Fit an image inside a semantic rectangle without changing its aspect ratio."""
        area = self._rect(box)
        inset = max(0, int(padding))
        available_width = area['width'] - inset * 2
        available_height = area['height'] - inset * 2
        if available_width <= 0 or available_height <= 0:
            raise ValueError(f'Presentation image {element_id!r} padding leaves no usable area.')
        asset_path = self.job.asset_path(asset_name)
        intrinsic = source_image_dimensions(asset_path)
        if intrinsic and float(intrinsic[0]) > 0 and float(intrinsic[1]) > 0:
            scale = min(available_width / float(intrinsic[0]), available_height / float(intrinsic[1]))
            width = max(1, int(round(float(intrinsic[0]) * scale)))
            height = max(1, int(round(float(intrinsic[1]) * scale)))
        else:
            width, height = available_width, available_height
        x = area['x'] + inset + (available_width - width) // 2
        y = area['y'] + inset + (available_height - height) // 2
        shape = self._add_shape(
            page, element_id, 'com.sun.star.drawing.GraphicObjectShape', x, y, width, height, 'image',
            layout_role=layout_role, allow_overlap=allow_overlap,
        )
        shape.GraphicURL = uno.systemPathToFileUrl(str(asset_path))
        self._apply_image_crop(shape, crop)
        self._apply_image_metadata(shape, alt_text=alt_text, title=title, source=source)
        shape.RotateAngle = self._rotation(rotation)
        try:
            shape.Transparency = max(0, min(100, int(transparency)))
        except Exception:
            pass
        self.job.record_feature('GraphicObject')
        return shape

    def add_native_table(self, element_id, page, box, rows, column_weights=None, header=True,
                         header_fill=0x0F172A, header_color=0xFFFFFF,
                         body_fill=0xF8FAFC, alternate_fill=0xFFFFFF,
                         body_color=0x1E293B, font_size=11, font_name=None,
                         first_column_align='LEFT'):
        """Add a native editable Impress TableShape with deterministic row/column sizing."""
        area = self._rect(box)
        self.job.record_feature('nativeEditableTable')
        matrix = [list(row) for row in rows]
        if not matrix or not matrix[0]:
            raise ValueError('Presentation table requires at least one row and one column.')
        column_count = len(matrix[0])
        if any(len(row) != column_count for row in matrix):
            raise ValueError('Presentation table rows must all contain the same number of columns.')
        weights = self._normalized_weights(column_count, column_weights)
        column_widths = [int(area['width'] * value / sum(weights)) for value in weights]
        column_widths[-1] += area['width'] - sum(column_widths)
        row_heights = [area['height'] // len(matrix)] * len(matrix)
        row_heights[-1] += area['height'] - sum(row_heights)
        shape = self._add_shape(
            page, element_id, 'com.sun.star.drawing.TableShape',
            area['x'], area['y'], area['width'], area['height'], 'table',
            layout_role='content', allow_overlap=False,
        )
        table = shape.Model
        if len(matrix) > 1:
            table.Rows.insertByIndex(0, len(matrix) - 1)
        if column_count > 1:
            table.Columns.insertByIndex(0, column_count - 1)
        for index, row_height in enumerate(row_heights):
            table.Rows.getByIndex(index).Size = int(row_height)
        for index, column_width in enumerate(column_widths):
            table.Columns.getByIndex(index).Size = int(column_width)
        for row_index, values in enumerate(matrix):
            for column_index, value in enumerate(values):
                cell = table.getCellByPosition(column_index, row_index)
                cell.String = '' if value is None else str(value)
                is_header = bool(header) and row_index == 0
                try:
                    cell.FillColor = office_color(header_fill if is_header else (
                        body_fill if row_index % 2 else alternate_fill
                    ), 'table fill')
                except Exception:
                    pass
                cursor = cell.createTextCursor()
                cursor.gotoEnd(True)
                apply_text_font(cursor, font_name=font_name or _CJK_FONT, font_size=font_size, bold=is_header)
                cursor.CharColor = office_color(header_color if is_header else body_color, 'table text color')
                alignment = 'CENTER' if is_header or column_index > 0 else str(first_column_align).upper()
                cursor.ParaAdjust = uno.Enum('com.sun.star.style.ParagraphAdjust', alignment)
                try:
                    cell.TextVerticalAdjust = uno.Enum('com.sun.star.drawing.TextVerticalAdjust', 'CENTER')
                except Exception:
                    pass
        return shape

    @staticmethod
    def _chart_values(categories, values):
        labels = [str(value) for value in categories]
        numbers = [float(value) for value in values]
        if not labels or len(labels) != len(numbers):
            raise ValueError('Presentation chart categories and values must be non-empty and have equal length.')
        if any(not math.isfinite(value) for value in numbers):
            raise ValueError('Presentation chart values must be finite numbers.')
        return labels, numbers

    @staticmethod
    def _chart_palette(count, colors=None):
        defaults = [0x2563EB, 0x10B981, 0xF59E0B, 0x8B5CF6, 0xEC4899, 0x06B6D4, 0xEF4444]
        palette = [office_color(value, 'chart palette color') for value in (colors or defaults)]
        if not palette:
            raise ValueError('Presentation chart palette cannot be empty.')
        return [palette[index % len(palette)] for index in range(count)]

    @staticmethod
    def _chart_series(categories, values=None, series=None, series_name='Values'):
        labels = [str(value) for value in categories]
        if not labels:
            raise ValueError('Presentation chart categories must be non-empty.')
        source = series if series is not None else values
        if source is None:
            raise ValueError('Presentation chart requires values or series.')
        if isinstance(source, dict):
            items = [{'name': name, 'values': row} for name, row in source.items()]
        elif isinstance(source, (list, tuple)) and source and all(isinstance(value, (int, float)) for value in source):
            items = [{'name': series_name, 'values': source}]
        else:
            items = list(source)
        rows = []
        names = []
        for index, item in enumerate(items):
            if isinstance(item, dict):
                name = item.get('name', f'Series {index + 1}')
                row = item.get('values')
            elif isinstance(item, (list, tuple)) and len(item) == 2 and isinstance(item[0], str):
                name, row = item
            else:
                name, row = f'Series {index + 1}', item
            if not isinstance(row, (list, tuple)):
                raise ValueError(f'Presentation chart series {index + 1} must provide a values list.')
            numbers = [float(value) for value in row]
            if len(numbers) != len(labels):
                raise ValueError(
                    f'Presentation chart series {index + 1} has {len(numbers)} values; expected {len(labels)}.'
                )
            if any(not math.isfinite(value) for value in numbers):
                raise ValueError(f'Presentation chart series {index + 1} contains a non-finite number.')
            names.append(str(name))
            rows.append(tuple(numbers))
        if not rows:
            raise ValueError('Presentation chart requires at least one data series.')
        return labels, names, rows

    @staticmethod
    def _chart_role_data(diagram_service, categories, values=None, series=None, series_name='Values'):
        """Validate data roles before creating UNO objects; never infer X from labels."""
        family = diagram_service.rsplit('.', 1)[-1]
        if family not in ('XYDiagram', 'BubbleDiagram', 'StockDiagram'):
            return None

        def numbers(data, role):
            if not isinstance(data, (list, tuple)) or not data:
                raise ValueError(f'CHART_DATA_ROLE_INVALID: {family} {role} requires a non-empty numeric list.')
            if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in data):
                raise ValueError(f'CHART_DATA_ROLE_INVALID: {family} {role} must contain finite numbers, not nested lists or labels.')
            return tuple(float(v) for v in data)

        items = series
        if family == 'XYDiagram' and items is None:
            items = [{'name': series_name, 'x': categories, 'y': values}]
        if family == 'StockDiagram' and isinstance(items, (list, tuple)) and len(items) == 4 and all(isinstance(s, dict) and 'values' in s for s in items):
            # Legacy documented order is Open, High, Low, Close (not four independent series).
            items = [{'name': series_name, **dict(zip(('open', 'high', 'low', 'close'), (s['values'] for s in items)))}]
        if not isinstance(items, (list, tuple)) or not items:
            raise ValueError('CHART_DATA_ROLE_INVALID: use series=[{name, x:[...], y:[...]}] for scatter; add sizes:[...] for bubble; stock uses {name, open, high, low, close}.')
        groups, rows, names = [], [], []
        for index, item in enumerate(items):
            if not isinstance(item, dict):
                raise ValueError(f'CHART_DATA_ROLE_INVALID: series {index + 1} must be an object with named data roles.')
            if 'values' in item and any(key in item for key in ('x', 'y', 'sizes', 'open', 'high', 'low', 'close')):
                raise ValueError('CHART_DATA_ROLE_INVALID: choose named role arrays OR values point tuples, not both.')
            name = str(item.get('name') or series_name)
            if family == 'StockDiagram':
                roles = [('values-first', item.get('open')), ('values-max', item.get('high')),
                         ('values-min', item.get('low')), ('values-last', item.get('close'))]
            else:
                x, y, sizes = item.get('x'), item.get('y'), item.get('sizes')
                points = item.get('values')
                if x is None and y is None and isinstance(points, (list, tuple)) and points and isinstance(points[0], (list, tuple)):
                    width = 3 if family == 'BubbleDiagram' else 2
                    if any(not isinstance(p, (list, tuple)) or len(p) != width for p in points):
                        raise ValueError(f'CHART_DATA_ROLE_INVALID: {family} point tuples must each have {width} numbers.')
                    x, y = [p[0] for p in points], [p[1] for p in points]
                    if width == 3:
                        sizes = [p[2] for p in points]
                elif x is None and y is None and family == 'XYDiagram':
                    x, y = categories, points
                roles = [('values-x', x), ('values-y', y)]
                if family == 'BubbleDiagram':
                    roles.append(('values-size', sizes))
            parsed = [(role, numbers(data, f'series {index + 1} {role}')) for role, data in roles]
            lengths = {len(data) for _, data in parsed}
            if len(lengths) != 1:
                raise ValueError(f'CHART_DATA_ROLE_INVALID: series {index + 1} role arrays must have equal lengths; got {sorted(lengths)}.')
            if family == 'BubbleDiagram' and any(v <= 0 for v in parsed[2][1]):
                raise ValueError('CHART_DATA_ROLE_INVALID: bubble sizes must be positive; do not drop or flatten the size role.')
            if family == 'StockDiagram':
                if not isinstance(categories, (list, tuple)) or len(categories) != len(parsed[0][1]):
                    raise ValueError('CHART_DATA_ROLE_INVALID: stock categories must match the OHLC sample count.')
                for point_index, (opening, high, low, close) in enumerate(zip(*(data for _, data in parsed))):
                    if not low <= min(opening, close) <= max(opening, close) <= high:
                        raise ValueError(f'CHART_DATA_ROLE_INVALID: stock sample {point_index + 1} must satisfy low <= open/close <= high.')
            group = []
            for role, data in parsed:
                group.append((role, len(rows)))
                rows.append(data)
                label_role = 'values-size' if family == 'BubbleDiagram' else 'values-last' if family == 'StockDiagram' else 'values-y'
                names.append(name if role == label_role else f'{name} {role}')
            groups.append(group)
        count = max(map(len, rows))
        # Internal chart tables are rectangular. Missing samples remain NaN, never invented zeroes.
        rows = [row + (float('nan'),) * (count - len(row)) for row in rows]
        labels = [str(v) for v in categories] if family == 'StockDiagram' else [''] * count
        return labels, names, rows, groups

    def _add_native_chart(self, element_id, page, box, diagram_service, categories, values=None,
                          series=None, colors=None, font_size=12, show_legend=False,
                          series_name='Values', color_points=False, title=None,
                          x_axis_title=None, y_axis_title=None, show_values=False,
                          show_category_name=False, show_percent=False,
                          background=None, legend_position='right'):
        """Insert one native editable Impress chart with its own embedded data table."""
        area = self._rect(box)
        role_data = self._chart_role_data(diagram_service, categories, values, series, series_name)
        labels, series_names, rows = role_data[:3] if role_data else self._chart_series(
            categories, values=values, series=series, series_name=series_name,
        )
        page_bounds = self.bounds()
        if min(area['x'], area['y']) < 0 or area['width'] <= 0 or area['height'] <= 0:
            raise ValueError(
                'Presentation chart geometry requires non-negative position and positive size: '
                f'elementId={element_id!r}, x={area["x"]}, y={area["y"]}, '
                f'width={area["width"]}, height={area["height"]}'
            )
        if area['x'] + area['width'] > int(page_bounds['width']) or area['y'] + area['height'] > int(page_bounds['height']):
            self.job.layout_issues.append({
                'code': 'PRESENTATION_GEOMETRY_INVALID', 'severity': 'error', 'elementId': str(element_id),
                **self.job._source_location(),
                'message': (
                    'Presentation chart geometry exceeds slide bounds: '
                    f'x={area["x"]}, y={area["y"]}, width={area["width"]}, height={area["height"]}, '
                    f'slideWidth={int(page_bounds["width"])}, slideHeight={int(page_bounds["height"])}'
                ),
            })
        is_circular = diagram_service.endswith(('PieDiagram', 'DonutDiagram'))
        minimum_width = self.mm(120 if show_legend else 90)
        minimum_height = self.mm(72 if (title or x_axis_title or y_axis_title) else 56)
        if is_circular:
            minimum_width = self.mm(125 if show_legend else 90)
            minimum_height = self.mm(82 if (show_values or show_category_name or show_percent) else 65)
        if area['width'] < minimum_width or area['height'] < minimum_height:
            self.job.layout_issues.append({
                'code': 'PRESENTATION_CHART_BOX_TOO_SMALL', 'severity': 'error',
                'elementId': str(element_id), **self.job._source_location(),
                'message': (
                    f'Chart box {area["width"]}x{area["height"]} is too small for its title, axes, labels, and legend; '
                    f'use at least {minimum_width}x{minimum_height} (1/100 mm), or remove nonessential chart text.'
                ),
            })

        chart = self._component.createInstance('com.sun.star.drawing.OLE2Shape')
        chart.CLSID = '12DCAE26-281F-416F-A234-C3086127382E'
        chart.Position, chart.Size = point(area['x'], area['y']), size(area['width'], area['height'])
        page.add(chart)
        try:
            chart.FillStyle = uno.Enum('com.sun.star.drawing.FillStyle', 'NONE')
            chart.FillTransparence = 100
            chart.LineStyle = uno.Enum('com.sun.star.drawing.LineStyle', 'NONE')
        except Exception:
            pass
        page_name = str(getattr(page, 'Name', '') or '')
        page_record = next((item for item in self.job.element_records.values() if item.get('artifactName') == page_name), None)
        page_index = int((page_record or {}).get('locator', {}).get('slide') or 1)
        record = self.job.register_element(element_id, 'chart', chart, {'slide': page_index, 'shape': int(page.getCount())})
        record['layout'] = {**area, 'role': 'content', 'allowOverlap': False}
        record['chartTitle'] = str(title or '').strip()

        chart_document = chart.Model
        if chart_document is None:
            raise RuntimeError(f'LibreOffice did not initialize native chart {element_id!r}.')
        diagram = chart_document.createInstance(diagram_service)
        try:
            diagram.DataRowSource = uno.Enum('com.sun.star.chart.ChartDataRowSource', 'ROWS')
        except Exception:
            pass
        try:
            diagram.Dim3D = False
        except Exception:
            pass
        chart_document.setDiagram(diagram)
        # Installing a legacy Chart1 diagram may recreate its internal data
        # sequences. Populate the values and semantic descriptions afterwards;
        # otherwise LibreOffice exports a chart with numeric 1..N categories
        # even though setColumnDescriptions(...) was called successfully.
        data = chart_document.Data
        data.setData(tuple(rows))
        data.setRowDescriptions(tuple(series_names))
        data.setColumnDescriptions(tuple(labels))
        # setDiagram() resets Chart1's source orientation to columns. Reapply
        # ROWS after the data table exists so one authored series remains one
        # OOXML <c:ser> and the supplied labels become its <c:cat> cache.
        try:
            diagram.DataRowSource = uno.Enum('com.sun.star.chart.ChartDataRowSource', 'ROWS')
        except Exception:
            pass
        chart_document.HasLegend = bool(show_legend)
        if role_data:
            provider = chart_document.getDataProvider()
            chart_type = chart_document.getFirstDiagram().getCoordinateSystems()[0].getChartTypes()[0]
            native_series = []
            for group in role_data[3]:
                data_series = self.job.context.ServiceManager.createInstanceWithContext('com.sun.star.chart2.DataSeries', self.job.context)
                sequences = []
                for role, row_index in group:
                    sequence = provider.createDataSequenceByRangeRepresentation(str(row_index))
                    sequence.Role = role
                    labeled = self.job.context.ServiceManager.createInstanceWithContext('com.sun.star.chart2.data.LabeledDataSequence', self.job.context)
                    labeled.setValues(sequence)
                    if role == chart_type.getRoleOfSequenceForSeriesLabel():
                        labeled.setLabel(provider.createDataSequenceByRangeRepresentation(f'label {row_index}'))
                    sequences.append(labeled)
                data_series.setData(tuple(sequences))
                native_series.append(data_series)
            chart_type.setDataSeries(tuple(native_series))
            if diagram_service.endswith('StockDiagram'):
                chart_type.Japanese = True
                chart_type.ShowFirst = True
                chart_type.ShowHighLow = True
        chart_document.HasMainTitle = bool(str(title or '').strip())
        chart_document.HasSubTitle = False
        if chart_document.HasMainTitle:
            try:
                chart_document.Title.String = str(title)
            except Exception:
                pass
        for enabled_property, title_property, value in (
            ('HasXAxisTitle', 'XAxisTitle', x_axis_title),
            ('HasYAxisTitle', 'YAxisTitle', y_axis_title),
        ):
            enabled = bool(str(value or '').strip())
            for target in (diagram, chart_document):
                try:
                    setattr(target, enabled_property, enabled)
                    if enabled:
                        getattr(target, title_property).String = str(value)
                    break
                except Exception:
                    continue
        def style_chart_surface(target):
            try:
                target.LineStyle = uno.Enum('com.sun.star.drawing.LineStyle', 'NONE')
            except Exception:
                pass
            if background is None:
                try:
                    target.FillStyle = uno.Enum('com.sun.star.drawing.FillStyle', 'NONE')
                except Exception:
                    pass
                try:
                    target.FillTransparence = 100
                except Exception:
                    pass
            else:
                try:
                    target.FillStyle = uno.Enum('com.sun.star.drawing.FillStyle', 'SOLID')
                    target.FillColor = office_color(background, 'chart background')
                    target.FillTransparence = 0
                except Exception:
                    pass

        try:
            style_chart_surface(chart_document.Area)
        except Exception:
            pass
        if show_legend:
            normalized_legend_position = str(legend_position or 'right').strip().upper()
            if normalized_legend_position not in {'LEFT', 'RIGHT', 'TOP', 'BOTTOM'}:
                raise ValueError("Presentation chart legend_position must be left, right, top, or bottom.")
            try:
                chart_document.Legend.Alignment = uno.Enum(
                    'com.sun.star.chart.ChartLegendPosition', normalized_legend_position
                )
            except Exception:
                pass
            style_chart_surface(chart_document.Legend)
            try:
                apply_text_font(chart_document.Legend, font_name=_CJK_FONT, font_size=max(8, min(14, font_size)))
            except Exception:
                pass
        try:
            wall = diagram.Wall
            style_chart_surface(wall)
        except Exception:
            pass
        caption = 0
        for enabled, constant_name in (
            (show_values, 'VALUE'),
            (show_percent, 'PERCENT'),
            (show_category_name, 'TEXT'),
        ):
            if enabled:
                try:
                    caption |= int(uno.getConstantByName(f'com.sun.star.chart.ChartDataCaption.{constant_name}'))
                except Exception:
                    pass
        try:
            diagram.DataCaption = caption
        except Exception:
            pass
        for axis_getter in ('getXAxis', 'getYAxis'):
            try:
                axis = getattr(diagram, axis_getter)()
                apply_text_font(axis, font_name=_CJK_FONT, font_size=font_size)
            except Exception:
                pass
        for property_name, text_size in (
            ('Title', max(10, float(font_size) + 2)),
            ('XAxisTitle', max(9, float(font_size))),
            ('YAxisTitle', max(9, float(font_size))),
        ):
            # Chart1 title getters can CREATE a title even after HasMainTitle=False.
            if not {'Title': title, 'XAxisTitle': x_axis_title, 'YAxisTitle': y_axis_title}[property_name]:
                continue
            try:
                text_target = getattr(chart_document, property_name)
                if text_target is not None:
                    apply_text_font(text_target, font_name=_CJK_FONT, font_size=text_size)
            except Exception:
                pass
        series_palette = self._chart_palette(len(role_data[3]) if role_data else len(rows), colors)
        for row_index, series_color in enumerate(series_palette):
            try:
                row_properties = diagram.getDataRowProperties(row_index)
                row_properties.FillColor = office_color(series_color, 'chart series color')
                row_properties.LineColor = office_color(series_color, 'chart series color')
            except Exception:
                pass
        if color_points:
            point_palette = self._chart_palette(len(labels), colors)
            for index, point_color in enumerate(point_palette):
                try:
                    data_point = diagram.getDataPointProperties(index, 0)
                    data_point.FillColor = office_color(point_color, 'chart point color')
                    data_point.LineColor = office_color(point_color, 'chart point color')
                except Exception:
                    pass
        self.job.record_feature('nativeChart')
        return {
            'box': area, 'count': len(labels), 'seriesCount': len(rows), 'shape': chart,
            'document': chart_document, 'diagram': diagram,
        }

    def add_chart(self, element_id, page, box, chart_type, categories, values=None, series=None,
                  colors=None, font_size=12, show_legend=None, stacked=False,
                  percent=False, vertical=None, lines=True, symbols=None, dim3d=False,
                  color_by_point=None, series_name='Values', title=None,
                  x_axis_title=None, y_axis_title=None, show_values=None,
                  show_category_name=None, show_percent=None, background=None,
                  legend_position='right', alt_text=None,
                  x_axis_min=None, x_axis_max=None, y_axis_min=None, y_axis_max=None,
                  x_axis_scale='linear', y_axis_scale='linear', axis_position='outside',
                  series_transparency=None, line_width=1.5, font_name=None,
                  font_color=0x334155, grid_color=0xD9DEE2, gridlines=True):
        """Add any chart family natively supported by LibreOffice's UNO chart module."""
        aliases = {
            'area': 'AreaDiagram',
            'bar': 'BarDiagram', 'column': 'BarDiagram',
            'bubble': 'BubbleDiagram',
            'donut': 'DonutDiagram', 'doughnut': 'DonutDiagram',
            'filled-net': 'FilledNetDiagram', 'filled-radar': 'FilledNetDiagram',
            'line': 'LineDiagram',
            'net': 'NetDiagram', 'radar': 'NetDiagram',
            'pie': 'PieDiagram',
            'stock': 'StockDiagram',
            'xy': 'XYDiagram', 'scatter': 'XYDiagram',
        }
        normalized = str(chart_type).strip().lower().replace('_', '-')
        service_name = aliases.get(normalized)
        if service_name is None:
            supported = ', '.join(sorted(aliases))
            raise ValueError(f'Unsupported native presentation chart type {chart_type!r}. Supported types: {supported}.')
        if symbols is None:
            symbols = normalized in ('line', 'xy', 'scatter')
        if series_transparency is None:
            series_transparency = 45 if service_name == 'FilledNetDiagram' else 0
        if (isinstance(series_transparency, bool) or not isinstance(series_transparency, (int, float))
                or not math.isfinite(series_transparency) or not 0 <= series_transparency <= 100):
            raise ValueError('CHART_STYLE_INVALID: series_transparency must be 0..100 (0=opaque).')
        if not isinstance(line_width, (int, float)) or isinstance(line_width, bool) or not math.isfinite(line_width) or line_width < 0:
            raise ValueError('CHART_STYLE_INVALID: line_width must be a non-negative number in points.')
        if axis_position not in ('outside', 'zero'):
            raise ValueError("CHART_STYLE_INVALID: axis_position must be 'outside' or 'zero'.")
        for axis_name, scale in (('x', x_axis_scale), ('y', y_axis_scale)):
            if scale not in ('linear', 'log10'):
                raise ValueError(f"CHART_STYLE_INVALID: {axis_name}_axis_scale must be 'linear' or 'log10'.")
            if scale == 'log10' and service_name not in ('XYDiagram', 'BubbleDiagram'):
                raise ValueError('CHART_STYLE_INVALID: log10 scales currently require scatter or bubble numeric axes.')
            if scale == 'log10':
                data = self._chart_role_data(f'com.sun.star.chart.{service_name}', categories, values, series, series_name)
                role = 'values-x' if axis_name == 'x' else 'values-y'
                numbers = [v for group in data[3] for key, row in group if key == role for v in data[2][row] if math.isfinite(v)]
                if any(v <= 0 for v in numbers):
                    raise ValueError(f'CHART_DATA_ROLE_INVALID: {axis_name} log10 axis requires strictly positive data; use linear, do not alter the data.')
        for axis_name, minimum, maximum in (('x', x_axis_min, x_axis_max), ('y', y_axis_min, y_axis_max)):
            for value in (minimum, maximum):
                if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)):
                    raise ValueError(f'CHART_DATA_ROLE_INVALID: {axis_name}_axis_min/max must be finite numbers.')
            if minimum is not None and maximum is not None and minimum >= maximum:
                raise ValueError(f'CHART_DATA_ROLE_INVALID: {axis_name}_axis_min must be less than {axis_name}_axis_max.')
            scale = x_axis_scale if axis_name == 'x' else y_axis_scale
            if scale == 'log10' and any(value is not None and value <= 0 for value in (minimum, maximum)):
                raise ValueError(f'CHART_DATA_ROLE_INVALID: {axis_name} log10 bounds must be positive.')
        if show_legend is None:
            show_legend = series is not None or normalized in ('pie', 'donut', 'doughnut')
        color_points = normalized in ('pie', 'donut', 'doughnut') if color_by_point is None else bool(color_by_point)
        if show_percent is None:
            show_percent = bool(percent) or (normalized in ('pie', 'donut', 'doughnut') and bool(show_legend) and not (show_values or show_category_name))
        if show_values is None:
            # Dense families need an explicit opt-in; one value label per mark
            # is not a safe default for multiple lines, areas or radar polygons.
            point_count = len(categories or [])
            show_values = normalized in ('bar', 'column') and point_count <= 8 and len(series or [None]) == 1
        if show_category_name is None:
            show_category_name = normalized in ('pie', 'donut', 'doughnut') and not bool(show_legend) and not (show_values or show_percent)
        if normalized in ('pie', 'donut', 'doughnut'):
            crowded_labels = sum(bool(value) for value in (show_values, show_category_name, show_percent))
            if crowded_labels > 1:
                self.job.layout_issues.append({
                    'code': 'PRESENTATION_CHART_LABEL_DENSITY', 'severity': 'error',
                    'elementId': str(element_id), **self.job._source_location(),
                    'message': (
                        'Pie/donut labels request more than one of value, category name, and percent. '
                        'Use a legend plus percent-only labels, or category labels without a legend; combined labels clip at chart edges.'
                    ),
                })
        chart = self._add_native_chart(
            element_id, page, box, f'com.sun.star.chart.{service_name}', categories,
            values=values, series=series, colors=colors, font_size=font_size,
            show_legend=show_legend, series_name=series_name, color_points=color_points,
            title=title, x_axis_title=x_axis_title, y_axis_title=y_axis_title,
            show_values=bool(show_values), show_category_name=bool(show_category_name),
            show_percent=bool(show_percent), background=background,
            legend_position=legend_position,
        )
        try:
            if title:
                chart['shape'].Title = str(title)
            if alt_text:
                chart['shape'].Description = str(alt_text)
        except Exception:
            pass
        diagram = chart['diagram']
        for property_name, property_value in (
            ('Stacked', bool(stacked)), ('Percent', bool(percent)), ('Dim3D', bool(dim3d)),
        ):
            try:
                setattr(diagram, property_name, property_value)
            except Exception:
                pass
        if service_name == 'BarDiagram':
            try:
                # LibreOffice Chart1 names this property from the bar direction:
                # Vertical=True exports horizontal bars, while False exports columns.
                diagram.Vertical = bool(normalized == 'bar' if vertical is None else vertical)
            except Exception:
                pass
        if service_name in ('LineDiagram', 'XYDiagram'):
            try:
                diagram.Lines = bool(lines)
                diagram.SymbolType = uno.getConstantByName(
                    'com.sun.star.chart.ChartSymbolType.AUTO' if symbols else 'com.sun.star.chart.ChartSymbolType.NONE'
                )
            except Exception:
                pass
        # Chart1 scatter row styling addresses underlying X/Y rows rather than
        # plotted series. Apply the final palette through Chart2 after its
        # line/symbol template changes, so the supplied colors cannot shift.
        if service_name in ('XYDiagram', 'BubbleDiagram'):
            data_series = chart['document'].getFirstDiagram().getCoordinateSystems()[0].getChartTypes()[0].getDataSeries()
            for item, color in zip(data_series, self._chart_palette(len(data_series), colors)):
                item.Color = color
                item.BorderColor = color
                if service_name == 'XYDiagram':
                    symbol = item.Symbol
                    symbol.FillColor = color
                    symbol.BorderColor = color
                    item.Symbol = symbol
        horizontal = service_name == 'BarDiagram' and bool(normalized == 'bar' if vertical is None else vertical)
        # Public x/y titles and bounds refer to physical screen axes. UNO's
        # logical X axis remains categorical when a bar chart is rotated.
        if horizontal:
            for enabled, prop, value in (('HasXAxisTitle', 'XAxisTitle', y_axis_title), ('HasYAxisTitle', 'YAxisTitle', x_axis_title)):
                setattr(diagram, enabled, bool(value))
                if value:
                    getattr(diagram, prop).String = str(value)
        for getter, minimum, maximum in ((('getYAxis' if horizontal else 'getXAxis'), x_axis_min, x_axis_max),
                                          (('getXAxis' if horizontal else 'getYAxis'), y_axis_min, y_axis_max)):
            if minimum is None and maximum is None:
                continue
            if service_name in ('PieDiagram', 'DonutDiagram'):
                raise ValueError('CHART_DATA_ROLE_INVALID: pie/donut charts have no numeric axes.')
            axis = getattr(diagram, getter)()
            if minimum is not None:
                axis.AutoMin = False
                axis.Min = float(minimum)
            if maximum is not None:
                axis.AutoMax = False
                axis.Max = float(maximum)
        coordinate = chart['document'].getFirstDiagram().getCoordinateSystems()[0]
        for index, scale in enumerate((x_axis_scale, y_axis_scale)):
            if service_name in ('PieDiagram', 'DonutDiagram'):
                break
            axis = coordinate.getAxisByDimension(1 - index if horizontal else index, 0)
            if scale == 'log10':
                spec = axis.getScaleData()
                spec.Scaling = self.job.context.ServiceManager.createInstanceWithContext('com.sun.star.chart2.LogarithmicScaling', self.job.context)
                axis.setScaleData(spec)
            if service_name not in ('NetDiagram', 'FilledNetDiagram'):
                axis.CrossoverPosition = uno.Enum('com.sun.star.chart.ChartAxisPosition', 'START' if axis_position == 'outside' else 'ZERO')
                axis.LabelPosition = uno.Enum('com.sun.star.chart.ChartAxisLabelPosition', 'OUTSIDE_START' if axis_position == 'outside' else 'NEAR_AXIS')
            apply_text_font(axis, font_name=font_name or _CJK_FONT, font_size=font_size)
            axis.CharColor = office_color(font_color)
            axis.LineColor = office_color(grid_color)
            grid = axis.getGridProperties()
            grid.LineColor = office_color(grid_color)
            grid.LineWidth = 15
            grid.Show = bool(gridlines and index == 1)
        # Apply labels and marks after ALL Chart1 template operations. They can
        # otherwise be reset, or retain a default font/marker after export.
        for native_type in coordinate.getChartTypes():
            final_series = native_type.getDataSeries()
            final_palette = self._chart_palette(len(final_series), colors)
            for series_index, item in enumerate(final_series):
                label = uno.createUnoStruct('com.sun.star.chart2.DataPointLabel')
                label.ShowNumber = bool(show_values)
                label.ShowNumberInPercent = bool(show_percent)
                label.ShowCategoryName = bool(show_category_name)
                label.ShowLegendSymbol = False
                item.Label = label
                apply_text_font(item, font_name=font_name or _CJK_FONT, font_size=font_size)
                item.CharColor = office_color(font_color)
                item.Transparency = int(series_transparency)
                item.LineWidth = int(round(float(line_width) * POINT_TO_100TH_MM))
                if service_name in ('LineDiagram', 'XYDiagram', 'NetDiagram', 'FilledNetDiagram', 'StockDiagram'):
                    symbol = item.Symbol
                    enabled = bool(symbols and service_name != 'StockDiagram')
                    symbol.Style = uno.Enum('com.sun.star.chart2.SymbolStyle', 'STANDARD' if enabled else 'NONE')
                    if enabled:
                        # AUTO lets the exporter replace the authored color. Explicit
                        # native symbols preserve both palette and series distinction.
                        symbol.StandardSymbol = series_index % 8
                        symbol.FillColor = office_color(final_palette[series_index])
                        symbol.BorderColor = office_color(final_palette[series_index])
                        symbol.Size = size(300, 300)
                    item.Symbol = symbol
        # Chart1's HasMainTitle setter can recreate a default "main-title", even
        # when assigned True again. Enable it before restoring text/style and
        # never toggle it after formatting. Template operations above may reset it.
        chart['document'].HasMainTitle = bool(str(title or '').strip())
        if str(title or '').strip():
            chart['document'].Title.String = str(title)
        targets = []
        if show_legend:
            targets.append(chart['document'].Legend)
        if title:
            targets.append(chart['document'].Title)
        if x_axis_title:
            targets.append(diagram.YAxisTitle if horizontal else diagram.XAxisTitle)
        if y_axis_title:
            targets.append(diagram.XAxisTitle if horizontal else diagram.YAxisTitle)
        for target in targets:
            if target is not None:
                apply_text_font(target, font_name=font_name or _CJK_FONT, font_size=font_size)
                target.CharColor = office_color(font_color)
        self.job.ooxml_patches.setdefault('nativeChartStyle', {})[str(chart['shape'].Name)] = {
            'kind': normalized, 'showValues': bool(show_values),
        }
        chart['chartType'] = normalized
        return chart

    def add_bar_chart(self, element_id, page, box, categories, values, colors=None,
                      font_size=12, color=0x334155, baseline_color=0xCBD5E1,
                      value_format='{value:g}', series_name='Values', title=None,
                      x_axis_title=None, y_axis_title=None, show_values=True,
                      show_legend=False):
        """Add a native editable column chart backed by an embedded chart data table."""
        return self.add_chart(
            element_id, page, box, 'column', categories, values=values,
            colors=colors, font_size=font_size, vertical=False, color_by_point=colors is not None,
            series_name=series_name, title=title, x_axis_title=x_axis_title,
            y_axis_title=y_axis_title, show_values=show_values, show_legend=show_legend,
        )

    def add_line_chart(self, element_id, page, box, categories, values, color=0x2563EB,
                       point_fill=0xFFFFFF, label_color=0x334155, font_size=12,
                       value_format='{value:g}', series_name='Values', title=None,
                       x_axis_title=None, y_axis_title=None, show_values=True,
                       show_legend=False):
        """Add a native editable line chart backed by an embedded chart data table."""
        chart = self.add_chart(
            element_id, page, box, 'line', categories, values=values,
            colors=[color], font_size=font_size, lines=True, symbols=True,
            series_name=series_name, title=title, x_axis_title=x_axis_title,
            y_axis_title=y_axis_title, show_values=show_values, show_legend=show_legend,
        )
        diagram = chart['diagram']
        try:
            diagram.Lines = True
            diagram.SymbolType = uno.getConstantByName('com.sun.star.chart.ChartSymbolType.AUTO')
        except Exception:
            pass
        try:
            series = diagram.getDataRowProperties(0)
            series.LineColor = office_color(color, 'chart line color')
            series.FillColor = office_color(point_fill, 'chart point fill')
        except Exception:
            pass
        return chart

    def add_area_chart(self, element_id, page, box, categories, values=None, series=None,
                       colors=None, font_size=10, show_legend=None, stacked=False, percent=False):
        return self.add_chart(
            element_id, page, box, 'area', categories, values=values, series=series,
            colors=colors, font_size=font_size, show_legend=show_legend,
            stacked=stacked, percent=percent,
        )

    def add_pie_chart(self, element_id, page, box, labels, values, colors=None, font_size=10):
        names, numbers = self._chart_values(labels, values)
        if any(value < 0 for value in numbers) or sum(numbers) <= 0:
            raise ValueError('Presentation pie values must be non-negative and have a positive total.')
        return self.add_chart(
            element_id, page, box, 'pie', names, values=numbers,
            colors=colors, font_size=font_size, show_legend=True,
        )

    def add_scatter_chart(self, element_id, page, box, x_values, y_values=None, series=None,
                          colors=None, font_size=10, show_legend=None, lines=False, symbols=True):
        return self.add_chart(
            element_id, page, box, 'scatter', x_values, values=y_values, series=series,
            colors=colors, font_size=font_size, show_legend=show_legend,
            lines=lines, symbols=symbols,
        )

    def add_bubble_chart(self, element_id, page, box, categories, series,
                         colors=None, font_size=10, show_legend=True):
        return self.add_chart(
            element_id, page, box, 'bubble', categories, series=series,
            colors=colors, font_size=font_size, show_legend=show_legend,
        )

    def add_radar_chart(self, element_id, page, box, categories, values=None, series=None,
                        colors=None, font_size=10, show_legend=None, filled=False,
                        stacked=False, percent=False):
        return self.add_chart(
            element_id, page, box, 'filled-radar' if filled else 'radar', categories,
            values=values, series=series, colors=colors, font_size=font_size,
            show_legend=show_legend, stacked=stacked, percent=percent,
        )

    def add_stock_chart(self, element_id, page, box, categories, series,
                        colors=None, font_size=10, show_legend=True):
        return self.add_chart(
            element_id, page, box, 'stock', categories, series=series,
            colors=colors, font_size=font_size, show_legend=show_legend,
        )

    def add_donut_chart(self, element_id, page, box, labels, values, colors=None,
                        hole_fill=0xFFFFFF, label_color=0x334155, font_size=10,
                        center_text='', center_subtitle='', center_text_color=0x0F172A,
                        center_text_size=20, center_subtitle_size=9):
        """Add a native editable donut chart backed by an embedded chart data table."""
        names, numbers = self._chart_values(labels, values)
        if any(value < 0 for value in numbers) or sum(numbers) <= 0:
            raise ValueError('Presentation donut values must be non-negative and have a positive total.')
        chart = self.add_chart(
            element_id, page, box, 'donut', names, values=numbers,
            colors=colors, font_size=font_size, show_legend=True,
        )
        if str(center_text or '').strip() or str(center_subtitle or '').strip():
            area = chart['box']
            center_width = max(self.mm(18), int(area['width'] * 0.22))
            value_height = self.text_height(center_text_size)
            subtitle_height = self.text_height(center_subtitle_size)
            center_height = max(self.mm(14), value_height + subtitle_height)
            center_box = {
                'x': area['x'] + int(area['width'] * 0.28) - center_width // 2,
                'y': area['y'] + area['height'] // 2 - center_height // 2,
                'width': center_width,
                'height': center_height,
            }
            rows = self.stack(2, box=center_box, gap=0, weights=(value_height, subtitle_height))
            if str(center_text or '').strip():
                self.add_text_box(
                    f'{element_id}/center/value', page, center_text, rows[0],
                    font_size=center_text_size, min_font_size=center_text_size,
                    color=center_text_color, bold=True, align='CENTER', valign='BOTTOM',
                    padding=0, allow_overlap=True,
                )
            if str(center_subtitle or '').strip():
                self.add_text_box(
                    f'{element_id}/center/subtitle', page, center_subtitle, rows[1],
                    font_size=center_subtitle_size, min_font_size=center_subtitle_size,
                    color=label_color, align='CENTER', valign='TOP', padding=0,
                    allow_overlap=True,
                )
        return chart
    def add_timeline(self, element_id, page, box, events, colors=None,
                     title_size=14, body_size=10, text_color=0x334155,
                     max_items_per_row=6):
        """Lay out dense timelines in one or more readable alternating rows."""
        area = self._rect(box)
        items = []
        for event in events:
            if isinstance(event, dict):
                items.append((str(event.get('title', '')), str(event.get('body', ''))))
            elif isinstance(event, (list, tuple)) and len(event) >= 2:
                items.append((str(event[0]), str(event[1])))
            else:
                items.append((str(event), ''))
        if not items:
            raise ValueError('Presentation timeline requires at least one event.')
        palette = self._chart_palette(len(items), colors)
        per_row = max(2, int(max_items_per_row))
        row_count = int(math.ceil(len(items) / per_row))
        row_gap = min(self.mm(5), max(0, area['height'] // max(8, row_count * 8)))
        bands = self.stack(row_count, box=area, gap=row_gap)
        point_size = self.mm(3.2)
        planned_rows = []
        required_band_height = 0
        overflowing_events = []
        for row_index, band in enumerate(bands):
            start = row_index * per_row
            row_items = items[start:start + per_row]
            row_palette = palette[start:start + len(row_items)]
            track_gap = min(self.mm(2), max(0, band['width'] // max(8, len(row_items) * 8)))
            tracks = self.grid(len(row_items), 1, box=band, gap=track_gap)
            measurements = []
            for local_index, ((title, body), track) in enumerate(zip(row_items, tracks)):
                title_height = self.estimate_text_box(title, track['width'], title_size, 0, title_size)['height']
                body_height = self.estimate_text_box(body, track['width'], body_size, 0, body_size)['height'] if body else 0
                needed = title_height + body_height + (self.mm(1) if body else 0)
                required_band_height = max(required_band_height, 2 * (needed + self.mm(4)))
                if band['height'] // 2 - self.mm(4) < needed:
                    overflowing_events.append(start + local_index + 1)
                measurements.append((title_height, body_height))
            planned_rows.append((band, row_items, row_palette, tracks, measurements))
        if overflowing_events:
            # Preflight every event before adding shapes. Use the maximum possible
            # inter-row gap so the suggestion remains safe after height increases.
            minimum_height = required_band_height * row_count + self.mm(5) * (row_count - 1) + row_count
            raise ValueError(
                f'Presentation timeline {element_id!r} has insufficient height for events {overflowing_events}. '
                f'At the current width, font sizes and {per_row} items per row, reserve height >= '
                f'{math.ceil(minimum_height / 25.4) / 100:.2f} in ({math.ceil(minimum_height / 10) / 10:.1f} mm); '
                f'current height={area["height"] / 2540:.2f} in. This bound accounts for all events. '
                'Allocate that space without overlapping neighboring content, or shorten event text. '
                'Changing items per row changes both track width and row count; do not assume it reduces total height.'
            )
        for row_index, (band, row_items, row_palette, tracks, measurements) in enumerate(planned_rows):
            start = row_index * per_row
            axis_y = band['y'] + band['height'] // 2
            self.add_connector(
                f'{element_id}/row-{row_index + 1}/axis', page, band['x'], axis_y,
                band['x'] + band['width'], axis_y,
                color=0x94A3B8, line_width=self.mm(0.5),
            )
            for local_index, ((title, body), track, event_color) in enumerate(zip(row_items, tracks, row_palette)):
                index = start + local_index
                center_x = track['x'] + track['width'] // 2
                self.add_shape(
                    f'{element_id}/event-{index + 1}/point', page,
                    center_x - point_size // 2, axis_y - point_size // 2,
                    point_size, point_size, service='com.sun.star.drawing.EllipseShape',
                    fill=event_color, layout_role='decoration', allow_overlap=True,
                )
                top = local_index % 2 == 0
                event_box = {
                    'x': track['x'],
                    'y': band['y'] if top else axis_y + self.mm(4),
                    'width': track['width'],
                    'height': band['height'] // 2 - self.mm(4),
                }
                title_height, body_height = measurements[local_index]
                text_gap = self.mm(1) if body else 0
                text_rows = self.stack(
                    2 if body else 1,
                    box=event_box,
                    gap=text_gap,
                    weights=(title_height, body_height) if body else (title_height,),
                )
                stem_end_y = event_box['y'] + event_box['height'] if top else event_box['y']
                self.add_connector(
                    f'{element_id}/event-{index + 1}/stem', page,
                    center_x, axis_y, center_x, stem_end_y,
                    color=event_color, line_width=self.mm(0.35),
                )
                self.add_text_box(
                    f'{element_id}/event-{index + 1}/title', page, title, text_rows[0],
                    font_size=title_size, min_font_size=title_size, color=event_color,
                    bold=True, align='CENTER', valign='CENTER', padding=0,
                )
                if body:
                    self.add_text_box(
                        f'{element_id}/event-{index + 1}/body', page, body, text_rows[1],
                        font_size=body_size, min_font_size=body_size, color=text_color,
                        align='CENTER', valign='CENTER', padding=0,
                    )
        return {'box': area, 'count': len(items), 'rows': row_count}

    def set_notes(self, element_id, slide, text):
        if not isinstance(slide, PresentationSlide):
            raise ValueError('set_notes requires a PresentationSlide.')
        notes = slide._page.getNotesPage()
        target = None
        for index in range(notes.getCount()):
            candidate = notes.getByIndex(index)
            if hasattr(candidate, 'String'):
                target = candidate
                if not str(getattr(candidate, 'String', '') or '').strip():
                    break
        if target is None:
            target = self._component.createInstance('com.sun.star.drawing.TextShape')
            target.Position = point(self.mm(18), self.mm(24))
            target.Size = size(self.mm(220), self.mm(120))
            notes.add(target)
        target.String = str(text)
        self.job.register_element(element_id, 'speaker-notes', target, {
            'slide': self._page_index(slide._page), 'notes': True,
        })
        self.job.record_feature('speakerNotes')
        return slide

    def add_field(self, element_id, slide, field_type, box, style=None):
        if not isinstance(slide, PresentationSlide):
            raise ValueError('add_field requires a PresentationSlide.')
        services = {
            'page-number': 'com.sun.star.text.TextField.PageNumber',
            'date': 'com.sun.star.text.TextField.DateTime',
            'header': 'com.sun.star.presentation.TextField.Header',
            'footer': 'com.sun.star.presentation.TextField.Footer',
        }
        key = str(field_type).strip().lower().replace('_', '-')
        if key not in services:
            raise ValueError(f'Unsupported presentation field {field_type!r}; expected one of {sorted(services)}.')
        options = self._normalized_text_options(style or {})
        shape = self.add_text_box(element_id, slide._page, '', box, **options)
        field = self._component.createInstance(services[key])
        cursor = shape.Text.createTextCursor()
        shape.Text.insertTextContent(cursor, field, False)
        self._format_text_shape(shape, **options)
        self.job.record_feature('presentationField')
        return shape

    def add_comment(self, element_id, slide, text, author='User'):
        if not isinstance(slide, PresentationSlide):
            raise ValueError('add_comment requires a PresentationSlide.')
        try:
            annotation = slide._page.createAndInsertAnnotation()
            annotation.Author = str(author)
            annotation.TextRange.String = str(text)
        except Exception as error:
            raise ValueError('This LibreOffice build cannot create native slide comments.') from error
        self.job.register_element(element_id, 'slide-comment', annotation, {
            'slide': self._page_index(slide._page),
        })
        self.job.record_feature('slideComment')
        return slide

    def add_media(self, element_id, slide, asset_name, box, media_type='auto', poster_asset=None,
                  autoplay=False, loop=False, mute=False):
        if not isinstance(slide, PresentationSlide):
            raise ValueError('add_media requires a PresentationSlide.')
        area = self._rect(box)
        shape = self._add_shape(
            slide._page, element_id, 'com.sun.star.presentation.MediaShape',
            area['x'], area['y'], area['width'], area['height'], 'media',
            layout_role='content', allow_overlap=False,
        )
        source = self.job.asset_path(asset_name)
        shape.MediaURL = uno.systemPathToFileUrl(str(source))
        for property_name, value in (
            ('Loop', bool(loop)), ('Mute', bool(mute)), ('PlayFull', bool(autoplay)),
        ):
            try:
                setattr(shape, property_name, value)
            except Exception:
                pass
        if poster_asset:
            try:
                shape.GraphicURL = uno.systemPathToFileUrl(str(self.job.asset_path(poster_asset)))
            except Exception:
                pass
        self.job.record_feature('embeddedMedia')
        return shape

    def set_animation(self, shape, effect='fade', speed='medium'):
        if not isinstance(shape, PresentationShape):
            raise ValueError('set_animation requires a PresentationShape returned by slide.select_shape().')
        effects = {
            'appear': 'APPEAR', 'fade': 'FADE_FROM_CENTER',
            'fly-left': 'MOVE_FROM_LEFT', 'fly-right': 'MOVE_FROM_RIGHT',
            'fly-up': 'MOVE_FROM_TOP', 'fly-down': 'MOVE_FROM_BOTTOM',
        }
        normalized = str(effect).strip().lower().replace('_', '-')
        if normalized not in effects:
            raise ValueError(f'Unsupported animation effect {effect!r}; expected one of {sorted(effects)}.')
        try:
            shape._shape.Effect = uno.Enum('com.sun.star.presentation.AnimationEffect', effects[normalized])
            shape._shape.Speed = uno.Enum('com.sun.star.presentation.AnimationSpeed', str(speed).strip().upper())
        except Exception as error:
            raise ValueError('This LibreOffice build cannot attach the requested native shape animation.') from error
        record = self.job.element_records.get(shape.element_id) or {}
        self.job.ooxml_patches.setdefault('shapeAnimations', []).append({
            'slide': self._page_index(shape.slide._page),
            'artifactName': record.get('artifactName'),
            'effect': normalized,
            'speed': str(speed).strip().lower(),
        })
        self.job.record_feature('shapeAnimation')
        return shape

    def masters(self):
        result = []
        for index in range(self._component.MasterPages.Count):
            master = self._component.MasterPages.getByIndex(index)
            result.append({'index': index + 1, 'name': str(getattr(master, 'Name', '') or '')})
        return result

    def apply_master(self, slide, index=None, name=None):
        if not isinstance(slide, PresentationSlide):
            raise ValueError('apply_master requires a PresentationSlide.')
        matches = []
        for master_index in range(self._component.MasterPages.Count):
            master = self._component.MasterPages.getByIndex(master_index)
            if index is not None and master_index + 1 != int(index):
                continue
            if name is not None and str(getattr(master, 'Name', '') or '') != str(name):
                continue
            matches.append(master)
        if len(matches) != 1:
            raise ValueError(
                f'PRESENTATION_MASTER_SELECTOR_INVALID: selector matched {len(matches)} masters. '
                f'Master indices are ONE-based (1..{self._component.MasterPages.Count}); '
                f'available masters: {self.masters()!r}. Copy an exact index/name from deck.masters(); '
                'zero matches does not mean master support is unavailable.'
            )
        slide._page.MasterPage = matches[0]
        self.job.record_feature('masterLayoutAssignment')
        return slide

    def add_custom_show(self, name, slide_indices):
        try:
            shows = self._component.CustomPresentations
            show = shows.createInstance()
            for position, slide_index in enumerate(slide_indices):
                resolved = int(slide_index) - 1
                if resolved < 0 or resolved >= self._component.DrawPages.Count:
                    raise ValueError(
                        f'PRESENTATION_CUSTOM_SHOW_INDEX_INVALID: slide index {slide_index!r} is outside '
                        f'1..{self._component.DrawPages.Count}. Custom show indices are ONE-based; '
                        'use [1] for the first slide. Correct the indices instead of removing the custom show.'
                    )
                show.insertByIndex(position, self._component.DrawPages.getByIndex(resolved))
            if shows.hasByName(str(name)):
                shows.replaceByName(str(name), show)
            else:
                shows.insertByName(str(name), show)
        except ValueError:
            raise
        except Exception as error:
            raise ValueError('This LibreOffice build cannot create a native custom presentation.') from error
        self.job.record_feature('customShow')
        return self

    @staticmethod
    def unsupported(feature_name):
        raise ValueError(
            f'Office capability {feature_name!r} is unsupported for authored UNO generation. '
            'Do not emulate it with raw UNO or shapes.'
        )

    def save(self):
        if self.job.layout_issues:
            raise ValueError('__WEBPILOT_LAYOUT_DIAGNOSTICS__' + json.dumps(self.job.layout_issues, ensure_ascii=False))
        physical = [
            self._component.DrawPages.getByIndex(index)
            for index in range(self._component.DrawPages.Count)
        ]
        order = [physical.index(page) + 1 for page in self._logical_pages]
        if order != list(range(1, len(order) + 1)):
            self.job.ooxml_patches['slideOrder'] = order
        save_document(self._component, self.job)
        return self

    def close(self):
        self.job.close(self._component)


class SpreadsheetSheet:
    """Excel-like worksheet facade using A1 addresses instead of raw UNO cells."""

    def __init__(self, workbook, sheet, element_id):
        self.workbook = workbook
        self._sheet = sheet
        self.element_id = str(element_id)

    def _id(self, value):
        child = str(value or '').strip().strip('/')
        if not child:
            raise ValueError('Worksheet child elementId must be non-empty.')
        return f'{self.element_id}/{child}'

    @staticmethod
    def _cell_position(address):
        match = re.fullmatch(r'\$?([A-Za-z]+)\$?([1-9][0-9]*)', str(address or '').strip())
        if not match:
            raise ValueError(f'Invalid A1 cell address {address!r}.')
        column = 0
        for character in match.group(1).upper():
            column = column * 26 + ord(character) - 64
        return column - 1, int(match.group(2)) - 1

    def set_cell(self, element_id, address, value, style=None):
        column, row = self._cell_position(address)
        cell = self.workbook.set_cell(self._id(element_id), self._sheet, column, row, value)
        if style:
            self.workbook.format_range(
                f'{self._id(element_id)}/style', self._sheet, str(address), **dict(style),
            )
        return cell

    def set_range(self, element_id, start, rows, style=None):
        column, row = self._cell_position(start)
        result = self.workbook.set_range(self._id(element_id), self._sheet, column, row, rows)
        if style and rows and any(rows):
            width = max(len(values) for values in rows)
            end_column = self.workbook._column_name(column + width - 1)
            end_row = row + len(rows)
            self.workbook.format_range(
                f'{self._id(element_id)}/style', self._sheet,
                f'{self.workbook._column_name(column)}{row + 1}:{end_column}{end_row}', **dict(style),
            )
        return result

    def add_table(self, element_id, start, rows, header=True, style=None):
        """Create a styled data range. This is not an OOXML structured table."""
        data = [list(row) for row in rows]
        if not data or not data[0]:
            raise ValueError('Worksheet table requires at least one row and one column.')
        self.set_range(element_id, start, data, style=style)
        if header:
            column, row = self._cell_position(start)
            end_column = self.workbook._column_name(column + len(data[0]) - 1)
            header_range = f'{self.workbook._column_name(column)}{row + 1}:{end_column}{row + 1}'
            self.workbook.format_range(
                f'{self._id(element_id)}/header', self._sheet, header_range,
                bold=True, color=0xFFFFFF, background=0x1F4E78,
                horizontal='CENTER', vertical='CENTER', wrap=True,
            )
        return self

    def add_database_table(self, element_id, start, rows, header=True, style=None, auto_filter=True):
        """Create a Calc database range with native sort/filter semantics."""
        self.add_table(element_id, start, rows, header=header, style=style)
        column, row = self._cell_position(start)
        width = len(rows[0])
        end_column = self.workbook._column_name(column + width - 1)
        end_row = row + len(rows)
        return self.workbook.set_auto_filter(
            self._id(f'{element_id}/database-range'), self._sheet,
            f'{self.workbook._column_name(column)}{row + 1}:{end_column}{end_row}',
            enabled=auto_filter,
        )

    def format(self, element_id, cell_range, **style):
        return self.workbook.format_range(self._id(element_id), self._sheet, cell_range, **style)

    def merge(self, element_id, cell_range):
        return self.workbook.merge_cells(self._id(element_id), self._sheet, cell_range)

    def freeze(self, element_id='freeze-panes', rows=1, columns=0):
        return self.workbook.freeze_panes(self._id(element_id), self._sheet, rows=rows, columns=columns)

    def column_width(self, element_id, column, width):
        return self.workbook.set_column_width(self._id(element_id), self._sheet, column, width)

    def row_height(self, element_id, row, height):
        return self.workbook.set_row_height(self._id(element_id), self._sheet, row, height)

    def feature(self, feature_name, element_id, **params):
        return self.workbook.feature(feature_name, self._id(element_id), sheet=self, **params)

    def rename(self, new_name):
        self.workbook.rename_sheet(self, new_name)
        return self

    def hide(self, hidden=True):
        self._sheet.IsVisible = not bool(hidden)
        self.workbook.job.record_feature('hiddenSheet')
        return self

    def protect(self, password=''):
        if password:
            self._sheet.protect(str(password))
        else:
            self._sheet.protect('')
        self.workbook.job.record_feature('sheetProtection')
        return self

    def unprotect(self, password=''):
        self._sheet.unprotect(str(password))
        return self

    def add_comment(self, element_id, address, text, author='User'):
        return self.workbook.add_comment(self._id(element_id), self._sheet, address, text, author=author)

    def add_hyperlink(self, element_id, address, text, url):
        return self.workbook.add_hyperlink(self._id(element_id), self._sheet, address, text, url)

    def data_validation(self, element_id, cell_range, validation_type, **options):
        return self.workbook.set_data_validation(
            self._id(element_id), self._sheet, cell_range, validation_type, **options,
        )

    def conditional_format(self, element_id, cell_range, operator, formula, **style):
        return self.workbook.add_conditional_format(
            self._id(element_id), self._sheet, cell_range, operator, formula, **style,
        )

    def auto_filter(self, element_id, cell_range, enabled=True):
        return self.workbook.set_auto_filter(self._id(element_id), self._sheet, cell_range, enabled=enabled)

    def sort(self, element_id, cell_range, key=1, ascending=True, contains_header=True):
        return self.workbook.sort_range(
            self._id(element_id), self._sheet, cell_range,
            key=key, ascending=ascending, contains_header=contains_header,
        )

    def named_range(self, element_id, name, cell_range):
        return self.workbook.add_named_range(self._id(element_id), self._sheet, name, cell_range)

    def add_chart(self, element_id, cell_range, box, chart_type='column', title=None, legend=True,
                  alt_text=None, anchor=None, reserve_space=False):
        return self.workbook.add_chart(
            self._id(element_id), self._sheet, cell_range, box,
            chart_type=chart_type, title=title, legend=legend,
            alt_text=alt_text, anchor=anchor, reserve_space=reserve_space,
        )

    def add_image(self, element_id, asset_name, box, contain=False, padding=0,
                  alt_text=None, title=None, anchor=None, reserve_space=False):
        return self.workbook.add_image(
            self._id(element_id), self._sheet, asset_name, box,
            contain=contain, padding=padding, alt_text=alt_text, title=title,
            anchor=anchor, reserve_space=reserve_space,
        )

    def print_setup(self, element_id, **options):
        return self.workbook.set_print_setup(self._id(element_id), self._sheet, **options)

    def add_pivot(self, element_id, source_range, destination, row_fields=None,
                  column_fields=None, data_fields=None, page_fields=None):
        return self.workbook.add_pivot(
            self._id(element_id), self._sheet, source_range, destination,
            row_fields=row_fields, column_fields=column_fields,
            data_fields=data_fields, page_fields=page_fields,
        )

    def add_scenario(self, element_id, name, cell_range, values, comment=''):
        return self.workbook.add_scenario(
            self._id(element_id), self._sheet, name, cell_range, values, comment=comment,
        )

    def goal_seek(self, element_id, formula_cell, variable_cell, target_value):
        return self.workbook.goal_seek(
            self._id(element_id), self._sheet, formula_cell, variable_cell, target_value,
        )

    def group(self, element_id, cell_range, orientation='rows', collapsed=False):
        return self.workbook.group_range(
            self._id(element_id), self._sheet, cell_range,
            orientation=orientation, collapsed=collapsed,
        )

    def ungroup(self, element_id, cell_range, orientation='rows'):
        return self.workbook.ungroup_range(
            self._id(element_id), self._sheet, cell_range, orientation=orientation,
        )

    def subtotals(self, element_id, cell_range, group_column, value_columns, function='sum', replace=True):
        return self.workbook.apply_subtotals(
            self._id(element_id), self._sheet, cell_range, group_column,
            value_columns, function=function, replace=replace,
        )


class SpreadsheetLayout(OfficeUnitConversion):
    """Stable Calc workbook facade with model-facing A1 worksheet objects."""

    def __init__(self, job, component):
        self.job, self._component = job, component

    def set_doc_info(self, title=None, subject=None, author=None, description=None, keywords=None):
        properties = self._component.DocumentProperties
        for name, value in (('Title', title), ('Subject', subject), ('Author', author), ('Description', description)):
            if value is not None:
                setattr(properties, name, str(value))
        if keywords is not None:
            properties.Keywords = tuple(str(value) for value in keywords)
        self.job.record_feature('documentProperties')
        return self

    @staticmethod
    def _column_name(index):
        value = int(index) + 1
        name = ''
        while value > 0:
            value, remainder = divmod(value - 1, 26)
            name = chr(65 + remainder) + name
        return name

    @staticmethod
    def _column_index(column):
        if isinstance(column, int):
            if column < 1:
                raise ValueError('Worksheet numeric columns are one-based and must be positive.')
            return column - 1
        value = str(column or '').strip().upper().replace('$', '')
        if not re.fullmatch(r'[A-Z]+', value):
            raise ValueError(f'Invalid worksheet column {column!r}.')
        index = 0
        for character in value:
            index = index * 26 + ord(character) - 64
        return index - 1

    @staticmethod
    def _drawing_area(sheet, box, anchor=None, reserve_space=False):
        area = PresentationLayout._rect(box, default_unit='hmm')
        if not anchor:
            return area
        cell = sheet.getCellRangeByName(str(anchor))
        try:
            position = cell.Position
            area = {
                **area,
                'x': int(position.X) + area['x'],
                'y': int(position.Y) + area['y'],
            }
        except Exception as error:
            raise ValueError(f'Cannot anchor drawing to worksheet cell {anchor!r}.') from error
        if reserve_space:
            row_index = int(cell.RangeAddress.StartRow)
            target = sheet.Rows.getByIndex(row_index)
            relative_y = area['y'] - int(position.Y)
            target.Height = max(int(target.Height), relative_y + area['height'] + 300)
        return area

    def add_worksheet(self, element_id, name):
        sheets = self._component.Sheets
        existing_names = list(sheets.getElementNames())
        if len(existing_names) == 1 and not any(item.get('kind') == 'worksheet' for item in self.job.element_records.values()):
            sheets.getByName(existing_names[0]).Name = str(name)
            sheet = sheets.getByName(str(name))
        elif sheets.hasByName(str(name)):
            sheet = sheets.getByName(str(name))
        else:
            sheets.insertNewByName(str(name), sheets.Count)
            sheet = sheets.getByName(str(name))
        self.job.register_element(element_id, 'worksheet', sheet, {'sheet': str(name)})
        return sheet

    def sheet(self, element_id, name):
        """Create or select a worksheet and return the model-facing A1 facade."""
        return SpreadsheetSheet(self, self.add_worksheet(element_id, name), element_id)

    def select_sheet(self, element_id, name):
        if not self._component.Sheets.hasByName(str(name)):
            raise ValueError(f'Workbook has no worksheet named {name!r}.')
        sheet = self._component.Sheets.getByName(str(name))
        self.job.register_element(element_id, 'worksheet', sheet, {'sheet': str(name)})
        return SpreadsheetSheet(self, sheet, element_id)

    def rename_sheet(self, sheet, new_name):
        if not isinstance(sheet, SpreadsheetSheet):
            raise ValueError('rename_sheet requires a SpreadsheetSheet.')
        name = str(new_name)
        if self._component.Sheets.hasByName(name) and self._component.Sheets.getByName(name) != sheet._sheet:
            raise ValueError(f'Workbook already contains worksheet {name!r}.')
        sheet._sheet.Name = name
        return sheet

    def remove_sheet(self, name):
        if not self._component.Sheets.hasByName(str(name)):
            raise ValueError(f'Workbook has no worksheet named {name!r}.')
        if self._component.Sheets.Count <= 1:
            raise ValueError('Workbook must retain at least one worksheet.')
        self._component.Sheets.removeByName(str(name))
        return self

    def copy_sheet(self, element_id, source_name, new_name, index=None):
        if not self._component.Sheets.hasByName(str(source_name)):
            raise ValueError(f'Workbook has no worksheet named {source_name!r}.')
        position = self._component.Sheets.Count if index is None else max(0, int(index) - 1)
        self._component.Sheets.copyByName(str(source_name), str(new_name), position)
        return self.select_sheet(element_id, new_name)

    def move_sheet(self, name, index):
        if not self._component.Sheets.hasByName(str(name)):
            raise ValueError(f'Workbook has no worksheet named {name!r}.')
        self._component.Sheets.moveByName(str(name), max(0, int(index) - 1))
        return self

    def set_cell(self, element_id, sheet, column, row, value):
        cell = sheet.getCellByPosition(int(column), int(row))
        if isinstance(value, bool):
            cell.Value = 1 if value else 0
        elif isinstance(value, (int, float)):
            cell.Value = float(value)
        elif isinstance(value, str) and value.startswith('='):
            cell.Formula = value
        else:
            cell.String = '' if value is None else str(value)
        record = self.job.register_element(element_id, 'cell', cell, {'sheet': str(sheet.Name), 'row': int(row) + 1, 'column': int(column) + 1}, update_existing=True)
        try:
            self._component.NamedRanges.addNewByName(record['artifactName'], cell.AbsoluteName, cell.CellAddress, 0)
        except Exception:
            pass
        return cell

    def set_range(self, element_id, sheet, start_column, start_row, rows):
        if not rows or not any(rows):
            raise ValueError('set_range requires a non-empty two-dimensional sequence')
        record = self.job.register_element(element_id, 'range', None, {
            'sheet': str(sheet.Name), 'startRow': int(start_row) + 1, 'startColumn': int(start_column) + 1,
            'rows': len(rows), 'columns': max(len(values) for values in rows),
        }, update_existing=True)
        try:
            end_column = int(start_column) + max(len(values) for values in rows) - 1
            end_row = int(start_row) + len(rows) - 1
            cell_range = sheet.getCellRangeByPosition(int(start_column), int(start_row), end_column, end_row)
            self._component.NamedRanges.addNewByName(record['artifactName'], cell_range.AbsoluteName,
                                                     sheet.getCellByPosition(int(start_column), int(start_row)).CellAddress, 0)
        except Exception:
            pass
        for row_offset, values in enumerate(rows):
            for column_offset, value in enumerate(values):
                cell = sheet.getCellByPosition(int(start_column) + column_offset, int(start_row) + row_offset)
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    cell.Value = float(value)
                elif isinstance(value, str) and value.startswith('='):
                    cell.Formula = value
                else:
                    cell.String = '' if value is None else str(value)
        return self

    def format_range(self, element_id, sheet, cell_range, font_size=None, bold=None,
                     color=None, background=None, horizontal=None, vertical=None, wrap=None,
                     italic=None, underline=None, font_name=None, number_format=None,
                     top_border=None, bottom_border=None, left_border=None, right_border=None,
                     border_width=25, rotation=None, shrink_to_fit=None):
        target = sheet.getCellRangeByName(str(cell_range))
        record = self.job.register_element(element_id, 'cell-format', target, {
            'sheet': str(sheet.Name), 'range': str(cell_range),
        }, update_existing=True)
        try:
            base = sheet.getCellByPosition(
                int(target.RangeAddress.StartColumn),
                int(target.RangeAddress.StartRow),
            ).CellAddress
            self._component.NamedRanges.addNewByName(
                record['artifactName'], target.AbsoluteName, base, 0,
            )
        except Exception:
            pass
        apply_text_font(target, font_name=font_name, font_size=font_size, bold=bold, italic=italic)
        if underline is not None:
            target.CharUnderline = uno.getConstantByName(
                'com.sun.star.awt.FontUnderline.SINGLE' if underline else 'com.sun.star.awt.FontUnderline.NONE'
            )
        if color is not None:
            target.CharColor = office_color(color, 'cell text color')
        if background is not None:
            target.CellBackColor = office_color(background, 'cell background')
        if horizontal is not None:
            target.HoriJustify = uno.Enum(
                'com.sun.star.table.CellHoriJustify', str(horizontal).strip().upper(),
            )
        if vertical is not None:
            target.VertJustify = uno.Enum(
                'com.sun.star.table.CellVertJustify', str(vertical).strip().upper(),
            )
        if wrap is not None:
            target.IsTextWrapped = bool(wrap)
        if shrink_to_fit is not None:
            target.ShrinkToFit = bool(shrink_to_fit)
        if rotation is not None:
            degrees = float(rotation)
            if degrees < -90 or degrees > 90:
                raise ValueError('Spreadsheet cell rotation must be between -90 and 90 degrees.')
            target.RotateAngle = int(round(degrees * 100.0))
        if number_format is not None:
            locale = uno.createUnoStruct('com.sun.star.lang.Locale')
            formats = self._component.NumberFormats
            key = formats.queryKey(str(number_format), locale, True)
            if key < 0:
                key = formats.addNew(str(number_format), locale)
            target.NumberFormat = int(key)
        for property_name, border_color in (
            ('TopBorder', top_border), ('BottomBorder', bottom_border),
            ('LeftBorder', left_border), ('RightBorder', right_border),
        ):
            if border_color is None:
                continue
            border = uno.createUnoStruct('com.sun.star.table.BorderLine2')
            border.Color = office_color(border_color, 'cell border color')
            border.LineWidth = max(1, int(border_width))
            border.LineStyle = 0
            setattr(target, property_name, border)
        return self

    def set_column_width(self, element_id, sheet, column, width):
        index = self._column_index(column)
        target = sheet.Columns.getByIndex(index)
        target.Width = int(width)
        self.job.register_element(element_id, 'column-width', target, {
            'sheet': str(sheet.Name), 'column': index + 1, 'width': int(width),
        }, update_existing=True)
        return self

    def set_row_height(self, element_id, sheet, row, height):
        index = int(row) - 1
        if index < 0:
            raise ValueError('Worksheet rows are one-based and must be positive.')
        target = sheet.Rows.getByIndex(index)
        target.Height = int(height)
        self.job.register_element(element_id, 'row-height', target, {
            'sheet': str(sheet.Name), 'row': index + 1, 'height': int(height),
        }, update_existing=True)
        return self

    def merge_cells(self, element_id, sheet, cell_range):
        target = sheet.getCellRangeByName(str(cell_range))
        target.merge(True)
        self.job.register_element(element_id, 'merged-range', target, {
            'sheet': str(sheet.Name), 'range': str(cell_range),
        })
        self.job.record_feature('mergedRange')
        return self

    def freeze_panes(self, element_id, sheet, rows=1, columns=0):
        row_count, column_count = max(0, int(rows)), max(0, int(columns))
        controller = self._component.CurrentController
        controller.setActiveSheet(sheet)
        controller.freezeAtPosition(column_count, row_count)
        self.job.ooxml_patches.setdefault('freezePanes', {})[str(sheet.Name)] = {
            'rows': row_count, 'columns': column_count,
        }
        self.job.register_element(element_id, 'freeze-panes', sheet, {
            'sheet': str(sheet.Name), 'rows': row_count, 'columns': column_count,
        })
        self.job.record_feature('freezePanes')
        return self

    def add_comment(self, element_id, sheet, address, text, author='User'):
        cell = sheet.getCellRangeByName(str(address))
        try:
            sheet.Annotations.insertNew(cell.CellAddress, str(text))
            annotation = cell.Annotation
            if hasattr(annotation, 'Author'):
                try:
                    annotation.Author = str(author)
                except Exception:
                    pass
        except Exception as error:
            raise ValueError(f'Calc could not add a comment at {address!r}.') from error
        self.job.register_element(element_id, 'comment', cell, {'sheet': str(sheet.Name), 'address': str(address)})
        self.job.record_feature('comment')
        return self

    def add_hyperlink(self, element_id, sheet, address, text, url):
        cell = sheet.getCellRangeByName(str(address))
        escaped_url = str(url).replace('"', '""')
        escaped_text = str(text).replace('"', '""')
        cell.Formula = f'=HYPERLINK("{escaped_url}";"{escaped_text}")'
        self.job.register_element(element_id, 'hyperlink', cell, {
            'sheet': str(sheet.Name), 'address': str(address), 'url': str(url),
        })
        self.job.record_feature('externalHyperlink')
        return self

    def set_data_validation(self, element_id, sheet, cell_range, validation_type,
                            operator='between', formula1=None, formula2=None, values=None,
                            allow_blank=True, error_title='Invalid value', error_message='',
                            input_title='', input_message=''):
        target = sheet.getCellRangeByName(str(cell_range))
        descriptor = target.Validation
        types = {
            'any': 'ANY', 'whole': 'WHOLE', 'decimal': 'DECIMAL', 'date': 'DATE',
            'time': 'TIME', 'range': 'CELL_RANGE', 'list': 'LIST',
            'text-length': 'TEXT_LEN', 'custom': 'CUSTOM',
        }
        operators = {
            'equal': 'EQUAL', 'not-equal': 'NOT_EQUAL', 'greater': 'GREATER',
            'greater-equal': 'GREATER_EQUAL', 'less': 'LESS', 'less-equal': 'LESS_EQUAL',
            'between': 'BETWEEN', 'not-between': 'NOT_BETWEEN', 'formula': 'FORMULA',
        }
        type_key = str(validation_type).strip().lower().replace('_', '-')
        operator_key = str(operator).strip().lower().replace('_', '-')
        if type_key not in types or operator_key not in operators:
            raise ValueError('Unsupported Calc data validation type or operator.')
        descriptor.Type = uno.Enum('com.sun.star.sheet.ValidationType', types[type_key])
        descriptor.Operator = uno.Enum('com.sun.star.sheet.ConditionOperator', operators[operator_key])
        if values is not None:
            descriptor.Formula1 = '"' + ';'.join(str(value) for value in values) + '"'
        elif formula1 is not None:
            descriptor.Formula1 = str(formula1)
        if formula2 is not None:
            descriptor.Formula2 = str(formula2)
        descriptor.IgnoreBlankCells = bool(allow_blank)
        descriptor.ShowErrorMessage = bool(error_message or error_title)
        descriptor.ErrorTitle, descriptor.ErrorMessage = str(error_title), str(error_message)
        descriptor.ShowInputMessage = bool(input_message or input_title)
        descriptor.InputTitle, descriptor.InputMessage = str(input_title), str(input_message)
        target.Validation = descriptor
        self.job.register_element(element_id, 'data-validation', target, {
            'sheet': str(sheet.Name), 'range': str(cell_range), 'type': type_key,
        })
        self.job.record_feature('dataValidation')
        return self

    def _conditional_style(self, element_id, **style):
        family = self._component.StyleFamilies.getByName('CellStyles')
        name = 'wp_cf_' + re.sub(r'[^A-Za-z0-9_]', '_', str(element_id))[:80]
        if family.hasByName(name):
            target = family.getByName(name)
        else:
            target = self._component.createInstance('com.sun.star.style.CellStyle')
            family.insertByName(name, target)
        if 'background' in style:
            target.CellBackColor = office_color(style['background'], 'conditional format background')
        if 'color' in style:
            target.CharColor = office_color(style['color'], 'conditional format color')
        apply_text_font(target, font_name=style.get('font_name'), font_size=style.get('font_size'),
                        bold=style.get('bold'), italic=style.get('italic'))
        return name

    def add_conditional_format(self, element_id, sheet, cell_range, operator, formula, **style):
        target = sheet.getCellRangeByName(str(cell_range))
        formats = target.ConditionalFormat
        operators = {
            'equal': 'EQUAL', 'not-equal': 'NOT_EQUAL', 'greater': 'GREATER',
            'greater-equal': 'GREATER_EQUAL', 'less': 'LESS', 'less-equal': 'LESS_EQUAL',
            'between': 'BETWEEN', 'not-between': 'NOT_BETWEEN', 'formula': 'FORMULA',
        }
        key = str(operator).strip().lower().replace('_', '-')
        if key not in operators:
            raise ValueError(f'Unsupported conditional-format operator {operator!r}.')
        properties = [
            self.job.property('Operator', uno.Enum('com.sun.star.sheet.ConditionOperator', operators[key])),
            self.job.property('Formula1', str(formula)),
            self.job.property('StyleName', self._conditional_style(element_id, **style)),
        ]
        formats.addNew(tuple(properties))
        target.ConditionalFormat = formats
        self.job.register_element(element_id, 'conditional-format', target, {
            'sheet': str(sheet.Name), 'range': str(cell_range), 'operator': key,
        })
        self.job.record_feature('conditionalFormat')
        return self

    def set_auto_filter(self, element_id, sheet, cell_range, enabled=True):
        target = sheet.getCellRangeByName(str(cell_range))
        name = 'wp_filter_' + re.sub(r'[^A-Za-z0-9_]', '_', str(element_id))[:80]
        ranges = self._component.DatabaseRanges
        if not ranges.hasByName(name):
            ranges.addNewByName(name, target.RangeAddress)
        database_range = ranges.getByName(name)
        database_range.AutoFilter = bool(enabled)
        database_range.ContainsHeader = True
        self.job.register_element(element_id, 'database-range', database_range, {
            'sheet': str(sheet.Name), 'range': str(cell_range), 'autoFilter': bool(enabled),
        })
        self.job.record_feature('autoFilter')
        return self

    def sort_range(self, element_id, sheet, cell_range, key=1, ascending=True, contains_header=True):
        target = sheet.getCellRangeByName(str(cell_range))
        descriptor = list(target.createSortDescriptor())
        for property_value in descriptor:
            if property_value.Name == 'ContainsHeader':
                property_value.Value = bool(contains_header)
            elif property_value.Name == 'SortAscending':
                property_value.Value = bool(ascending)
        try:
            sort_field = uno.createUnoStruct('com.sun.star.util.SortField')
            sort_field.Field = max(0, int(key) - 1)
            sort_field.SortAscending = bool(ascending)
            for property_value in descriptor:
                if property_value.Name == 'SortFields':
                    property_value.Value = (sort_field,)
        except Exception:
            pass
        target.sort(tuple(descriptor))
        self.job.register_element(element_id, 'sorted-range', target, {
            'sheet': str(sheet.Name), 'range': str(cell_range), 'key': int(key),
        })
        self.job.record_feature('sort')
        return self

    def add_named_range(self, element_id, sheet, name, cell_range):
        target = sheet.getCellRangeByName(str(cell_range))
        ranges = self._component.NamedRanges
        if ranges.hasByName(str(name)):
            ranges.removeByName(str(name))
        address = target.RangeAddress
        base = sheet.getCellByPosition(int(address.StartColumn), int(address.StartRow)).CellAddress
        ranges.addNewByName(str(name), target.AbsoluteName, base, 0)
        self.job.register_element(element_id, 'named-range', target, {
            'sheet': str(sheet.Name), 'range': str(cell_range), 'name': str(name),
        })
        self.job.record_feature('namedRange')
        return self

    def add_chart(self, element_id, sheet, cell_range, box, chart_type='column', title=None, legend=True,
                  alt_text=None, anchor=None, reserve_space=False):
        area = self._drawing_area(sheet, box, anchor=anchor, reserve_space=reserve_space)
        target = sheet.getCellRangeByName(str(cell_range))
        rectangle = uno.createUnoStruct('com.sun.star.awt.Rectangle')
        rectangle.X, rectangle.Y = area['x'], area['y']
        rectangle.Width, rectangle.Height = area['width'], area['height']
        record = self.job.register_element(element_id, 'chart', None, {
            'sheet': str(sheet.Name), 'range': str(cell_range),
            'chartType': str(chart_type).strip().lower(),
        })
        try:
            base = sheet.getCellByPosition(
                int(target.RangeAddress.StartColumn),
                int(target.RangeAddress.StartRow),
            ).CellAddress
            self._component.NamedRanges.addNewByName(
                record['artifactName'], target.AbsoluteName, base, 0,
            )
        except Exception:
            pass
        name = record['artifactName']
        charts = sheet.Charts
        charts.addNewByName(name, rectangle, (target.RangeAddress,), True, True)
        embedded = charts.getByName(name)
        chart = embedded.EmbeddedObject
        diagrams = {
            'column': 'com.sun.star.chart.BarDiagram', 'bar': 'com.sun.star.chart.BarDiagram',
            'line': 'com.sun.star.chart.LineDiagram', 'pie': 'com.sun.star.chart.PieDiagram',
            'area': 'com.sun.star.chart.AreaDiagram', 'scatter': 'com.sun.star.chart.XYDiagram',
        }
        key = str(chart_type).strip().lower()
        if key not in diagrams:
            raise ValueError(f'Unsupported Calc chart type {chart_type!r}.')
        diagram = chart.createInstance(diagrams[key])
        chart.setDiagram(diagram)
        if key in {'column', 'bar'}:
            # Chart1 uses Vertical=True for horizontal bars, not columns.
            diagram.Vertical = key == 'bar'
        chart.HasLegend = bool(legend)
        if title:
            chart.HasMainTitle = True
            chart.Title.String = str(title)
        # Use a restrained, high-contrast palette instead of LibreOffice's
        # legacy gray plot wall and saturated default series colors.
        palette = (0x0B4F8A, 0x2558D8, 0xD97706, 0x0F9F8F, 0x6D5BD0, 0xE25555)
        try:
            chart.Area.FillColor = 0xFFFFFF
        except Exception:
            pass
        try:
            diagram.Wall.FillColor = 0xF8FAFC
            diagram.Wall.LineColor = 0xD5DEE8
        except Exception:
            pass
        for index, color in enumerate(palette):
            try:
                series = diagram.getDataRowProperties(index)
                series.FillColor = color
                series.LineColor = color
            except Exception:
                pass
            try:
                point_style = diagram.getDataPointProperties(index, 0)
                point_style.FillColor = color
                point_style.LineColor = color
            except Exception:
                pass
        try:
            diagram.YAxis.MainGrid.LineColor = 0xD5DEE8
        except Exception:
            pass
        for target in (
            getattr(chart, 'Title', None), getattr(diagram, 'XAxis', None),
            getattr(diagram, 'YAxis', None),
        ):
            if target is None:
                continue
            try:
                target.CharColor = 0x111827
                apply_text_font(target, font_name=_CJK_FONT)
            except Exception:
                pass
        try:
            if title:
                embedded.Title = str(title)
            if alt_text:
                embedded.Description = str(alt_text)
        except Exception:
            pass
        self.job.record_feature('nativeChart')
        return self

    def add_image(self, element_id, sheet, asset_name, box, contain=False, padding=0,
                  alt_text=None, title=None, anchor=None, reserve_space=False):
        area = self._drawing_area(sheet, box, anchor=anchor, reserve_space=reserve_space)
        if contain:
            inset = max(0, int(padding))
            available_width = area['width'] - inset * 2
            available_height = area['height'] - inset * 2
            if available_width <= 0 or available_height <= 0:
                raise ValueError(f'Spreadsheet image {element_id!r} padding leaves no usable area.')
            intrinsic = source_image_dimensions(self.job.asset_path(asset_name))
            if intrinsic and float(intrinsic[0]) > 0 and float(intrinsic[1]) > 0:
                scale = min(available_width / float(intrinsic[0]), available_height / float(intrinsic[1]))
                width = max(1, int(round(float(intrinsic[0]) * scale)))
                height = max(1, int(round(float(intrinsic[1]) * scale)))
            else:
                width, height = available_width, available_height
            area = {
                **area,
                'x': area['x'] + inset + (available_width - width) // 2,
                'y': area['y'] + inset + (available_height - height) // 2,
                'width': width,
                'height': height,
            }
        shape = self._component.createInstance('com.sun.star.drawing.GraphicObjectShape')
        shape.Position, shape.Size = point(area['x'], area['y']), size(area['width'], area['height'])
        shape.GraphicURL = uno.systemPathToFileUrl(str(self.job.asset_path(asset_name)))
        try:
            shape.Description = str(alt_text or '')
            shape.Title = str(title or '')
        except Exception:
            pass
        sheet.DrawPage.add(shape)
        self.job.register_element(element_id, 'image', shape, {'sheet': str(sheet.Name)})
        self.job.record_feature('embeddedImage')
        return self

    def set_print_setup(self, element_id, sheet, orientation=None, paper_size=None,
                        margins=None, repeat_rows=None, repeat_columns=None, print_area=None,
                        scale=None, fit_to_pages=None):
        family = self._component.StyleFamilies.getByName('PageStyles')
        style = family.getByName(sheet.PageStyle)
        if orientation is not None:
            style.IsLandscape = str(orientation).strip().lower() == 'landscape'
        if paper_size is not None:
            width, height = paper_size
            style.Width, style.Height = int(width), int(height)
        if margins is not None:
            values = dict(margins) if isinstance(margins, dict) else dict(zip(('left', 'right', 'top', 'bottom'), margins))
            for key, property_name in (
                ('left', 'LeftMargin'), ('right', 'RightMargin'), ('top', 'TopMargin'), ('bottom', 'BottomMargin'),
            ):
                if key in values:
                    setattr(style, property_name, int(values[key]))
        if scale is not None:
            style.PageScale = int(scale)
        if fit_to_pages is not None:
            style.ScaleToPages = int(fit_to_pages)
        if print_area:
            sheet.setPrintAreas((sheet.getCellRangeByName(str(print_area)).RangeAddress,))
        if repeat_rows:
            sheet.setTitleRows(sheet.getCellRangeByName(str(repeat_rows)).RangeAddress)
            sheet.setPrintTitleRows(True)
        if repeat_columns:
            sheet.setTitleColumns(sheet.getCellRangeByName(str(repeat_columns)).RangeAddress)
            sheet.setPrintTitleColumns(True)
        self.job.register_element(element_id, 'print-setup', style, {'sheet': str(sheet.Name)})
        self.job.record_feature('printSetup')
        return self

    def add_pivot(self, element_id, sheet, source_range, destination, row_fields=None,
                  column_fields=None, data_fields=None, page_fields=None):
        source = sheet.getCellRangeByName(str(source_range))
        destination_cell = sheet.getCellRangeByName(str(destination))
        tables = sheet.getDataPilotTables()
        descriptor = tables.createDataPilotDescriptor()
        descriptor.SourceRange = source.RangeAddress
        fields = descriptor.DataPilotFields
        orientations = (
            (row_fields or [], 'ROW'), (column_fields or [], 'COLUMN'),
            (page_fields or [], 'PAGE'), (data_fields or [], 'DATA'),
        )
        for names, orientation in orientations:
            for name in names:
                field = fields.getByName(str(name)) if not isinstance(name, int) else fields.getByIndex(int(name))
                field.Orientation = uno.Enum('com.sun.star.sheet.DataPilotFieldOrientation', orientation)
                if orientation == 'DATA':
                    try:
                        field.Function = uno.Enum('com.sun.star.sheet.GeneralFunction', 'SUM')
                    except Exception:
                        pass
        table_name = 'wp_pivot_' + re.sub(r'[^A-Za-z0-9_]', '_', str(element_id))[:80]
        tables.insertNewByName(table_name, destination_cell.CellAddress, descriptor)
        self.job.register_element(element_id, 'pivot-table', tables.getByName(table_name), {
            'sheet': str(sheet.Name), 'source': str(source_range), 'destination': str(destination),
        })
        self.job.record_feature('pivotTable')
        return self

    def add_scenario(self, element_id, sheet, name, cell_range, values, comment=''):
        target = sheet.getCellRangeByName(str(cell_range))
        scenarios = sheet.Scenarios
        scenarios.addNewByName(str(name), (target.RangeAddress,), str(comment))
        scenario = scenarios.getByName(str(name))
        scenario.getCellRangeByName(str(cell_range)).setDataArray(tuple(tuple(row) for row in values))
        self.job.register_element(element_id, 'scenario', scenario, {'sheet': str(sheet.Name), 'name': str(name)})
        self.job.record_feature('scenario')
        return self

    def goal_seek(self, element_id, sheet, formula_cell, variable_cell, target_value):
        formula = sheet.getCellRangeByName(str(formula_cell))
        variable = sheet.getCellRangeByName(str(variable_cell))
        result = self._component.seekGoal(formula.CellAddress, variable.CellAddress, str(target_value))
        self.job.register_element(element_id, 'goal-seek', formula, {
            'sheet': str(sheet.Name), 'formulaCell': str(formula_cell), 'variableCell': str(variable_cell),
            'target': float(target_value), 'result': float(result.Result), 'divergence': float(result.Divergence),
        })
        self.job.record_feature('goalSeek')
        return {'result': float(result.Result), 'divergence': float(result.Divergence)}

    def group_range(self, element_id, sheet, cell_range, orientation='rows', collapsed=False):
        target = sheet.getCellRangeByName(str(cell_range))
        direction = str(orientation).strip().lower()
        if direction not in {'rows', 'columns'}:
            raise ValueError("Calc group orientation must be 'rows' or 'columns'.")
        native = uno.Enum('com.sun.star.table.TableOrientation', 'ROWS' if direction == 'rows' else 'COLUMNS')
        sheet.group(target.RangeAddress, native)
        if collapsed:
            sheet.hideDetail(target.RangeAddress)
        self.job.register_element(element_id, 'outline-group', target, {
            'sheet': str(sheet.Name), 'range': str(cell_range), 'orientation': direction,
        })
        self.job.record_feature('outlineGroup')
        return self

    def ungroup_range(self, element_id, sheet, cell_range, orientation='rows'):
        target = sheet.getCellRangeByName(str(cell_range))
        direction = str(orientation).strip().lower()
        native = uno.Enum('com.sun.star.table.TableOrientation', 'ROWS' if direction == 'rows' else 'COLUMNS')
        sheet.ungroup(target.RangeAddress, native)
        self.job.register_element(element_id, 'outline-ungroup', target, {
            'sheet': str(sheet.Name), 'range': str(cell_range), 'orientation': direction,
        })
        return self

    def apply_subtotals(self, element_id, sheet, cell_range, group_column, value_columns,
                        function='sum', replace=True):
        target = sheet.getCellRangeByName(str(cell_range))
        functions = {
            'sum': 'SUM', 'average': 'AVERAGE', 'count': 'COUNT',
            'max': 'MAX', 'min': 'MIN', 'product': 'PRODUCT',
        }
        key = str(function).strip().lower()
        if key not in functions:
            raise ValueError(f'Unsupported subtotal function {function!r}.')
        descriptor = sheet.createSubTotalDescriptor(True)
        columns = []
        for column in value_columns:
            subtotal = uno.createUnoStruct('com.sun.star.sheet.SubTotalColumn')
            subtotal.Column = max(0, int(column) - 1)
            subtotal.Function = uno.Enum('com.sun.star.sheet.GeneralFunction', functions[key])
            columns.append(subtotal)
        descriptor.addNew(tuple(columns), max(0, int(group_column) - 1))
        target.applySubTotals(descriptor, bool(replace))
        self.job.ooxml_patches['repairSubtotalFormulas'] = True
        # Some LibreOffice builds append a stale #REF! token to otherwise
        # correct SUBTOTAL formulas created through XSubTotalCalculatable.
        # Repair the actual Calc formula before export instead of allowing a
        # workbook with visible formula errors to pass on feature counts.
        cursor = sheet.createCursor()
        cursor.gotoEndOfUsedArea(True)
        used = cursor.RangeAddress
        for row in range(int(used.StartRow), int(used.EndRow) + 1):
            for column in range(int(used.StartColumn), int(used.EndColumn) + 1):
                cell = sheet.getCellByPosition(column, row)
                formula = str(getattr(cell, 'Formula', '') or '')
                if 'SUBTOTAL' in formula.upper() and '#REF!' in formula.upper():
                    cell.Formula = re.sub(r'#REF!', '', formula, flags=re.IGNORECASE)
        self.job.register_element(element_id, 'subtotals', target, {
            'sheet': str(sheet.Name), 'range': str(cell_range), 'groupColumn': int(group_column),
        })
        self.job.record_feature('subtotals')
        return self

    @staticmethod
    def unsupported(feature_name):
        raise ValueError(
            f'Office capability {feature_name!r} is unsupported for authored UNO generation. '
            'Do not emulate it with raw UNO.'
        )

    def feature(self, feature_name, element_id, sheet=None, **params):
        name = str(feature_name or '').strip().lower()
        if not isinstance(sheet, SpreadsheetSheet):
            raise ValueError('Spreadsheet feature recipes require the object returned by workbook.sheet().')
        if name == 'calc.freeze-panes@1':
            return self.freeze_panes(element_id, sheet._sheet, **params)
        if name == 'calc.merge-cells@1':
            cell_range = params.pop('cell_range', None)
            if not cell_range:
                raise ValueError('calc.merge-cells@1 requires cell_range.')
            return self.merge_cells(element_id, sheet._sheet, cell_range)
        raise ValueError(
            f'Unsupported Calc feature recipe {feature_name!r}. '
            'Query the corresponding unoApi module and use one of its installed facade examples.'
        )

    def save(self):
        save_document(self._component, self.job)
        return self

    def close(self):
        self.job.close(self._component)


def validate_program(source: str):
    tree = ast.parse(source, filename='draft.py', mode='exec')
    entrypoints = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == 'create_document']
    if len(entrypoints) != 1 or len(entrypoints[0].args.args) != 1 or entrypoints[0].args.args[0].arg != 'job':
        raise ValueError('Draft must define exactly one synchronous create_document(job) function')
    if isinstance(entrypoints[0], ast.AsyncFunctionDef):
        raise ValueError('create_document(job) must be synchronous')
    diagnostics = []
    entrypoint = entrypoints[0]
    facade_vars = set()
    for node in ast.walk(entrypoint):
        value = node.value if isinstance(node, (ast.Assign, ast.AnnAssign)) else None
        targets = node.targets if isinstance(node, ast.Assign) else [node.target] if isinstance(node, ast.AnnAssign) else []
        if isinstance(value, ast.Call) and isinstance(value.func, ast.Attribute) \
                and isinstance(value.func.value, ast.Name) and value.func.value.id == 'job' \
                and value.func.attr in {'presentation', 'writer', 'spreadsheet'}:
            facade_vars.update(target.id for target in targets if isinstance(target, ast.Name))
    if not facade_vars:
        diagnostics.append({
            'code': 'PYTHON_DOCUMENT_FACADE_MISSING',
            'line': entrypoint.lineno, 'column': entrypoint.col_offset + 1,
            'message': 'create_document(job) must create the requested Office document with '
                       'job.presentation(...), job.writer(...), or job.spreadsheet(...).',
            'severity': 'error',
        })
    lifecycle_calls = [
        (node.func.value.id, node.func.attr, node)
        for node in ast.walk(entrypoint)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name) and node.func.value.id in facade_vars
    ]
    for facade_var in sorted(facade_vars):
        save_calls = [node for receiver, method, node in lifecycle_calls if receiver == facade_var and method == 'save']
        close_calls = [node for receiver, method, node in lifecycle_calls if receiver == facade_var and method == 'close']
        if len(save_calls) != 1:
            diagnostics.append({
                'code': 'PYTHON_OUTPUT_SAVE_MISSING' if not save_calls else 'PYTHON_OUTPUT_SAVE_DUPLICATE',
                'line': entrypoint.lineno, 'column': entrypoint.col_offset + 1,
                'message': f'create_document(job) must call {facade_var}.save() exactly once; found {len(save_calls)}. '
                           'Without save(), the requested Office output file is never created.',
                'severity': 'error',
            })
        if len(close_calls) != 1:
            diagnostics.append({
                'code': 'PYTHON_OUTPUT_CLOSE_MISSING' if not close_calls else 'PYTHON_OUTPUT_CLOSE_DUPLICATE',
                'line': entrypoint.lineno, 'column': entrypoint.col_offset + 1,
                'message': f'create_document(job) must call {facade_var}.close() exactly once after save(); found {len(close_calls)}.',
                'severity': 'error',
            })
        if len(save_calls) == 1 and len(close_calls) == 1 \
                and (save_calls[0].lineno, save_calls[0].col_offset) >= (close_calls[0].lineno, close_calls[0].col_offset):
            diagnostics.append({
                'code': 'PYTHON_OUTPUT_LIFECYCLE_ORDER_INVALID',
                'line': close_calls[0].lineno, 'column': close_calls[0].col_offset + 1,
                'message': f'{facade_var}.save() must appear before {facade_var}.close() so the output is written before the component is closed.',
                'severity': 'error',
            })
    def visit_module_level(node):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)):
            return
        if isinstance(node, ast.Call):
            name = node.func.attr if isinstance(node.func, ast.Attribute) else node.func.id if isinstance(node.func, ast.Name) else ''
            if name == 'create_document':
                diagnostics.append({
                    'code': 'DRAFT_ENTRYPOINT_CALLED_DIRECTLY', 'line': node.lineno, 'column': node.col_offset + 1,
                    'message': 'Do not call create_document yourself. The LibreOffice worker invokes create_document(job) with the real job object.',
                    'severity': 'error',
                })
        for child in ast.iter_child_nodes(node):
            visit_module_level(child)
    for node in tree.body:
        visit_module_level(node)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == 'uno' or alias.name.startswith('com.sun.star'):
                    diagnostics.append({
                        'code': 'MODEL_RAW_UNO_FORBIDDEN', 'line': node.lineno, 'column': node.col_offset + 1,
                        'message': 'Authored Office source must use the high-level facade; raw UNO imports are worker-owned.',
                        'severity': 'error',
                    })
        if isinstance(node, ast.ImportFrom) and str(node.module or '').startswith('com.sun.star'):
            diagnostics.append({
                'code': 'MODEL_RAW_UNO_FORBIDDEN', 'line': node.lineno, 'column': node.col_offset + 1,
                'message': 'Authored Office source must use the high-level facade; com.sun.star imports are forbidden.',
                'severity': 'error',
            })
        if isinstance(node, ast.Call):
            name = node.func.attr if isinstance(node.func, ast.Attribute) else node.func.id if isinstance(node.func, ast.Name) else ''
            if name in {'eval', 'exec', 'compile', '__import__'}:
                diagnostics.append({'code': 'UNSAFE_DYNAMIC_EXECUTION', 'line': node.lineno, 'column': node.col_offset + 1,
                                    'message': f'{name} is forbidden in an Office draft.', 'severity': 'error'})
            if name == 'createInstance' and node.args and isinstance(node.args[0], ast.Constant) \
                    and node.args[0].value == 'com.sun.star.drawing.ConnectorShape':
                diagnostics.append({
                    'code': 'RAW_CONNECTOR_SHAPE_UNSTABLE', 'line': node.lineno, 'column': node.col_offset + 1,
                    'message': 'Raw ConnectorShape can dispose the LibreOffice bridge in large Impress decks. Use deck.add_connector(...) with the same stable elementId instead.',
                    'severity': 'error',
                })
            if name == 'expert':
                diagnostics.append({
                    'code': 'MODEL_RAW_UNO_FORBIDDEN', 'line': node.lineno, 'column': node.col_offset + 1,
                    'message': 'job.expert() is not model-facing. Query the corresponding unoApi module and use one of its installed facade examples.',
                    'severity': 'error',
                })
        if isinstance(node, ast.Attribute) and node.attr in {'raw', '_component', '_page', '_sheet'}:
            diagnostics.append({
                'code': 'MODEL_RAW_UNO_FORBIDDEN', 'line': node.lineno, 'column': node.col_offset + 1,
                'message': f'Direct .{node.attr} access is worker-owned. Use the returned high-level facade.',
                'severity': 'error',
            })
    defined = set(dir(builtins)) | {'uno', '__name__', '__file__', '__webpilot_static_diagnostics__'}
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Param)):
            defined.add(node.id)
        elif isinstance(node, ast.arg):
            defined.add(node.arg)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            defined.add(node.name)
        elif isinstance(node, ast.alias):
            defined.add(node.asname or node.name.split('.')[0])
        elif isinstance(node, ast.ExceptHandler) and isinstance(node.name, str):
            defined.add(node.name)
    undefined = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id not in defined and node.id not in undefined:
            undefined.add(node.id)
            diagnostics.append({
                'code': 'PYTHON_UNDEFINED_NAME', 'line': node.lineno, 'column': node.col_offset + 1,
                'message': f'Python name {node.id!r} is referenced but never defined in this draft.',
                'severity': 'error',
            })
    errors = [item for item in diagnostics if item['severity'] == 'error']
    if errors:
        raise ValueError('\n'.join(f"{item.get('line', '?')}:{item.get('column', '?')} {item['message']}" for item in errors))
    return diagnostics


def program_namespace(program_path: Path):
    source = program_path.read_text(encoding='utf-8')
    diagnostics = validate_program(source)
    namespace = {'__name__': '__webpilot_document_draft__', '__file__': str(program_path), 'uno': uno,
                 '__webpilot_static_diagnostics__': diagnostics}
    exec(compile(source, str(program_path), 'exec'), namespace, namespace)
    return namespace


def expected_service(kind):
    return {'word': 'com.sun.star.text.TextDocument', 'spreadsheet': 'com.sun.star.sheet.SpreadsheetDocument', 'presentation': 'com.sun.star.presentation.PresentationDocument'}[kind]


def factory_url(document_type):
    return {'word': 'private:factory/swriter', 'spreadsheet': 'private:factory/scalc', 'presentation': 'private:factory/simpress'}[document_type]


def inspect_target(document, document_type, target):
    if target == 'document':
        return document
    if target == 'text' and document_type == 'word':
        return document.Text
    if target == 'cursor' and document_type == 'word':
        return document.Text.createTextCursor()
    if target == 'shape' and document_type == 'word':
        shape = document.createInstance('com.sun.star.drawing.RectangleShape')
        document.DrawPage.add(shape)
        return shape
    if target in ('sheet', 'cell') and document_type == 'spreadsheet':
        sheet = document.Sheets.getByIndex(0)
        return sheet if target == 'sheet' else sheet.getCellByPosition(0, 0)
    if target in ('page', 'shape') and document_type == 'presentation':
        page = document.DrawPages.getByIndex(0)
        if target == 'page':
            return page
        shape = document.createInstance('com.sun.star.drawing.TextShape')
        page.add(shape)
        return shape
    if target in ('chart', 'chart-data') and document_type == 'presentation':
        page = document.DrawPages.getByIndex(0)
        chart = document.createInstance('com.sun.star.drawing.OLE2Shape')
        chart.CLSID = '12DCAE26-281F-416F-A234-C3086127382E'
        chart.Position, chart.Size = point(1000, 1000), size(12000, 7000)
        page.add(chart)
        return chart.Model if target == 'chart' else chart.Model.Data
    if target in ('table', 'table-column', 'table-row') and document_type == 'presentation':
        page = document.DrawPages.getByIndex(0)
        table_shape = document.createInstance('com.sun.star.drawing.TableShape')
        table_shape.Position, table_shape.Size = point(1000, 1000), size(12000, 7000)
        page.add(table_shape)
        if target == 'table':
            return table_shape.Model
        if target == 'table-column':
            return table_shape.Model.Columns.getByIndex(0)
        return table_shape.Model.Rows.getByIndex(0)
    raise ValueError(f'target={target} is not valid for documentType={document_type}')


def targets_for_document_type(document_type):
    return {
        'word': ('document', 'text', 'cursor', 'shape'),
        'spreadsheet': ('document', 'sheet', 'cell'),
        'presentation': ('document', 'page', 'shape', 'table', 'table-column', 'table-row', 'chart', 'chart-data'),
    }[document_type]


def uno_property_summary(target):
    try:
        properties = target.getPropertySetInfo().getProperties()
    except Exception:
        return []
    result = []
    for item in properties:
        type_name = getattr(getattr(item, 'Type', None), 'typeName', '')
        result.append({'name': item.Name, 'type': type_name, 'attributes': int(getattr(item, 'Attributes', 0))})
    return sorted(result, key=lambda item: item['name'])


def uno_method_summary(target):
    return sorted({name for name in dir(target) if not name.startswith('_')})


def uno_examples(document_type):
    return uno_cookbook(document_type)['completeDocument']


def uno_image_example(document_type):
    return uno_cookbook(document_type)['operations']['image']


def facade_api_reference(document_type):
    """Return exact signatures for every public method exposed by the facade.

    The model used to receive a few hand-written, abbreviated signatures and
    then had to guess the rest.  Keep this reference generated from the actual
    installed classes so documentation cannot drift from the implementation.
    """
    classes = {
        'word': (
            ('job', DocumentJob),
            ('document', WriterLayout),
        ),
        'spreadsheet': (
            ('job', DocumentJob),
            ('workbook', SpreadsheetLayout),
            ('sheet', SpreadsheetSheet),
        ),
        'presentation': (
            ('job', DocumentJob),
            ('deck', PresentationLayout),
            ('slide', PresentationSlide),
            ('shape', PresentationShape),
            ('table', PresentationTable),
        ),
    }[document_type]
    reference = []
    for receiver, facade_class in classes:
        for name, member in inspect.getmembers(facade_class, predicate=callable):
            if name.startswith('_'):
                continue
            try:
                signature = inspect.signature(member)
                parameters = list(signature.parameters.values())
                if parameters and parameters[0].name in ('self', 'cls'):
                    signature = signature.replace(parameters=parameters[1:])
                rendered = str(signature)
            except (TypeError, ValueError):
                rendered = '(...)'
            reference.append({
                'receiver': receiver,
                'method': name,
                'signature': f'{receiver}.{name}{rendered}',
            })
    return reference


def facade_value_schemas(document_type):
    shared = {
        'elementId': {
            'type': 'string',
            'rules': 'Non-empty Unicode is accepted. Child IDs are automatically scoped by slide or sheet.',
            'examples': ['title', '图表-收入', 'planet-card'],
        },
        'color': {
            'accepted': ['0xRRGGBB integer', '#RRGGBB string', '0xRRGGBB string'],
            'examples': [0x2563EB, '#2563EB', '0x2563EB'],
            'rejected': ['named CSS colors', '3-digit hex', '8-digit alpha hex'],
        },
    }
    if document_type == 'presentation':
        shared.update({
            'canvas': {
                'newDeckSizeInches': {'width': 13.333, 'height': 7.5},
                'horizontalCenterInches': 6.6665,
                'rules': [
                    'Blank slides still use the full 13.333 x 7.5 inch wide-screen canvas; never author them against a 10 x 7.5 inch coordinate system.',
                    "align='CENTER' centers text inside its box only and does not center the box on the slide.",
                    'Prefer named slots or grid/stack without an explicit box. For freeform inch geometry, center with x = (13.333 - width) / 2 or derive the region from deck.bounds()/deck.content_box().',
                ],
            },
            'box': {
                'defaultUnit': 'inches on slide.add_* methods',
                'accepted': [
                    '(x, y, width, height)',
                    '[x, y, width, height]',
                    "{'x': x, 'y': y, 'width': width, 'height': height}",
                    "{'x': x, 'y': y, 'w': width, 'h': height}",
                    "text only: {'x': x, 'y': y, 'w': width} with measured height",
                ],
                'rules': 'Positive fractional width/height are valid; values are not truncated. Rectangles returned by deck/slide content_box, grid, stack, and slot retain _unit=hmm and can be passed directly without conversion.',
            },
            'textStyle': {
                'keys': [
                    'font_size', 'min_font_size', 'font_name', 'color', 'bold', 'italic',
                    'underline', 'strike', 'align', 'valign', 'padding', 'line_spacing',
                    'background', 'background_transparency', 'border', 'line_width',
                    'link', 'rotation', 'allow_overlap', 'layout_role',
                ],
                'aliases': {'fontSize': 'font_size', 'fontFace': 'font_name', 'verticalAlign': 'valign', 'fill': 'background', 'line': 'border'},
                'alignValues': ['LEFT', 'CENTER', 'RIGHT', 'BLOCK'],
                'valignValues': ['TOP', 'CENTER', 'MIDDLE', 'BOTTOM'],
            },
            'shapeStyle': {
                'shapeTypes': [
                    'rectangle', 'round-rectangle', 'rounded-rectangle', 'ellipse',
                    'circle', 'diamond', 'triangle', 'right-triangle', 'parallelogram',
                    'trapezoid', 'pentagon', 'hexagon', 'octagon', 'star', 'line',
                    'caption', 'measure',
                ],
                'line': "color or {'color': color, 'width': points, 'transparency': 0..100}",
                'keys': ['fill', 'line', 'line_width', 'gradient', 'rotation', 'transparency', 'fill_transparency', 'allow_overlap', 'layout_role'],
            },
            'gradient': {
                'keys': ['style', 'start_color', 'end_color', 'angle', 'border', 'x_offset', 'y_offset', 'start_intensity', 'end_intensity'],
                'camelCaseAliases': ['startColor', 'endColor', 'xOffset', 'yOffset', 'startIntensity', 'endIntensity'],
                'example': {'style': 'linear', 'start_color': '#0F172A', 'end_color': '#2563EB', 'angle': 45, 'border': 0, 'x_offset': 50, 'y_offset': 50, 'start_intensity': 100, 'end_intensity': 90},
                'rejectedKeys': ['type', 'colors'],
            },
            'layoutRole': {
                'values': ['content', 'container', 'decoration', 'background'],
                'rule': 'Content participates in overlap validation. Containers, decoration, and backgrounds describe intentional non-content layers; do not use them to hide text/image collisions.',
            },
            'chartSeries': {
                'singleSeries': "values=[12, 18, 27], series_name='Revenue'",
                'multipleSeries': "series=[{'name': 'Actual', 'values': [12, 18]}, {'name': 'Plan', 'values': [14, 20]}]",
                'scatter': "categories=[]; series=[{'name':'Samples', 'x':[1,2,4], 'y':[8,13,21]}]. Each series may have its own numeric X values and sample count. Never use category strings as X or flatten pairs.",
                'bubble': "categories=[]; series=[{'name':'Samples', 'x':[1,2], 'y':[8,13], 'sizes':[4,9]}]. Positive sizes are required. Per-series X/Y/sizes lengths must agree; different series may have different counts.",
                'stock': "categories=['Day 1','Day 2']; series=[{'name':'Price', 'open':[10,12], 'high':[14,16], 'low':[8,11], 'close':[12,15]}]. Four equal-length roles are required, with low <= open/close <= high. They are not four unrelated lines.",
                'pointTupleCompatibility': "Scatter also accepts values=[[x,y], ...], bubble values=[[x,y,size], ...]. Do not combine tuple values and named role arrays. Prefer named arrays in new code.",
                'axisBounds': 'Optional numeric x_axis_min/x_axis_max/y_axis_min/y_axis_max control visible axis bounds; each minimum must be below its maximum. For bubbles near plot edges, expand the axis range and chart box, not x/y/sizes data. Data overlap can be intrinsic; never move samples or change relative sizes to disguise it.',
                'axisScales': "scatter/bubble accept x_axis_scale='linear'|'log10' and y_axis_scale='linear'|'log10'. Log scales preserve stored data and require all values/bounds positive; explicitly label the scale. axis_position='outside' (default) keeps axes/ticks on plot edges; 'zero' requests internal zero crossing. x/y titles and bounds refer to physical horizontal/vertical axes, including bar.",
                'appearance': "font_name, font_color, grid_color, gridlines=True, line_width=1.5 (pt), series_transparency=0..100. title=None suppresses the internal title, including for single series. symbols=None enables marks only for line/scatter; stock always suppresses marks. Filled-radar defaults to 45% transparency. Dense line/area/radar/scatter/bubble/stock families default show_values=False. Set True only after budgeting label space. Use shared theme helpers rather than repeated per-point styling.",
                'chartTypes': ['area', 'bar', 'column', 'bubble', 'donut', 'doughnut', 'filled-radar', 'line', 'pie', 'radar', 'scatter', 'stock'],
                'labelRule': 'Category charts require semantic categories; scatter/bubble use numeric X and may pass categories=[]. Supply meaningful series names, axis units and appropriate labels. Pie/donut: legend + percent-only OR category-only without legend, never multiple label modes.',
            },
            'timelineEvent': {
                'accepted': ["{'title': '1990', 'body': 'Milestone'}", "('1990', 'Milestone')"],
                'rules': 'Any item count is supported; max_items_per_row controls automatic row wrapping.',
            },
        })
    elif document_type == 'word':
        shared.update({
            'measurement': {'nativeUnit': '1/100 mm', 'helpers': ['document.mm', 'document.cm', 'document.inch', 'document.pt']},
            'richRun': {'example': "{'text': 'OpenAI', 'bold': True, 'color': '#2563EB', 'link': 'https://openai.com'}"},
            'table': {'rows': 'rectangular list of row lists', 'columnWidths': 'relative percentages, for example [35, 65]'},
        })
    else:
        shared.update({
            'address': {'cell': 'A1', 'range': 'A1:D20', 'column': 'A or 1'},
            'cellValue': {'accepted': ['string', 'finite number', 'boolean', 'formula string beginning with =', 'None']},
            'box': {'nativeUnit': '1/100 mm', 'accepted': ['(x, y, width, height)', "{'x': x, 'y': y, 'width': width, 'height': height}"]},
        })
    return shared


def facade_example_library(document_type):
    if document_type == 'presentation':
        return {
            'documentLifecycle': """deck = job.presentation('deck')
deck.set_doc_info(title='Annual review', author='WebPilot', keywords=['review', '2026'])
# ... add every slide ...
deck.save()
deck.close()""",
            'documentIntrospection': """slide_summaries = deck.slides()
master_summaries = deck.masters()
# Each returned item is plain metadata; continue authoring through deck/slide facade methods.""",
            'layouts': """cover = deck.slide('cover', layout='title-cover', title='Annual review')
section = deck.slide('section', layout='title-section', title='02  Market')
content = deck.slide('content', layout='title-content', title='Highlights')
comparison = deck.slide('compare', layout='title-two-column', title='Actual vs plan')
dashboard = deck.slide('dashboard', layout='title-three-column', title='Dashboard')
blank = deck.slide('blank', layout='blank')""",
            'allocatedLayout': """slide = deck.slide('kpis', layout='title-content', title='Key metrics')
# Header/footer use layout-reserved margins. Do not draw a manual rule through
# the title slot.
slide.add_header('header', left='Performance', accent='#F59E0B')
slide.add_footer('footer', left='Brand', center='Metrics', right='01')
# Prefer slide.grid/stack for inch-first composition. grid returns one FLAT
# list in row-major order (not nested rows). Each cell is a mapping with
# x/y/width/height plus PptxGenJS-compatible w/h aliases and a unit marker.
# Pass cells directly to slide.add_*; never flatten/extend or tuple-index them.
cards = slide.grid(3, 1, slot='body', gap=0.25)
for index, cell in enumerate(cards):
    slide.add_card(f'kpi-{index + 1}', f'KPI {index + 1}', 'Measured body copy',
        box=cell, title_size=20, body_size=16, fill='#EFF6FF', accent='#2563EB')
rows = slide.stack(2, box=(0.8, 1.6, 5.6, 4.8), gap=0.20, weights=[1, 1])
row_x, row_y, row_w, row_h = rows[0]['x'], rows[0]['y'], rows[0]['w'], rows[0]['h']
slide.add_text('row-1', 'Auto-height text', box={'x': 0.8, 'y': 1.6, 'w': 5.6},
    auto_height=True, style={'font_size': 18, 'min_font_size': 16, 'padding': 0.04})""",
            'textAndPanel': """slide.add_text(
    'insight', 'Revenue grew 18% year over year.', box=(0.8, 1.4, 5.4, 1.1),
    # This is the exact style vocabulary. Common guessed keys such as
    # letter_spacing, tracking, margin, autofit, and word_wrap are not supported.
    style={'font_size': 24, 'min_font_size': 18, 'bold': True,
           'color': '#0F172A', 'background': '#EFF6FF',
           'border': {'color': '#93C5FD', 'width': 1.25},
           'padding': 0.16, 'align': 'LEFT', 'valign': 'MIDDLE'})""",
            'richTextBulletsAndLink': """slide.add_rich_text('rich', [
    {'text': 'Strong ', 'bold': True, 'color': '#0F172A'},
    {'text': 'evidence', 'italic': True, 'link': 'https://example.com'},
], box=(0.8, 2.7, 5.2, 0.7), style={'font_size': 18})
slide.add_bullets('actions', ['Approve scope', 'Publish result'], slot='body', style={'font_size': 18})
slide.add_link('source-link', 'Open source', box=(0.8, 6.6, 2.0, 0.35), url='https://example.com')""",
            'captionedImage': """slide.add_captioned_image(
    'jwst', 'jwst.jpg', 'James Webb Space Telescope',
    source='NASA / ESA / CSA', alt_text='JWST in space',
    box=(0.8, 1.6, 5.7, 4.8), contain=True, caption_height=0.62)""",
            'imagePlacementVariants': """slide.add_image(
    'contained-photo', 'photo.jpg', box=(0.8, 1.5, 5.4, 3.4), contain=True,
    padding=0.08, rotation=0, transparency=0,
    title='Mission photograph', alt_text='Mission hardware in a clean room',
    source='NASA')
slide.add_image(
    'cropped-photo', 'photo.jpg', box=(6.8, 1.5, 5.4, 3.4), contain=False,
    crop={'left': 100, 'top': 50, 'right': 100, 'bottom': 50})""",
            'shapesAndConnector': """left = slide.add_shape('left-node', box=(0.8, 2.0, 2.2, 1.0),
    shape_type='round-rectangle', fill='#DBEAFE',
    line={'color': '#2563EB', 'width': 1.5})
right = slide.add_shape('right-node', box={'x': 4.2, 'y': 2.0, 'w': 2.2, 'h': 1.0},
    shape_type='diamond', gradient={'style': 'linear', 'start_color': '#DCFCE7',
        'end_color': '#86EFAC', 'angle': 45, 'border': 0,
        'x_offset': 50, 'y_offset': 50, 'start_intensity': 100, 'end_intensity': 85},
    transparency=5)
slide.connect('flow', 'left-node', 'right-node', color='#64748B', width=2,
    startArrow='none', endArrow='triangle')
left.set_text('Input', {'font_size': 18, 'bold': True, 'valign': 'MIDDLE'})
right.set_text('Decision', {'font_size': 18, 'bold': True, 'valign': 'CENTER'})
slide.set_background('#F8FAFC', transparency=0)
# Gradient background shorthand is first-class; do not emulate it with a
# full-slide content shape.
slide.set_background('linear', '#020617', '#1E3A8A', 135)
group = slide.group('decision-flow', [left, right])""",
            'specializedShapeCapabilities': """# These calls are distinct semantic capabilities. A lookalike does not count.
rectangle = slide.add_shape('rectangle', box=(0.7, 1.5, 1.4, 0.7),
    shape_type='rectangle', fill='#DBEAFE', line='#2563EB')
ellipse = slide.add_shape('ellipse', box=(2.3, 1.5, 1.4, 0.7),
    shape_type='ellipse', fill='#DCFCE7', line='#16A34A')
custom = slide.add_shape('custom', box=(3.9, 1.5, 1.4, 0.7),
    shape_type='diamond', fill='#FEF3C7', line='#D97706')
caption = slide.add_shape('caption', box=(5.5, 1.5, 2.0, 0.9),
    shape_type='caption', fill='#FCE7F3', line='#DB2777')
caption.set_text('Native caption', {'font_size': 14, 'valign': 'CENTER'})
measure = slide.add_shape('measure', box=(7.8, 1.7, 2.0, 0.35),
    shape_type='measure', line='#7C3AED', line_width=2)
line = slide.add_shape('line', box=(10.1, 1.7, 1.8, 0.15),
    shape_type='line', line='#475569', line_width=2)
slide.add_text('text-shape', 'Native TextShape', box=(0.7, 3.0, 2.4, 0.6),
    style={'font_size': 16, 'min_font_size': 16})
slide.add_image('graphic-object', 'photo.jpg', box=(3.4, 2.7, 2.4, 1.4),
    contain=True, alt_text='Embedded GraphicObject')
source = slide.add_shape('source-node', box=(6.3, 3.0, 1.8, 0.7),
    shape_type='round-rectangle', fill='#E0E7FF')
target = slide.add_shape('target-node', box=(9.1, 3.0, 1.8, 0.7),
    shape_type='round-rectangle', fill='#E0E7FF')
slide.connect('connector-shape', 'source-node', 'target-node',
    color='#4F46E5', width=2, endArrow='triangle')
# Validation reports exact generated featureCounts keys: RectangleShape,
# EllipseShape, CustomShape, CaptionShape, MeasureShape, LineShape, TextShape,
# GraphicObject, and ConnectorShape.""",
            'nativeTableAndEdit': """table = slide.add_table('metrics', [
    ['Metric', 'Actual', 'Plan'], ['Revenue', '190', '180'], ['Margin', '31%', '29%'], ['', '', ''],
], box=(0.8, 1.6, 6.0, 3.2), column_weights=[2, 1, 1], header=True,
    header_fill='#0F172A', header_color='#FFFFFF', body_fill='#F8FAFC',
    alternate_fill='#FFFFFF', body_color='#1E293B', font_size=14,
    font_name='Calibri', first_column_align='LEFT')
table.set_cell(1, 1, '195', bold=True, color='#166534')
# set_cell uses zero-based (column, row). Merge uses existing A1 addresses;
# reserve an empty notes row so merging does not combine business data.
table.merge('A4', 'C4')
table.set_cell(0, 3, 'Illustrative data', font_size=11)
# Use header=False when the first row is ordinary body data. col_widths is a
# compatibility alias for column_weights; never pass both names together.
plain = slide.add_table('plain-data', [['A', '1'], ['B', '2']],
    box=(7.2, 1.6, 4.8, 2.4), header=False, col_widths=[2, 1])""",
            'nativeColumnChart': """slide.add_chart(
    'revenue-chart', 'column', ['Q1', 'Q2', 'Q3', 'Q4'],
    box=(6.8, 1.5, 5.7, 4.8),
    series=[{'name': 'Actual', 'values': [120, 145, 168, 190]},
            {'name': 'Plan', 'values': [115, 140, 160, 180]}],
    title='Quarterly revenue', x_axis_title='Quarter', y_axis_title='Revenue (M)',
    show_legend=True, show_values=True, colors=['#2563EB', '#94A3B8'])""",
            'nativePieChart': """slide.add_chart(
    'mix-chart', 'donut', ['Hardware', 'Software', 'Services'],
    box=(0.8, 1.5, 5.4, 4.8), values=[42, 36, 22], series_name='Revenue mix',
    title='Revenue mix', show_legend=True, show_values=False,
    show_category_name=False, show_percent=True,
    colors=['#2563EB', '#10B981', '#F59E0B'])""",
            'nativeRoleCharts': """scatter_slide = deck.slide('scatter-example', layout='blank')
scatter_slide.add_chart('samples', 'scatter', [], box=(0.8,1.5,11.7,4.8),
    series=[{'name':'Samples', 'x':[1,2,4], 'y':[8,13,21]}],
    title='Latency vs compute', x_axis_title='Compute', y_axis_title='Latency (ms)', lines=False)
# X, Y and size are separate numeric roles, NOT three independent series.
bubble_slide = deck.slide('bubble-example', layout='blank')
bubble_slide.add_chart('cost', 'bubble', [], box=(0.8,1.5,11.7,4.8),
    series=[{'name':'Models', 'x':[1,2], 'y':[8,13], 'sizes':[4,9]}],
    title='Cost vs compute', x_axis_title='Compute', y_axis_title='Cost')
# One candle series, ordered Open / High / Low / Close.
stock_slide = deck.slide('stock-example', layout='blank')
stock_slide.add_chart('price', 'stock', ['Day 1','Day 2'], box=(0.8,1.5,11.7,4.8),
    series=[{'name':'Price', 'open':[10,12], 'high':[14,16], 'low':[8,11], 'close':[12,15]}],
    title='Price interval', x_axis_title='Day', y_axis_title='Price', show_legend=False)""",
            'timeline': """slide.add_timeline('roadmap', [
    {'title': 'Q1', 'body': 'Research'}, {'title': 'Q2', 'body': 'Prototype'},
    {'title': 'Q3', 'body': 'Pilot'}, {'title': 'Q4', 'body': 'Launch'},
    {'title': '2027 H1', 'body': 'Scale'}, {'title': '2027 H2', 'body': 'Expand'},
    {'title': '2028', 'body': 'Optimize'},
], box=(0.7, 1.6, 12.0, 4.9), colors=['#2563EB', '#10B981'],
    title_size=16, body_size=11, text_color='#CBD5E1', max_items_per_row=4)""",
            'backgroundTransitionAndNotes': """slide.set_background('#F8FAFC', transparency=0)
# Full-slide gradients are first-class and excluded from content-overlap checks.
slide.set_background('linear', '#020617', '#1E3A8A', 135)
# The equivalent explicit schema is also supported:
slide.set_background('#020617', gradient={'style': 'linear',
    'start_color': '#020617', 'end_color': '#1E3A8A', 'angle': 135})
slide.set_transition('fade', speed='medium')
slide.set_notes('speaker-notes', 'Explain the assumptions before discussing the forecast.')
slide.add_comment('review-comment', 'Verify source date.', author='Reviewer')""",
            'professionalFeatures': """media = slide.add_media(
    'demo-video', 'demo.mp4', box=(0.8, 1.5, 5.4, 3.2), media_type='video')
shape = slide.add_shape('animated-card', box=(6.7, 1.5, 5.2, 1.0),
    shape_type='round-rectangle', fill='#DBEAFE')
slide.animate(shape, effect='fade', speed='medium')
slide.apply_master(index=deck.masters()[0]['index'])  # master indices are one-based
slide.add_field('page-number', field_type='page-number',
    box=(11.8, 7.0, 0.7, 0.25), style={'font_size': 10, 'align': 'RIGHT'})
deck.add_custom_show('Executive review', [1])  # custom show slide indices are one-based""",
            'existingDeckEdit': """deck = job.presentation('source', source_name='source.pptx')
slide = deck.select_slide('target-slide', index=2)
shape = slide.select_shape('target-title', text='Old title')
shape.replace_text('Old title', 'New title', replace_all=False)
shape.set_box((0.8, 0.45, 11.7, 0.7))
shape.set_style(font_size=28, color='#0F172A', bold=True)
deck.save()
deck.close()""",
            'existingSlideOperations': """selected = deck.select_slide('selected-slide', name='Overview')
copied = deck.duplicate_slide('copied-slide', index=1)
deck.move_slide(from_index=2, to_index=0)
deck.remove_slide(index=3)""",
            'existingShapeOperations': """shape = slide.select_shape('selected-shape', name='Title 1')
shape.set_text('Updated title', {'font_size': 28, 'bold': True})
shape.replace_text('Updated', 'Final', replace_all=False)
shape.set_box((0.8, 0.45, 11.7, 0.7))
shape.set_style(fill='#EFF6FF', color='#0F172A', bold=True)
shape.bring_to_front()
shape.send_to_back()
shape.remove()""",
            'preserveOnlyDeck': """deck = job.presentation('source', source_name='source.pptx')
# SmartArt, Morph, ActiveX, and OLE content is preserve-only: do not select,
# recreate, rewrite, or emulate it. Make supported edits elsewhere, then save.
deck.save()
deck.close()""",
            'unsupportedPresentationAuthoring': """# No facade call exists for authoring SmartArt, Morph, VBA, digital
# signatures, or IRM policy. Do not guess a raw UNO fallback; report the
# unsupported requirement or preserve existing package content unchanged.""",
        }
    if document_type == 'word':
        return {
            'documentLifecycle': """document = job.writer('report')
document.set_doc_info(title='Quarterly report', author='WebPilot')
document.set_page('page', width=document.mm(210), height=document.mm(297),
    margins=(document.mm(20), document.mm(20), document.mm(18), document.mm(18)))
document.set_header_footer(header='Quarterly report', footer='Confidential',
    header_element_id='header', footer_element_id='footer')
document.add_title('title', 'Quarterly report')
document.save()
document.close()""",
            'flowAndStyles': """document.define_paragraph_style('callout-style', 'Callout', parent='Standard',
    font_size=12, color='#1E3A8A', background='#EFF6FF')
document.add_heading('overview', 'Overview', level=2)
document.add_paragraph('summary', 'Native Writer flow paginates automatically.',
    font_size=11, color='#0F172A', line_spacing=1.3)
document.add_rich_paragraph('evidence', [
    {'text': 'Source: ', 'bold': True},
    {'text': 'Open report', 'link': 'https://example.com', 'color': '#2563EB'},
])
document.add_bullets('benefits', ['Readable', 'Editable'])
document.add_numbered_list('steps', ['Review', 'Approve', 'Publish'])""",
            'tableAndMerge': """document.add_table('metrics', [
    ['Metric', 'Actual', 'Plan'], ['Revenue', '190', '180'], ['Margin', '31%', '29%'],
], column_widths=[40, 30, 30], header=True, font_size=10)
document.merge_table_cells('metrics-merge', 'metrics', 'A4', 'C4')""",
            'imageAndFrame': """document.add_inline_image('diagram', 'diagram.png', width=document.mm(150),
    align='CENTER', space_after=document.mm(4))
document.add_text_frame('callout', 'Key finding', width=document.mm(70), height=document.mm(24),
    background='#FEF3C7')""",
            'navigationAndReview': """document.add_bookmark('scope-bookmark', 'scope', 'Scope')
document.add_hyperlink('source', 'Open source', 'https://example.com')
document.add_cross_reference('scope-ref', 'scope', part='text')
document.add_field('page-number', 'page-number', text_before='Page ')
document.add_toc('toc', title='Contents')
document.add_note('footnote-1', 'Methodology source.', kind='footnote')
document.add_comment('comment-1', 'Verify this figure.', author='Reviewer')""",
            'sectionsAndObjects': """document.add_section('appendix', 'Appendix', columns=2)
document.add_formula('equation', 'E = mc^2')
document.add_chart('trend', ['Q1', 'Q2', 'Q3'], [12, 18, 27],
    title='Quarterly trend', series_name='Revenue')
document.add_page_break('next-page')""",
            'existingDocumentEdit': """document = job.writer('source', source_name='source.docx')
document.replace_text('requested-change', 'Old exact text', 'New text', replace_all=False)
document.save()
document.close()""",
            'contentControl': """document.add_content_control(
    'customer-name', text='Enter customer name', tag='customer_name',
    title='Customer name', locked=False)""",
            'mailMergeProtection': """document.add_mail_merge_field(
    'customer-email', database='Customers', table='Contacts', column='Email')
document.protect(password='review-only')""",
            'preserveOnlyDocument': """document = job.writer('source', source_name='source.docx')
# Tracked changes and complex embedded OLE content are preserve-only. Do not
# select, recreate, accept/reject, rewrite, or emulate them through guessed APIs.
document.save()
document.close()""",
            'unsupportedWriterAuthoring': """# No facade call exists for authoring VBA, digital signatures, or IRM policy.
# Do not guess a raw UNO fallback; report the unsupported requirement or
# preserve existing package content unchanged.""",
        }
    return {
        'documentLifecycle': """workbook = job.spreadsheet('workbook')
sheet = workbook.sheet('summary', 'Summary')
# ... populate sheets ...
workbook.save()
workbook.close()""",
        'cellsRangesAndFormatting': """sheet.set_cell('title', 'A1', 'Quarterly summary',
    style={'bold': True, 'font_size': 16, 'color': '#0F172A'})
sheet.set_range('data', 'A3', [
    ['Quarter', 'Actual', 'Plan'], ['Q1', 120, 115], ['Q2', 145, 140],
])
sheet.format('amounts', 'B4:C5', number_format='#,##0', background='#EFF6FF',
    bottom_border='#CBD5E1', border_width=25, horizontal='RIGHT')
sheet.column_width('quarter-width', 'A', workbook.mm(32))
sheet.row_height('title-height', 1, workbook.mm(10))""",
        'tableFilterAndFreeze': """sheet.add_database_table('sales-table', 'A3', [
    ['Quarter', 'Actual', 'Plan'], ['Q1', 120, 115], ['Q2', 145, 140],
], header=True, auto_filter=True)
sheet.freeze('freeze-header', rows=3, columns=1)
sheet.sort('sort-sales', 'A3:C5', key=2, ascending=False, contains_header=True)
sheet.named_range('sales-range', 'SalesData', 'A3:C5')""",
        'validationAndConditionalFormatting': """sheet.data_validation('status-list', 'D4:D100', 'list',
    values=['Open', 'Blocked', 'Done'], allow_blank=True)
sheet.conditional_format('late-items', 'E4:E100', 'greater', '0',
    background='#FEE2E2', color='#991B1B', bold=True)""",
        'chartImageCommentAndLink': """sheet.add_chart('sales-chart', 'A3:C5', (12000, 1200, 13000, 8000),
    chart_type='column', title='Actual vs plan', legend=True)
sheet.add_image('logo', 'logo.png', (500, 500, 4000, 1400))
sheet.add_comment('review-note', 'B4', 'Verify source.', author='Reviewer')
sheet.add_hyperlink('source-link', 'A20', 'Open source', 'https://example.com')""",
        'printProtectionAndAnalysis': """sheet.print_setup('print', orientation='landscape', fit_to_pages=1,
    repeat_rows='A1:XFD3')
sheet.protect('sheet-password')
sheet.add_pivot('sales-pivot', 'A3:C100', 'F3', row_fields=[0], data_fields=[1])
sheet.add_scenario('growth-case', 'Growth', 'B4:B5', [[130], [160]], comment='Upside')
sheet.goal_seek('goal', 'C10', 'B10', 1000)""",
        'existingWorkbookEdit': """workbook = job.spreadsheet('source', source_name='source.xlsx')
sheet = workbook.select_sheet('summary', 'Summary')
sheet.set_cell('updated-status', 'D2', 'Ready')
workbook.save()
workbook.close()""",
        'preserveOnlyWorkbook': """workbook = job.spreadsheet('source', source_name='source.xlsx')
# OOXML structured tables, slicers/timelines, modern charts, ActiveX, and
# external links are preserve-only. Edit supported cells elsewhere, then save.
workbook.save()
workbook.close()""",
        'unsupportedCalcAuthoring': """# No facade call exists for authoring slicers, VBA, digital signatures, or IRM.
# Do not guess a raw UNO fallback; report the unsupported requirement or
# preserve existing package content unchanged.""",
    }


def facade_module_example_keys(document_type):
    return {
        'presentation': {
            'presentation.document@2': ['documentLifecycle', 'documentIntrospection'],
            'presentation.slide@2': ['documentLifecycle', 'layouts', 'allocatedLayout'],
            'presentation.existing-slide@1': ['existingDeckEdit', 'existingSlideOperations'],
            'presentation.existing-shape@1': ['existingDeckEdit', 'existingShapeOperations'],
            'presentation.text@2': ['textAndPanel', 'richTextBulletsAndLink', 'allocatedLayout'],
            'presentation.image@2': ['captionedImage', 'imagePlacementVariants'],
            'presentation.shape@2': ['shapesAndConnector', 'specializedShapeCapabilities'],
            'presentation.table@1': ['nativeTableAndEdit'],
            'presentation.chart@2': ['nativeColumnChart', 'nativePieChart', 'nativeRoleCharts'],
            'presentation.transition@1': ['backgroundTransitionAndNotes'],
            'presentation.professional@1': ['backgroundTransitionAndNotes', 'professionalFeatures'],
            'presentation.timeline@2': ['timeline'],
            'presentation.smartart@1': ['preserveOnlyDeck'],
            'presentation.morph@1': ['preserveOnlyDeck'],
            'presentation.activex-ole@1': ['preserveOnlyDeck'],
            'presentation.smartart-morph-vba-security-authoring@1': ['unsupportedPresentationAuthoring'],
        },
        'word': {
            'writer.flow@2': ['documentLifecycle', 'flowAndStyles', 'existingDocumentEdit'],
            'writer.styles@1': ['flowAndStyles'],
            'writer.list@1': ['flowAndStyles'],
            'writer.table@2': ['tableAndMerge'],
            'writer.image-frame@1': ['imageAndFrame'],
            'writer.page-style@1': ['documentLifecycle'],
            'writer.header-footer@1': ['documentLifecycle'],
            'writer.fields-navigation@1': ['navigationAndReview'],
            'writer.notes-review@1': ['navigationAndReview'],
            'writer.content-control@1': ['contentControl'],
            'writer.objects@1': ['sectionsAndObjects'],
            'writer.mail-merge-protection@1': ['mailMergeProtection'],
            'writer.tracked-changes@1': ['preserveOnlyDocument'],
            'writer.complex-ole@1': ['preserveOnlyDocument'],
            'writer.vba-digital-signature-irm-authoring@1': ['unsupportedWriterAuthoring'],
        },
        'spreadsheet': {
            'calc.sheet@2': ['documentLifecycle', 'existingWorkbookEdit'],
            'calc.cell-range@2': ['cellsRangesAndFormatting'],
            'calc.table@2': ['tableFilterAndFreeze'],
            'calc.format@2': ['cellsRangesAndFormatting'],
            'calc.freeze-merge@1': ['tableFilterAndFreeze'],
            'calc.validation-conditional@1': ['validationAndConditionalFormatting'],
            'calc.sort-filter-names-outline@1': ['tableFilterAndFreeze'],
            'calc.chart-image@1': ['chartImageCommentAndLink'],
            'calc.comments-links@1': ['chartImageCommentAndLink'],
            'calc.print-protection@1': ['printProtectionAndAnalysis'],
            'calc-pivot-scenario-goalseek@1': ['printProtectionAndAnalysis'],
            'calc.structured-table@1': ['preserveOnlyWorkbook'],
            'calc.slicer-timeline-modern-chart@1': ['preserveOnlyWorkbook'],
            'calc.activex-external-link@1': ['preserveOnlyWorkbook'],
            'calc.slicer-vba-signature-irm-authoring@1': ['unsupportedCalcAuthoring'],
        },
    }[document_type]


def office_facade_cookbook(document_type, query=''):
    """Return an exact, example-complete module from the model-facing facade."""
    shared_rules = [
        'Write exactly one synchronous create_document(job) function.',
        'Create the Office facade inside create_document(job), keep all authored calls inside it, then call facade.save() exactly once followed by facade.close() exactly once.',
        'Use only the returned high-level facade and versioned feature recipes. Never import uno or access com.sun.star services.',
        'Every document, slide, paragraph, table, chart, image, sheet, range, and feature call has a stable elementId.',
        'When the plan names an exact presentation capability such as CaptionShape, MeasureShape, or ConnectorShape, use the matching presentation.shape example and confirm its exact generated featureCounts key is non-zero. A visually similar shape never satisfies a semantic capability requirement.',
        'CaptionShape and MeasureShape are authored as native UNO services by the facade. Because LibreOffice drops those two services during PPTX export, the facade also emits one named editable DrawingML fallback at the same geometry; do not create a second manual lookalike.',
        'elementId accepts 1-128 non-whitespace Unicode characters, including Chinese. Child IDs on slide and worksheet facades are parent-scoped, so helpers may reuse role IDs across different parents.',
        "Query unoApi one module at a time before using that module. Each module response contains every matching installed signature, accepted value schema, and copyable example; copy these patterns instead of guessing.",
        "For presentation text, use only the exact style keys returned by presentation.text. letter_spacing/tracking/margin/autofit/word_wrap are deliberately unsupported; use padding, line_spacing, min_font_size, box geometry, or auto_height instead.",
        "Presentation slide.add_* explicit box values default to inches, accept w/h aliases, and may set unit='in'|'mm'|'cm'|'pt'|'hmm'. Layout slots are already normalized.",
        "New presentation decks are always 13.333 x 7.5 inches with horizontal center x=6.6665. Never use a 10 x 7.5 inch canvas; align='CENTER' affects text inside a box, not the box position. Prefer named slots or derive freeform boxes from deck.bounds()/deck.content_box().",
        'Use facade layout, flow, A1-address, style, and feature parameters; the worker owns UNO units, structs, enums, controllers, and output filters.',
        "A support level of preserve-only means existing content is package-compared and must survive unchanged; it is not an authoring API. unsupported means fail explicitly rather than emulating with raw UNO.",
        'Call save() exactly once and close() exactly once. Failed validation keeps this same editable source and may be repaired with multiple independent atomic edits in one call.',
    ]
    if document_type == 'presentation':
        capabilities = [
            {'id': 'presentation.document@2', 'support': 'full', 'kind': 'core', 'keywords': ['metadata', 'slides', 'master'], 'signature': "deck.set_doc_info(...); deck.slides(); deck.masters()", 'validation': ['package', 'reopen']},
            {'id': 'presentation.slide@2', 'support': 'full', 'kind': 'core', 'keywords': ['slide', 'layout', 'slot', 'grid', 'stack', 'header', 'footer'], 'signature': "deck.slide(element_id, layout='title-content', title=None, title_style=None); slide.grid(columns,rows,slot='body',box=None,gap=0.24,...); slide.stack(count,slot='body',box=None,direction='vertical',gap=0.18,...); slide.add_header(element_id,left='',center='',right='',accent=None,...); slide.add_footer(element_id,left='',center='',right='',accent=None,...); layouts: blank, cover/title-cover, section/title-section, title-only, title-content, title-two-column/comparison, title-three-column/dashboard", 'validation': ['bounds', 'overlap', 'text-fit']},
            {'id': 'presentation.existing-slide@1', 'support': 'full', 'kind': 'edit', 'keywords': ['select', 'remove', 'move', 'duplicate'], 'signature': "deck.select_slide(element_id, index=None, name=None, text=None); deck.remove_slide(index); deck.move_slide(from_index, to_index); deck.duplicate_slide(element_id, index)", 'validation': ['slide-count', 'preservation']},
            {'id': 'presentation.existing-shape@1', 'support': 'full', 'kind': 'edit', 'keywords': ['shape', 'replace', 'resize', 'z-order'], 'signature': "slide.select_shape(element_id, index=None, name=None, text=None) -> shape.set_text/replace_text/set_box/set_style/remove/bring_to_front/send_to_back; slide.replace_text(...) ", 'validation': ['bounds', 'overlap', 'content']},
            {'id': 'presentation.text@2', 'support': 'full', 'kind': 'core', 'keywords': ['text', 'rich-text', 'bullets', 'link', 'auto-height'], 'signature': "slide.add_text(element_id,text,slot=None,box=None,style=None,auto_height=False); omit box h/height or set auto_height=True to derive measured height; slide.add_rich_text(...); slide.add_bullets(...); exact style keys: font_size,min_font_size,bold,italic,underline,strike,color,font_name,align,valign,padding,line_spacing,background,border,link,rotation; unsupported: letter_spacing,tracking,margin,autofit,word_wrap", 'validation': ['bounds', 'overlap', 'text-fit']},
            {'id': 'presentation.image@2', 'support': 'full', 'kind': 'core', 'keywords': ['image', 'crop', 'rotate', 'contain', 'caption', 'alt', 'source'], 'signature': "slide.add_image(element_id, asset_name, slot=None, box=None, contain=True, padding=0, crop=None, rotation=0, transparency=0, alt_text=None, title=None, source=None); slide.add_captioned_image(element_id, asset_name, caption, source=None, alt_text=None, ..., caption_height=0.62)", 'validation': ['bounds', 'aspect-ratio', 'embedded-media', 'accessibility-metadata', 'visible-identification']},
            {'id': 'presentation.shape@2', 'support': 'full', 'kind': 'native', 'keywords': ['shape', 'connector', 'caption', 'measure', 'background', 'gradient', 'group'], 'signature': "slide.add_shape(element_id,slot=None,box=None,shape_type='rectangle|round-rectangle|ellipse|line|diamond|triangle|right-triangle|parallelogram|trapezoid|pentagon|hexagon|octagon|star|caption|measure',fill=None,line=None,gradient=None,rotation=0,...); slide.connect(element_id, source_box_or_child_id, target_box_or_child_id, end_arrow=True, start_arrow_width=None, end_arrow_width=None, ...); never emulate an arrowhead with a separate triangle because the triangle box touching a target does not place its apex on the connector endpoint; slide.set_background(color, transparency=0); slide.set_background(style,start_color,end_color,angle=0); slide.group(element_id, shapes)", 'validation': ['bounds', 'overlap', 'featureCounts']},
            {'id': 'presentation.table@1', 'support': 'full', 'kind': 'native', 'keywords': ['table', 'editable'], 'signature': "slide.add_table(element_id, rows, slot=None, box=None, column_weights=None, header=True, header_fill=0x0F172A, header_color=0xFFFFFF, body_fill=0xF8FAFC, alternate_fill=0xFFFFFF, body_color=0x1E293B, font_size=11, font_name=None, first_column_align='LEFT'); col_widths is accepted as an alias for column_weights", 'validation': ['native-object', 'bounds', 'overlap']},
            {'id': 'presentation.chart@2', 'support': 'full', 'kind': 'native', 'keywords': ['chart', 'graph', 'editable', 'area', 'bar', 'bubble', 'donut', 'line', 'pie', 'radar', 'scatter', 'stock', 'label', 'legend', 'axis'], 'signature': "slide.add_chart(element_id, chart_type, categories, slot=None, box=None, values=None, series=None, series_name='Values', title=None, alt_text=None, x_axis_title=None, y_axis_title=None, show_legend=None, show_values=None, show_category_name=None, show_percent=None, background=None, legend_position='right', **options); background defaults transparent; pie/donut must not combine multiple label modes; semantic category strings are preserved in PPTX", 'validation': ['native-chart', 'embedded-data', 'category-labels', 'bounds', 'reopen-size']},
            {'id': 'presentation.transition@1', 'support': 'full', 'kind': 'recipe', 'keywords': ['transition', 'fade', 'wipe'], 'signature': "slide.set_transition(effect='fade', speed='medium')", 'validation': ['feature-count', 'reopen']},
            {'id': 'presentation.professional@1', 'support': 'partial', 'kind': 'native', 'keywords': ['animation', 'notes', 'comments', 'media', 'custom-show', 'master', 'field'], 'signature': "slide.set_notes(element_id,text); slide.add_comment(...); slide.add_media(...); slide.animate(shape,...); slide.apply_master(...); slide.add_field(...); deck.add_custom_show(name, slide_indices)", 'validation': ['notes', 'comments', 'media', 'animation', 'master-layout', 'fields']},
            {'id': 'presentation.timeline@2', 'support': 'full', 'kind': 'component', 'keywords': ['timeline', 'process'], 'signature': "slide.add_timeline(element_id, events, slot=None, box=None, colors=None, title_size=14, body_size=10, text_color=0x334155, max_items_per_row=6); dense timelines automatically wrap to multiple rows", 'validation': ['bounds', 'overlap']},
            {'id': 'presentation.smartart@1', 'support': 'preserve-only', 'kind': 'policy', 'keywords': ['smartart'], 'signature': None, 'validation': ['package-preservation']},
            {'id': 'presentation.morph@1', 'support': 'preserve-only', 'kind': 'policy', 'keywords': ['morph'], 'signature': None, 'validation': ['package-preservation']},
            {'id': 'presentation.activex-ole@1', 'support': 'preserve-only', 'kind': 'policy', 'keywords': ['activex', 'ole'], 'signature': None, 'validation': ['package-preservation']},
            {'id': 'presentation.smartart-morph-vba-security-authoring@1', 'support': 'unsupported', 'kind': 'policy', 'keywords': ['create-smartart', 'create-morph', 'vba', 'macro', 'signature', 'irm'], 'signature': None, 'validation': ['explicit-rejection']},
        ]
        complete = '''def create_document(job):
    deck = job.presentation('deck')
    slide = deck.slide('overview', layout='title-two-column', title='Quarterly overview')
    slide.add_header('header', left='Quarterly review', accent=0xF59E0B)
    slide.add_text('summary', 'Revenue and delivery remained on plan.', slot='left', style={'font_size': 20, 'min_font_size': 16, 'color': 0x334155})
    slide.add_chart('revenue', 'column', ['Q1', 'Q2', 'Q3', 'Q4'], slot='right', values=[120, 145, 168, 190], series_name='Revenue', title='Quarterly revenue', x_axis_title='Quarter', y_axis_title='Revenue', show_legend=True)
    slide.add_footer('footer', left='Confidential', center='Finance', right='01')
    slide.set_transition('fade', speed='medium')
    deck.save()
    deck.close()'''
        modification = '''def create_document(job):
    deck = job.presentation('source-deck', source_name='exact-source-asset-name.pptx')
    slide = deck.select_slide('edited-slide', index=1)
    slide.replace_text('title-update', 'Old exact title', 'New title', replace_all=False)
    deck.save()
    deck.close()'''
        operations = {
            'slide': "slide = deck.slide('overview', layout='title-two-column', title='Quarterly overview')",
            'chrome': "slide.add_header('header', left='Section', accent=0xF59E0B)\nslide.add_footer('footer', left='Brand', center='Section', right='01')",
            'text': "slide.add_text('summary', 'Body copy', slot='left', style={'font_size': 18, 'min_font_size': 16})",
            'chart': "slide.add_chart('trend', 'line', ['Q1', 'Q2', 'Q3'], slot='right', values=[12, 18, 27])",
            'transition': "slide.set_transition('fade', speed='medium')",
        }
        coverage = ['inch-first boxes with w/h aliases', 'named slide layouts and slots', 'existing slide and shape edits', 'measured and rich text', 'images and cropping', 'native tables', 'native editable chart families', 'cards', 'timelines', 'links', 'connectors', 'transitions', 'notes/comments/media/animations/custom shows/master assignment', 'immediate and reopen collision/bounds validation', 'preserve-only package gates']
        signatures = [item['signature'] for item in capabilities if item.get('signature')]
    elif document_type == 'word':
        capabilities = [
            {'id': 'writer.flow@2', 'support': 'full', 'kind': 'core', 'keywords': ['paragraph', 'heading', 'title', 'flow', 'rich-text'], 'signature': "document.add_paragraph(...); document.add_heading(element_id,value,level=1,color=0x1F2937,align='LEFT',font_name=None,font_size=None); document.add_title(element_id,value,color=0x1F2937,align='LEFT',font_name=None,font_size=None); document.add_rich_paragraph(element_id, runs,...); document.replace_text(element_id, old_text, new_text, replace_all=True)", 'validation': ['pagination', 'content']},
            {'id': 'writer.styles@1', 'support': 'full', 'kind': 'native', 'keywords': ['style', 'format'], 'signature': "document.define_paragraph_style(element_id, name, parent='Standard', **style)", 'validation': ['styles', 'reopen']},
            {'id': 'writer.list@1', 'support': 'full', 'kind': 'core', 'keywords': ['bullet', 'numbered', 'list'], 'signature': "document.add_bullets(element_id, values, **style); document.add_numbered_list(element_id, values, **style)", 'validation': ['pagination', 'content']},
            {'id': 'writer.table@2', 'support': 'full', 'kind': 'native', 'keywords': ['table', 'repeat-header', 'merge'], 'signature': "document.add_table(element_id, rows, column_widths=None, header=True, font_size=10, font_name=None, header_fill=0xE8EEF7, header_color=0x0F172A, body_color=0x1E293B); document.merge_table_cells(element_id, table_element_id, start_cell, end_cell)", 'validation': ['native-table', 'pagination']},
            {'id': 'writer.image-frame@1', 'support': 'full', 'kind': 'native', 'keywords': ['image', 'picture', 'inline', 'frame'], 'signature': "document.add_inline_image(...); document.add_text_frame(element_id,text,width,height,anchor='AS_CHARACTER',background=None)", 'validation': ['embedded-media', 'bounds', 'anchors']},
            {'id': 'writer.page-style@1', 'support': 'full', 'kind': 'recipe', 'keywords': ['page', 'margin', 'size', 'section'], 'signature': "document.feature('writer.page-style@1',...); document.add_section(element_id,name,columns=1,protected=False); document.add_page_break(element_id)", 'validation': ['page-geometry', 'sections']},
            {'id': 'writer.header-footer@1', 'support': 'full', 'kind': 'recipe', 'keywords': ['header', 'footer'], 'signature': "document.feature('writer.header-footer@1', element_id, header='...', footer='...')", 'validation': ['reopen', 'content']},
            {'id': 'writer.fields-navigation@1', 'support': 'full', 'kind': 'native', 'keywords': ['field', 'page-number', 'toc', 'index', 'bookmark', 'cross-reference', 'hyperlink'], 'signature': "document.add_field(...); document.add_toc(...); document.add_index(...); document.add_bookmark(...); document.add_cross_reference(...); document.add_hyperlink(...) ", 'validation': ['fields', 'bookmarks', 'hyperlinks']},
            {'id': 'writer.notes-review@1', 'support': 'full', 'kind': 'native', 'keywords': ['footnote', 'endnote', 'comment'], 'signature': "document.add_note(element_id,text,kind='footnote'); document.add_comment(element_id,text,author='User')", 'validation': ['footnotes', 'endnotes', 'comments']},
            {'id': 'writer.content-control@1', 'support': 'partial', 'kind': 'native', 'keywords': ['content-control', 'form'], 'signature': "document.add_content_control(element_id,text='',tag=None,title=None,locked=False)", 'validation': ['content-controls', 'reopen']},
            {'id': 'writer.objects@1', 'support': 'partial', 'kind': 'native', 'keywords': ['chart', 'formula', 'equation', 'ole'], 'signature': "document.add_chart(...); document.add_formula(element_id,formula,width=5000,height=1800)", 'validation': ['charts', 'embedded-objects', 'render']},
            {'id': 'writer.mail-merge-protection@1', 'support': 'partial', 'kind': 'native', 'keywords': ['mail-merge', 'protection'], 'signature': "document.add_mail_merge_field(...); document.protect(password='')", 'validation': ['fields', 'protection']},
            {'id': 'writer.tracked-changes@1', 'support': 'preserve-only', 'kind': 'policy', 'keywords': ['tracked-changes', 'redline'], 'signature': None, 'validation': ['package-preservation']},
            {'id': 'writer.complex-ole@1', 'support': 'preserve-only', 'kind': 'policy', 'keywords': ['complex-ole'], 'signature': None, 'validation': ['package-preservation']},
            {'id': 'writer.vba-digital-signature-irm-authoring@1', 'support': 'unsupported', 'kind': 'policy', 'keywords': ['create-vba', 'macro', 'sign-document', 'irm-policy'], 'signature': None, 'validation': ['explicit-rejection']},
        ]
        complete = '''def create_document(job):
    document = job.writer('report')
    document.feature('writer.page-style@1', 'page', width=document.mm(210), height=document.mm(297), margins=(document.mm(20), document.mm(20), document.mm(18), document.mm(18)))
    document.feature('writer.header-footer@1', 'chrome', header='Quarterly report', footer='Confidential')
    document.add_title('title', 'Quarterly report')
    document.add_paragraph('summary', 'Body content remains in native Writer flow.')
    document.add_numbered_list('actions', ['Confirm scope', 'Publish result'])
    document.add_table('metrics', [['Metric', 'Value'], ['Revenue', '190']], column_widths=[55, 45])
    document.save()
    document.close()'''
        modification = '''def create_document(job):
    document = job.writer('source-document', source_name='exact-source-asset-name.docx')
    document.replace_text('requested-update', 'Old exact text', 'New text', replace_all=False)
    document.save()
    document.close()'''
        operations = {
            'flow': "document.add_heading('section', 'Section', level=2)\ndocument.add_paragraph('body', 'Body text')",
            'table': "document.add_table('table', [['Field', 'Value'], ['Status', 'Ready']], column_widths=[40, 60])",
            'page': "document.feature('writer.page-style@1', 'page', width=document.mm(210), height=document.mm(297), margins=(document.mm(20), document.mm(20), document.mm(18), document.mm(18)))",
        }
        coverage = ['native flow pagination', 'existing text replacement', 'rich runs and hyperlinks', 'paragraph styles', 'bulleted and numbered lists', 'native tables and merges', 'inline images and frames', 'page styles/sections/headers/footers', 'fields/TOC/bookmarks', 'footnotes/endnotes/comments', 'content controls', 'charts/formulas', 'mail-merge fields/protection', 'preserve-only package gates']
        signatures = [item['signature'] for item in capabilities if item.get('signature')]
    else:
        capabilities = [
            {'id': 'calc.sheet@2', 'support': 'full', 'kind': 'core', 'keywords': ['sheet', 'worksheet', 'rename', 'copy', 'move', 'hide'], 'signature': "workbook.sheet(element_id,name); workbook.select_sheet(element_id,name); workbook.remove_sheet(name); workbook.copy_sheet(...); workbook.move_sheet(...); sheet.rename(...); sheet.hide(...) ", 'validation': ['sheet-count', 'content']},
            {'id': 'calc.cell-range@2', 'support': 'full', 'kind': 'core', 'keywords': ['cell', 'formula', 'a1', 'range'], 'signature': "sheet.set_cell(element_id,address,value,style=None); sheet.set_range(element_id,start,rows,style=None)", 'validation': ['cell-content', 'formula', 'range-content']},
            {'id': 'calc.table@2', 'support': 'full', 'kind': 'component', 'keywords': ['table', 'database-range', 'filter'], 'signature': "sheet.add_table(...) creates a styled range; sheet.add_database_table(...) creates a native Calc database range with sort/filter. Neither falsely claims OOXML structured-table recreation.", 'validation': ['range-content', 'style', 'filters']},
            {'id': 'calc.format@2', 'support': 'full', 'kind': 'core', 'keywords': ['format', 'number-format', 'border', 'width', 'height'], 'signature': "sheet.format(element_id,cell_range,font_size=None,bold=None,italic=None,underline=None,font_name=None,color=None,background=None,number_format=None,borders...,wrap=None,rotation=None,shrink_to_fit=None); sheet.column_width(...); sheet.row_height(...) ", 'validation': ['style', 'geometry']},
            {'id': 'calc.freeze-merge@1', 'support': 'full', 'kind': 'recipe', 'keywords': ['freeze', 'merge'], 'signature': "sheet.freeze(element_id='freeze-panes',rows=1,columns=0); sheet.merge(element_id,cell_range)", 'validation': ['freeze-panes', 'merged-ranges']},
            {'id': 'calc.validation-conditional@1', 'support': 'full', 'kind': 'native', 'keywords': ['data-validation', 'conditional-format'], 'signature': "sheet.data_validation(element_id,cell_range,validation_type,**options); sheet.conditional_format(element_id,cell_range,operator,formula,**style)", 'validation': ['data-validations', 'conditional-formats']},
            {'id': 'calc.sort-filter-names-outline@1', 'support': 'full', 'kind': 'native', 'keywords': ['sort', 'filter', 'named-range', 'subtotal', 'group', 'outline'], 'signature': "sheet.sort(...); sheet.auto_filter(...); sheet.named_range(...); sheet.group(...); sheet.ungroup(...); sheet.subtotals(...) ", 'validation': ['sort', 'filters', 'defined-names', 'outlines', 'subtotals']},
            {'id': 'calc.chart-image@1', 'support': 'full', 'kind': 'native', 'keywords': ['chart', 'image', 'drawing'], 'signature': "sheet.add_chart(element_id,cell_range,box,chart_type='column',title=None,legend=True,alt_text=None,anchor=None,reserve_space=False); sheet.add_image(element_id,asset_name,box,contain=False,padding=0,alt_text=None,title=None,anchor=None,reserve_space=False)", 'validation': ['native-charts', 'images', 'drawings']},
            {'id': 'calc.comments-links@1', 'support': 'full', 'kind': 'native', 'keywords': ['comment', 'hyperlink'], 'signature': "sheet.add_comment(...); sheet.add_hyperlink(...) ", 'validation': ['comments', 'hyperlinks']},
            {'id': 'calc.print-protection@1', 'support': 'full', 'kind': 'native', 'keywords': ['print', 'protection'], 'signature': "sheet.print_setup(...); sheet.protect(password=''); sheet.unprotect(password='')", 'validation': ['print-setup', 'protection']},
            {'id': 'calc-pivot-scenario-goalseek@1', 'support': 'partial', 'kind': 'native', 'keywords': ['pivot', 'datapilot', 'scenario', 'goal-seek'], 'signature': "sheet.add_pivot(...); sheet.add_scenario(...); sheet.goal_seek(...) ", 'validation': ['pivot-tables', 'scenarios', 'formula-result']},
            {'id': 'calc.structured-table@1', 'support': 'preserve-only', 'kind': 'policy', 'keywords': ['structured-table', 'excel-table'], 'signature': None, 'validation': ['package-preservation']},
            {'id': 'calc.slicer-timeline-modern-chart@1', 'support': 'preserve-only', 'kind': 'policy', 'keywords': ['slicer', 'timeline-filter', 'modern-chart', 'chartex'], 'signature': None, 'validation': ['package-preservation']},
            {'id': 'calc.activex-external-link@1', 'support': 'preserve-only', 'kind': 'policy', 'keywords': ['activex', 'external-link'], 'signature': None, 'validation': ['package-preservation']},
            {'id': 'calc.slicer-vba-signature-irm-authoring@1', 'support': 'unsupported', 'kind': 'policy', 'keywords': ['create-slicer', 'create-vba', 'macro', 'sign-workbook', 'irm'], 'signature': None, 'validation': ['explicit-rejection']},
        ]
        complete = '''def create_document(job):
    workbook = job.spreadsheet('workbook')
    sheet = workbook.sheet('summary', 'Summary')
    sheet.add_table('metrics', 'A1', [['Metric', 'Actual', 'Forecast'], ['Revenue', 1200, '=B2*1.2']])
    sheet.column_width('metric-width', 'A', workbook.mm(42))
    sheet.format('amounts', 'B2:C2', horizontal='RIGHT')
    sheet.freeze(rows=1)
    workbook.save()
    workbook.close()'''
        modification = '''def create_document(job):
    workbook = job.spreadsheet('source-workbook', source_name='exact-source-asset-name.xlsx')
    sheet = workbook.select_sheet('summary', 'Summary')
    sheet.set_cell('updated-status', 'D2', 'Ready')
    workbook.save()
    workbook.close()'''
        operations = {
            'cells': "sheet.set_cell('revenue', 'B2', 1200)\nsheet.set_cell('forecast', 'C2', '=B2*1.2')",
            'table': "sheet.add_table('metrics', 'A1', [['Metric', 'Value'], ['Revenue', 1200]])",
            'freeze': "sheet.freeze(rows=1)",
            'merge': "sheet.merge('title', 'A1:D1')",
        }
        coverage = ['A1 worksheet API', 'existing sheet lifecycle', 'strings numbers and formulas', 'range writes', 'styled/database tables', 'complete formatting and number formats', 'validation/conditional formatting', 'sort/filter/names', 'charts/images', 'comments/links', 'print/protection', 'pivot/scenario/goal seek', 'full used-range formula error scan', 'preserve-only package gates']
        signatures = [item['signature'] for item in capabilities if item.get('signature')]

    normalized_query = str(query or '').strip().lower()
    example_library = facade_example_library(document_type)
    module_examples = facade_module_example_keys(document_type)
    missing_example_modules = [
        item['id'] for item in capabilities
        if not module_examples.get(item['id'])
        or any(key not in example_library for key in module_examples.get(item['id'], []))
    ]
    if missing_example_modules:
        raise RuntimeError(
            'Facade cookbook modules require complete installed examples: '
            + ', '.join(missing_example_modules)
        )
    module_index = [{
        'query': item['id'],
        'support': item.get('support', 'full'),
        'kind': item.get('kind'),
        'keywords': item.get('keywords', []),
        'exampleGroups': module_examples.get(item['id'], []),
    } for item in capabilities]
    # Module IDs are identities, not search terms. In particular @1 must never
    # become a search for every signature containing the digit 1.
    selected = [item for item in capabilities if normalized_query and normalized_query in {
        str(item.get('id', '')).lower(), str(item.get('id', '')).lower().split('@', 1)[0],
    }]
    module_query = bool(re.fullmatch(r'(?:presentation|spreadsheet|calc|writer)\.[a-z0-9_.-]+(?:@\d+)?', normalized_query))
    query_terms = [term for term in re.split(r'[^a-z0-9_.-]+', re.sub(r'@\d+\b', '', normalized_query)) if term and not term.isdigit()]
    query_match_mode = 'exact-module' if selected else 'module-not-found' if module_query else 'keyword' if query_terms else 'index'
    if not selected and not module_query and query_terms:
        for item in capabilities:
            identity = str(item.get('id', '')).lower()
            identity_without_version = identity.split('@', 1)[0]
            haystack = ' '.join([
                identity,
                identity_without_version,
                str(item.get('kind', '')),
                str(item.get('signature', '')),
                *[str(value) for value in item.get('keywords', [])],
            ]).lower()
            if all(term in haystack for term in query_terms):
                selected.append(item)
    selected_example_keys = []
    for item in selected:
        for key in module_examples.get(item['id'], []):
            if key in example_library and key not in selected_example_keys:
                selected_example_keys.append(key)
    selected_examples = {key: example_library[key] for key in selected_example_keys}
    receiver_methods = set()
    for text in [*[str(item.get('signature') or '') for item in selected], *selected_examples.values()]:
        receiver_methods.update(re.findall(r'\b(job|document|workbook|sheet|deck|slide|shape|table)\.([A-Za-z_]\w*)\s*\(', text))
    api_reference = [item for item in facade_api_reference(document_type) if (item['receiver'], item['method']) in receiver_methods]
    value_schemas = facade_value_schemas(document_type)
    if document_type == 'presentation':
        # Keep common geometry/text contracts, but do not repeat unrelated
        # chart roles and shape/timeline options in every module response.
        methods = {method for _, method in receiver_methods}
        if 'add_chart' not in methods:
            value_schemas.pop('chartSeries', None)
        if not methods.intersection({'add_shape', 'set_background'}):
            value_schemas.pop('shapeStyle', None)
            value_schemas.pop('gradient', None)
        if 'add_timeline' not in methods:
            value_schemas.pop('timelineEvent', None)
    support_matrix = {
        level: [item['id'] for item in selected if item.get('support', 'full') == level]
        for level in ('full', 'partial', 'preserve-only', 'unsupported')
    }
    if not selected:
        return {
            'status': 'Choose one query from moduleIndex. Raw UNO reflection is intentionally not model-facing.',
            'delivery': 'module-index',
            'query': normalized_query or None,
            'queryMatched': False,
            'queryMatchMode': query_match_mode,
            'rules': shared_rules,
            'moduleIndex': module_index,
        }
    return {
        'status': 'Use only this installed high-level facade. Raw UNO reflection is intentionally not model-facing.',
        'delivery': 'module-executable-cookbook',
        'query': normalized_query,
        'queryMatched': True,
        'queryMatchMode': query_match_mode,
        'matchedModules': [item['id'] for item in selected],
        'moduleIndex': module_index,
        'capabilities': selected,
        'coverage': sorted({value for item in selected for value in item.get('validation', [])}),
        'supportMatrix': support_matrix,
        'rules': shared_rules,
        'facadeSignatures': [item['signature'] for item in api_reference],
        'apiReference': api_reference,
        'valueSchemas': value_schemas,
        'examples': selected_examples,
        'examplesAreInstalledFacadeUsage': True,
        'exampleCoverage': 'All example groups registered for every matched module are included without pagination.',
    }


def uno_cookbook(document_type):
    """Executable patterns for the high-frequency UNO authoring operations.

    Reflection tells the model which members exist, but not how UNO enum,
    constant-group, struct, cursor, table, and export APIs compose. Keep these
    examples next to the installed reflection response so authors can copy a
    known pattern instead of guessing from member names.
    """
    common_rules = [
        'Raw UNO geometry is in 1/100 mm. Read document bounds and, for Impress, prefer deck.mm/cm/inch/pt plus the high-level layout components; never assume A4 or a slide size.',
        'CharHeight is always measured in typographic points (pt), not 1/100 mm. Assign the requested point value directly; never multiply by 35.28 or any geometry conversion factor.',
        'uno.Enum(typeName, memberName) is for UNO enum types. uno.getConstantByName(fullyQualifiedName) is for constant groups. Never substitute guessed integers.',
        'Only import uno. Do not use from com.sun.star... imports in authored Python; this installed runtime resolves UNO enums, constants, and structs through uno.Enum(...), uno.getConstantByName(...), and uno.createUnoStruct(...).',
        'Create a fresh end cursor with cursor = doc.Text.createTextCursor(); cursor.gotoEnd(False) before appending Writer content.',
        'Use job.writer(element_id), job.presentation(element_id), or job.spreadsheet(element_id) by default. Every generated element requires a stable elementId.',
        'Element IDs are document-global. Every reusable helper accepts a caller-owned sid/id_prefix and derives distinct role suffixes; never reuse one suffix for a shape and its text or for multiple helper calls.',
        'Duplicate requested IDs are deterministically disambiguated as warnings so generation can continue, but durable source must repair the shared helper namespace instead of renaming one reported instance.',
        'For an unmodeled feature, call expert = job.expert(concrete_reason). If a stable facade already exists, use doc = expert.component(layout); otherwise create/open the raw document through expert and wrap it with the matching facade. Never guess layout.component/_component or use getattr(layout, ...). Register every created raw object with expert.tag(target, element_id, kind, locator).',
        'Do not use expert/raw UNO merely as a capability demonstration. Prefer stable facade components and use raw services only for a concrete requested feature the facade cannot express.',
        'ControlCharacter has paragraph/line characters but no PAGE_BREAK member. Writer page breaks use the paragraph BreakType enum.',
        'For Impress TextShape objects, assign Position and Size, call page.add(shape), and only then assign String/Text and text formatting. Text written before page.add(shape) is lost by this LibreOffice runtime.',
        'For an existing-file modification plan, pass source_name=exactSourceAssetName to the matching stable facade. If expert access is required, call expert.open_document(name). Never create a replacement document.',
        'Call the stable facade save() exactly once inside create_document(job), followed by close(). The worker-owned facade selects the output filter.',
        'Never call create_document yourself, never append create_document(None), and never paste storeToURL/storeAsURL worker internals into a draft.',
    ]
    facade_signatures = []
    save_examples = {
        'word': 'layout.save()\nlayout.close()',
        'spreadsheet': 'workbook.save()\nworkbook.close()',
        'presentation': 'deck.save()\ndeck.close()',
    }
    if document_type == 'word':
        operations = {
            'flowLayout': '''layout = job.writer('document')
layout.set_page('page-style', width=21000, height=29700, margins=(2000, 2000, 1800, 1800))
layout.set_header_footer(header='Report header', footer='Report footer', header_element_id='header', footer_element_id='footer')
layout.add_heading('title', 'Writer report', level=1)
layout.add_paragraph('body-01', 'Body text uses native Writer pagination.', line_spacing=1.3)
layout.add_bullets('bullets', ['First item', 'Second item'])
layout.add_table('summary-table', [['Field', 'Value'], ['Status', 'Verified']], column_widths=[35, 65])''',
            'openExisting': '''layout = job.writer('source-document', source_name='exact-source-asset-name.docx')
# Modify through the stable facade and save; declare expert mode only for an unmodeled edit.''',
            'bounds': '''bounds = job.document_bounds(doc)
# Exact keys: kind, pageWidth, pageHeight, leftMargin, rightMargin,
# topMargin, bottomMargin, contentWidth, contentHeight. Values are 1/100 mm.
content_width = bounds['contentWidth']
content_height = bounds['contentHeight']''',
            'appendParagraph': '''PARAGRAPH_BREAK = uno.getConstantByName('com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK')
text = doc.Text
cursor = text.createTextCursor()
cursor.gotoEnd(False)
cursor.CharHeight = 12
cursor.CharWeight = 150.0
spacing = uno.createUnoStruct('com.sun.star.style.LineSpacing')
spacing.Mode, spacing.Height = 0, 130
cursor.ParaLineSpacing = spacing
text.insertString(cursor, 'Paragraph text', False)
text.insertControlCharacter(cursor, PARAGRAPH_BREAK, False)''',
            'pageBreak': '''# ControlCharacter.PAGE_BREAK does not exist; integer 2 is HARD_HYPHEN.
PARAGRAPH_BREAK = uno.getConstantByName('com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK')
PAGE_BEFORE = uno.Enum('com.sun.star.style.BreakType', 'PAGE_BEFORE')
cursor = doc.Text.createTextCursor()
cursor.gotoEnd(False)
cursor.BreakType = PAGE_BEFORE
doc.Text.insertControlCharacter(cursor, PARAGRAPH_BREAK, False)''',
            'image': '''import uno
asset = job.asset_path('exact-name-returned-by-plan.jpg')
image = doc.createInstance('com.sun.star.text.TextGraphicObject')
image.GraphicURL = uno.systemPathToFileUrl(str(asset))
image.AnchorType = uno.Enum('com.sun.star.text.TextContentAnchorType', 'AS_CHARACTER')
bounds = job.document_bounds(doc)
image.Width = min(12000, bounds['contentWidth'])
image.Height = 8000
cursor = doc.Text.createTextCursor()
cursor.gotoEnd(False)
doc.Text.insertTextContent(cursor, image, False)''',
            'table': '''table = doc.createInstance('com.sun.star.text.TextTable')
table.initialize(3, 2)
cursor = doc.Text.createTextCursor()
cursor.gotoEnd(False)
doc.Text.insertTextContent(cursor, table, False)
table.RelativeWidth = 100
separators = list(table.TableColumnSeparators)
separators[0].Position = int(table.TableColumnRelativeSum * 0.35)
table.TableColumnSeparators = tuple(separators)
table.getCellByName('A1').String = 'Label'
table.getCellByName('B1').String = 'Value' ''',
            'pageStyleAndHeader': '''page_styles = doc.StyleFamilies.getByName('PageStyles')
page_style = page_styles.getByName(page_styles.getElementNames()[0])
page_style.Width, page_style.Height = 21000, 29700
page_style.LeftMargin = page_style.RightMargin = 2000
page_style.TopMargin = page_style.BottomMargin = 1800
page_style.HeaderIsOn, page_style.FooterIsOn = True, True
header = page_style.HeaderText
header.String = 'Report header'
footer = page_style.FooterText
footer.String = 'Report footer' ''',
            'save': save_examples['word'],
        }
        complete = '''
def create_document(job):
    layout = job.writer('document')
    layout.set_page('page-style', width=21000, height=29700, margins=(2000, 2000, 1800, 1800))
    layout.set_header_footer(header='UNO Writer report', footer='Generated with verified UNO patterns', header_element_id='header', footer_element_id='footer')
    layout.add_heading('title', 'UNO Writer report', level=1)
    layout.add_paragraph('body-01', 'Body text uses native Writer pagination.')
    layout.add_page_break('page-break-02')
    layout.add_heading('section-02/title', 'Structured content', level=2)
    layout.add_table('section-02/table', [['Field', 'Value'], ['Status', 'Verified pattern']], column_widths=[35, 65])
    layout.save()
    layout.close()'''
        coverage = ['flow-first Writer facade with explicit expert escape hatch', 'stable elementId mapping', 'create/save DOC/DOCX/ODT/PDF', 'paragraph and line spacing', 'page breaks', 'images and anchors', 'relative table widths', 'page style and header']
    elif document_type == 'spreadsheet':
        operations = {
            'openExisting': '''workbook = job.spreadsheet('source-workbook', source_name='exact-source-asset-name.xlsx')
# Modify through the stable facade and save; declare expert mode only for an unmodeled edit.''',
            'bounds': '''bounds = job.document_bounds(doc)
# Calc returns {'kind': 'spreadsheet', 'unit': '1/100 mm'}.
# Cell layout uses rows/columns; drawing-layer objects use Point/Size in 1/100 mm.''',
            'cellsAndFormula': '''sheet = doc.Sheets.getByIndex(0)
sheet.getCellByPosition(0, 0).String = 'Revenue'
sheet.getCellByPosition(1, 0).Value = 1200.5
sheet.getCellByPosition(2, 0).Formula = '=B1*1.2'
sheet.getCellRangeByName('A1:C1').CharWeight = 150.0
sheet.Columns.getByIndex(0).Width = 4200
sheet.Rows.getByIndex(0).Height = 900''',
            'mergeAndFreeze': '''title = sheet.getCellRangeByName('A1:D1')
title.merge(True)
title.String = 'Quarterly report'
doc.CurrentController.freezeAtPosition(1, 1)''',
            'image': '''import uno
asset = job.asset_path('exact-name-returned-by-plan.jpg')
image = doc.createInstance('com.sun.star.drawing.GraphicObjectShape')
image.GraphicURL = uno.systemPathToFileUrl(str(asset))
position = uno.createUnoStruct('com.sun.star.awt.Point'); position.X, position.Y = 1000, 1000
size = uno.createUnoStruct('com.sun.star.awt.Size'); size.Width, size.Height = 12000, 8000
image.Position, image.Size = position, size
sheet.getDrawPage().add(image)''',
            'secondSheet': '''doc.Sheets.insertNewByName('Details', doc.Sheets.Count)
details = doc.Sheets.getByName('Details')
details.getCellByPosition(0, 0).String = 'Detail' ''',
            'save': save_examples['spreadsheet'],
        }
        complete = '''def create_document(job):
    workbook = job.spreadsheet('workbook')
    sheet = workbook.add_worksheet('summary-sheet', 'Summary')
    workbook.set_range('summary-data', sheet, 0, 0, [
        ['Item', 'Amount', 'Forecast'],
        ['Revenue', 1200.5, '=B2*1.2'],
    ])
    workbook.save()
    workbook.close()'''
        coverage = ['create/save XLS/XLSX/ODS/PDF', 'strings, numbers, and formulas', 'cell formatting', 'row/column sizing', 'merged cells and freeze panes', 'images on draw page', 'multiple sheets']
    else:
        common_rules.append(
            'deck.add_text measures wrapping with LibreOffice, keeps the requested Position/Size fixed, and shrinks only as far as min_font_size. Resize the box or shorten copy when it cannot fit readably.'
        )
        common_rules.append(
            'Slide objects follow insertion order. Add full-slide backgrounds and decorative layers before text, images, and foreground content so later shapes do not cover earlier content.'
        )
        common_rules.append(
            'Use deck.mm/cm/inch/pt for explicit units and deck.content_box(), deck.grid(), deck.stack(), deck.add_text_box(), deck.add_card(), deck.add_footer(), deck.add_native_table(), deck.add_chart(), and deck.add_timeline() for ordinary composition. Every standard data chart must be a native editable Impress chart object with an embedded data table. Avoid hand-calculating unrelated coordinates.'
        )
        common_rules.append(
            'For images that must not distort, use deck.add_image_contain() with a semantic box. Reserve deck.add_image() stretching for deliberate full-bleed backgrounds or already-cropped assets.'
        )
        common_rules.append(
            'Images use conversation workspace asset paths resolved by job.asset_path(); LibreOffice embeds them into the saved Office package. They are not limited to Base64 source literals.'
        )
        common_rules.append(
            'Use deck.add_text_link() for external URLs and click-to-jump slide links. target_slide_id is the stable element ID passed to deck.add_slide(), and forward references are allowed.'
        )
        common_rules.append(
            'deck.add_native_table() creates an editable native Impress TableShape. PowerPoint tables have editable cell text and styling but do not provide spreadsheet-style cell formulas.'
        )
        common_rules.append(
            'deck.add_chart() supports every UNO chart family: area, bar/column, bubble, donut, filled radar, line, radar, pie, stock, and XY/scatter. The named add_*_chart helpers use the same native API. Never redraw axes, marks, lines, bars, sectors, bubbles, or legends with add_shape(), add_connector(), or add_text().'
        )
        common_rules.append(
            'The high-level table, chart, and timeline components are the proven path used by the installed regression deck. Pass data and a grid cell; do not recreate their raw UNO services or internal coordinates in model-authored helpers.'
        )
        common_rules.append(
            'Text and images are collision-checked as content. add_shape defaults to decoration; pass layout_role="content", allow_overlap=False for semantic data shapes that must participate in collision checks. Set allow_overlap=True only for a deliberate overlay.'
        )
        common_rules.append(
            'Raw expert shape tags use the same rule: expert.tag(shape, element_id, "shape") is decorative by default. For a semantic bar, node, table cell, or chart mark, pass layout_role="content", allow_overlap=False. Text and image tags remain collision-checked content by default.'
        )
        common_rules.append(
            'Exact requested shape capabilities are validated by generated featureCounts. Use shape_type="caption" for CaptionShape, shape_type="measure" for MeasureShape, and add_connector/add_connector_between for the stable ConnectorShape facade capability; a visual substitute does not count.'
        )
        common_rules.append(
            'The caption/measure facade call creates the native UNO service and automatically pairs it with one stable editable export fallback because LibreOffice omits raw CaptionShape and MeasureShape from PPTX. Do not add another manual fallback.'
        )
        facade_signatures = [
            "deck.bounds() -> {'kind': 'presentation', 'width': int, 'height': int}",
            "deck.mm(value), deck.cm(value), deck.inch(value), deck.pt(value) -> int geometry units",
            "deck.text_height(font_size, lines=1, padding=0, line_spacing=1.15) -> safe height in 1/100 mm",
            "deck.estimate_text_box(text, width, font_size=18, padding=0, min_font_size=None, line_spacing=1.15) -> text metrics",
            "deck.content_box(margins={'left': 1600, 'right': 1600, 'top': 1400, 'bottom': 1200}) -> {'x': int, 'y': int, 'width': int, 'height': int}; legacy tuple order is (left, right, top, bottom)",
            "deck.grid(columns, rows, box=None, gap=500, column_weights=None, row_weights=None) -> list[rect]",
            "deck.stack(count, box=None, direction='vertical', gap=400, weights=None) -> list[rect]",
            "deck.add_slide(element_id)",
            "deck.add_text(element_id, page, text, x, y, width, height, font_size=18, color=0x000000, bold=False, italic=False, align='LEFT', font_name=None, fit='shrink', min_font_size=8, padding=0, valign='TOP', layout_role='content', allow_overlap=False)",
            "deck.add_text_box(element_id, page, text, box, font_size=18, color=0x000000, bold=False, italic=False, align='LEFT', font_name=None, min_font_size=None, padding=None, valign='TOP', layout_role='content', allow_overlap=False)",
            "deck.add_card(element_id, page, box, title, body='', fill=0xFFFFFF, line=None, accent=None, title_size=20, body_size=14, title_color=0x0F172A, body_color=0x334155, padding=None, gap=None)",
            "deck.add_footer(element_id, page, left='', center='', right='', height=None, background=None, accent=None, font_size=10, color=0x64748B, padding=None, left_url=None, center_url=None, right_url=None)",
            "deck.add_shape(element_id, page, x, y, width, height, shape_type='rectangle|round-rectangle|ellipse|line|diamond|triangle|right-triangle|parallelogram|trapezoid|pentagon|hexagon|octagon|star|caption|measure', fill=None, line=None, line_width=0, fill_transparency=0, layout_role='decoration', allow_overlap=True)",
            "deck.add_connector(element_id, page, x1, y1, x2, y2, color=0x64748B, line_width=100, start_arrow=False, end_arrow=False, start_arrow_width=None, end_arrow_width=None, layout_role='decoration', allow_overlap=True)",
            "deck.add_connector_between(element_id, page, source_box, target_box, color=0x64748B, line_width=100, start_arrow=False, end_arrow=True, axis='auto', source_inset=0, target_inset=0, start_arrow_width=None, end_arrow_width=None, layout_role='decoration', allow_overlap=True)",
            "deck.add_image(element_id, page, asset_name, x, y, width, height, layout_role='content', allow_overlap=False)",
            "deck.add_image_contain(element_id, page, asset_name, box, padding=0, layout_role='content', allow_overlap=False)",
            "deck.add_text_link(element_id, page, text, box, url=None, target_slide_id=None, font_size=18, color=0x2563EB, bold=False, italic=False, align='LEFT', font_name=None, min_font_size=None, padding=0, valign='CENTER', layout_role='content', allow_overlap=False)",
            "deck.add_native_table(element_id, page, box, rows, column_weights=None, header_fill=0x0F172A, header_color=0xFFFFFF, body_fill=0xF8FAFC, alternate_fill=0xFFFFFF, body_color=0x1E293B, font_size=11, font_name=None, first_column_align='LEFT')",
            "deck.add_chart(element_id, page, box, chart_type, categories, values=None, series=None, colors=None, font_size=12, show_legend=None, stacked=False, percent=False, vertical=None, lines=True, symbols=None, dim3d=False, color_by_point=None, series_name='Values', title=None, x_axis_title=None, y_axis_title=None, show_values=None, show_category_name=None, show_percent=None, background=None, legend_position='right', alt_text=None, x_axis_min=None, x_axis_max=None, y_axis_min=None, y_axis_max=None, x_axis_scale='linear', y_axis_scale='linear', axis_position='outside', series_transparency=None, line_width=1.5, font_name=None, font_color=0x334155, grid_color=0xD9DEE2, gridlines=True); transparent background and no internal title are default; chart_type: area, bar, column, bubble, donut/doughnut, filled-radar, line, radar, pie, stock, xy/scatter",
            "deck.add_bar_chart(element_id, page, box, categories, values, colors=None, font_size=12, color=0x334155, baseline_color=0xCBD5E1, value_format='{value:g}', series_name='Values', title=None, x_axis_title=None, y_axis_title=None, show_values=True, show_legend=False)",
            "deck.add_line_chart(element_id, page, box, categories, values, color=0x2563EB, point_fill=0xFFFFFF, label_color=0x334155, font_size=12, value_format='{value:g}', series_name='Values', title=None, x_axis_title=None, y_axis_title=None, show_values=True, show_legend=False)",
            "deck.add_area_chart(element_id, page, box, categories, values=None, series=None, colors=None, font_size=10, show_legend=None, stacked=False, percent=False)",
            "deck.add_pie_chart(element_id, page, box, labels, values, colors=None, font_size=10)",
            "deck.add_scatter_chart(element_id, page, box, x_values, y_values=None, series=None, colors=None, font_size=10, show_legend=None, lines=False, symbols=True)",
            "deck.add_bubble_chart(element_id, page, box, categories, series, colors=None, font_size=10, show_legend=True)",
            "deck.add_radar_chart(element_id, page, box, categories, values=None, series=None, colors=None, font_size=10, show_legend=None, filled=False, stacked=False, percent=False)",
            "deck.add_stock_chart(element_id, page, box, categories, series, colors=None, font_size=10, show_legend=True)",
            "deck.add_donut_chart(element_id, page, box, labels, values, colors=None, hole_fill=0xFFFFFF, label_color=0x334155, font_size=10, center_text='', center_subtitle='', center_text_color=0x0F172A, center_text_size=20, center_subtitle_size=9)",
            "deck.add_timeline(element_id, page, box, events, colors=None, title_size=14, body_size=10, text_color=0x334155, max_items_per_row=6)",
        ]
        operations = {
            'openExisting': '''deck = job.presentation('source-deck', source_name='exact-source-asset-name.pptx')
# Modify through the stable facade and preserve all unrelated slides and objects.''',
            'bounds': '''bounds = job.document_bounds(doc)
# Exact keys: kind, width, height. Values are 1/100 mm.
slide_width, slide_height = bounds['width'], bounds['height']''',
            'autoLayout': '''safe = deck.content_box(margins={'left': deck.mm(16), 'right': deck.mm(16), 'top': deck.mm(32), 'bottom': deck.mm(14)})
cards = deck.grid(3, 1, box=safe, gap=deck.mm(7), column_weights=[1, 1, 1])
for index, card in enumerate(cards):
    deck.add_card(
        f'slide-01/card-{index + 1}', page, card, f'Card {index + 1}',
        'Body copy with measured wrapping.', fill=0xE8EEF7, accent=0x2563EB,
        title_size=22, body_size=16,
    )
deck.add_footer('slide-01/footer', page, left='UNO', center='Measured layout', right='01')''',
            'connector': '''flow_box = deck.content_box(margins={'left': deck.mm(28), 'right': deck.mm(28), 'top': deck.mm(54), 'bottom': deck.mm(42)})
source_box, target_box = deck.grid(2, 1, box=flow_box, gap=deck.mm(22))
deck.add_connector_between(
    'slide-01/flow-arrow', page, source_box, target_box,
    color=0x2563EB, line_width=deck.mm(0.8), end_arrow=True,
)''',
            'specializedShapes': '''deck.add_shape('slide-01/caption', page, deck.mm(20), deck.mm(40), deck.mm(48), deck.mm(18),
    shape_type='caption', fill=0xFCE7F3, line=0xDB2777)
deck.add_shape('slide-01/measure', page, deck.mm(78), deck.mm(45), deck.mm(48), deck.mm(8),
    shape_type='measure', line=0x7C3AED, line_width=deck.mm(0.6))
deck.add_shape('slide-01/line', page, deck.mm(136), deck.mm(45), deck.mm(48), deck.mm(3),
    shape_type='line', line=0x475569, line_width=deck.mm(0.6))
# Use deck.add_connector_between(...) for the stable ConnectorShape capability.
# Validation exposes exact non-zero featureCounts for every used capability.''',
            'nativeTable': '''table_box = deck.content_box(margins={'left': deck.mm(16), 'right': deck.mm(16), 'top': deck.mm(34), 'bottom': deck.mm(18)})
deck.add_native_table(
    'slide-01/data-table', page, table_box,
    [['Metric', 'Value', 'Status'], ['Aperture', '6.5 m', 'Operational'], ['Orbit', 'L2', 'Stable']],
    column_weights=[1.4, 1, 1], font_size=11,
)''',
            'dataCharts': '''chart_cells = deck.grid(2, 1, box=deck.content_box(margins={'left': deck.mm(16), 'right': deck.mm(16), 'top': deck.mm(34), 'bottom': deck.mm(18)}), gap=deck.mm(8))
deck.add_bar_chart('slide-01/bar', page, chart_cells[0], ['A', 'B', 'C'], [42, 67, 91])
deck.add_line_chart('slide-01/line', page, chart_cells[1], ['Q1', 'Q2', 'Q3', 'Q4'], [12, 29, 24, 44])''',
            'donutAndTimeline': '''content = deck.content_box(margins={'left': deck.mm(16), 'right': deck.mm(16), 'top': deck.mm(34), 'bottom': deck.mm(18)})
left, right = deck.grid(2, 1, box=content, gap=deck.mm(8), column_weights=[1, 1.35])
deck.add_donut_chart('slide-01/donut', page, left, ['Science', 'Engineering', 'Operations'], [48, 32, 20], center_text='100%', center_subtitle='Allocation')
deck.add_timeline('slide-01/timeline', page, right, [
    {'title': 'T0', 'body': 'Launch'}, {'title': 'T+1m', 'body': 'Cruise'},
    {'title': 'T+6m', 'body': 'First light'}, {'title': 'Now', 'body': 'Science'},
])''',
            'imageContain': '''image_box = deck.grid(2, 1, box=deck.content_box(), gap=deck.mm(8))[0]
deck.add_image_contain('slide-01/hero', page, 'exact-name-returned-by-plan.jpg', image_box, padding=deck.mm(2))''',
            'hyperlinks': '''# target_slide_id may point forward to a slide created later with the same stable ID.
deck.add_text_link('slide-01/toc-science', page, 'Jump to science results',
    {'x': deck.mm(18), 'y': deck.mm(52), 'width': deck.mm(90), 'height': deck.mm(10)},
    target_slide_id='slide-06-science', font_size=16, bold=True)
deck.add_text_link('slide-01/official-site', page, 'Official mission website',
    {'x': deck.mm(18), 'y': deck.mm(66), 'width': deck.mm(90), 'height': deck.mm(10)},
    url='https://science.nasa.gov/mission/webb/', font_size=13)''',
            'textShape': '''shape = doc.createInstance('com.sun.star.drawing.TextShape')
position = uno.createUnoStruct('com.sun.star.awt.Point'); position.X, position.Y = 1600, 1200
size = uno.createUnoStruct('com.sun.star.awt.Size'); size.Width, size.Height = 22000, 3000
shape.Position, shape.Size = position, size
page.add(shape)
shape.String = 'Slide title'
# CharHeight is pt. Keep short text at a fixed size; resize the box/copy instead of hiding defects with scroll controls.
shape.TextFitToSize = uno.Enum('com.sun.star.drawing.TextFitToSizeType', 'NONE')
shape.CharHeight, shape.CharWeight = 28, 150.0
''',
            'image': '''import uno
asset = job.asset_path('exact-name-returned-by-plan.jpg')
image = doc.createInstance('com.sun.star.drawing.GraphicObjectShape')
image.GraphicURL = uno.systemPathToFileUrl(str(asset))
position = uno.createUnoStruct('com.sun.star.awt.Point'); position.X, position.Y = 1200, 4200
size = uno.createUnoStruct('com.sun.star.awt.Size'); size.Width, size.Height = 18000, 9000
image.Position, image.Size = position, size
page.add(image)''',
            'shape': '''card = doc.createInstance('com.sun.star.drawing.RectangleShape')
position = uno.createUnoStruct('com.sun.star.awt.Point'); position.X, position.Y = 1600, 5200
size = uno.createUnoStruct('com.sun.star.awt.Size'); size.Width, size.Height = 9000, 5000
card.Position, card.Size = position, size
card.FillStyle = uno.Enum('com.sun.star.drawing.FillStyle', 'SOLID')
card.FillColor = 0x2563EB
card.LineStyle = uno.Enum('com.sun.star.drawing.LineStyle', 'NONE')
page.add(card)
expert.tag(card, 'slide-01/card', 'shape', layout_role='container', allow_overlap=True)
# For a semantic chart mark instead, use layout_role='content', allow_overlap=False.''',
            'newSlide': '''page = doc.DrawPages.insertNewByIndex(doc.DrawPages.Count)
# Add shapes only after assigning explicit Position and Size inside bounds.''',
            'save': save_examples['presentation'],
        }
        complete = '''def create_document(job):
    deck = job.presentation('deck')
    bounds = deck.bounds()
    NAVY, BLUE, TEAL, GOLD = 0x0F172A, 0x2563EB, 0x10B981, 0xF59E0B
    PAPER, WHITE, INK, MUTED = 0xF8FAFC, 0xFFFFFF, 0x1E293B, 0x64748B

    def page_base(sid, title, index):
        page = deck.add_slide(sid)
        deck.add_shape(f'{sid}/background', page, 0, 0, bounds['width'], bounds['height'], fill=PAPER, layout_role='background', allow_overlap=True)
        deck.add_shape(f'{sid}/top-rule', page, 0, 0, bounds['width'], deck.mm(2), fill=BLUE, layout_role='decoration', allow_overlap=True)
        deck.add_text(f'{sid}/title', page, title, deck.mm(16), deck.mm(9), bounds['width'] - deck.mm(32), deck.mm(13), font_size=26, min_font_size=24, color=INK, bold=True)
        deck.add_footer(f'{sid}/footer', page, left='UNO / LibreOffice', center='High-level facade', right=f'{index:02d}', accent=BLUE)
        return page

    page = deck.add_slide('slide-01')
    deck.add_shape('slide-01/background', page, 0, 0, bounds['width'], bounds['height'], fill=NAVY, layout_role='background', allow_overlap=True)
    deck.add_shape('slide-01/accent', page, deck.mm(18), deck.mm(35), deck.mm(2), deck.mm(72), fill=GOLD, layout_role='decoration', allow_overlap=True)
    deck.add_text('slide-01/title', page, 'UNO presentation system', deck.mm(24), deck.mm(43), bounds['width'] - deck.mm(48), deck.mm(24), font_size=38, min_font_size=34, color=WHITE, bold=True)
    deck.add_text('slide-01/subtitle', page, 'A proven, data-driven layout built from stable facade components', deck.mm(24), deck.mm(73), bounds['width'] - deck.mm(48), deck.mm(14), font_size=19, min_font_size=18, color=0xCBD5E1)
    deck.add_footer('slide-01/footer', page, left='UNO / LibreOffice', center='Regression blueprint', right='01', color=0xCBD5E1, accent=GOLD)

    page = page_base('slide-02', 'Measured cards and deterministic grids', 2)
    card_box = deck.content_box(margins={'left': deck.mm(16), 'right': deck.mm(16), 'top': deck.mm(34), 'bottom': deck.mm(18)})
    cards = deck.grid(3, 1, box=card_box, gap=deck.mm(7))
    for index, (title, body, accent) in enumerate([
        ('Structure', 'Grid cells own every content region.' , BLUE),
        ('Typography', 'Text is measured before publication.', TEAL),
        ('Quality', 'Overlap and bounds are validated.', GOLD),
    ]):
        deck.add_card(f'slide-02/card-{index + 1}', page, cards[index], title, body, fill=WHITE, line=0xCBD5E1, accent=accent, title_size=22, body_size=15)

    page = page_base('slide-03', 'Native editable table', 3)
    table_box = deck.content_box(margins={'left': deck.mm(16), 'right': deck.mm(16), 'top': deck.mm(34), 'bottom': deck.mm(18)})
    deck.add_native_table('slide-03/table', page, table_box, [
        ['Capability', 'Implementation', 'Verification'],
        ['Text', 'Measured TextShape', 'Overflow gate'],
        ['Tables', 'Native TableShape', 'Reopen check'],
        ['Charts', 'Stable vector marks', 'Overlap gate'],
        ['Images', 'Aspect-ratio contain', 'Bounds gate'],
    ], column_weights=[1.1, 1.6, 1.2], font_size=11)

    page = page_base('slide-04', 'Native editable data charts', 4)
    chart_box = deck.content_box(margins={'left': deck.mm(16), 'right': deck.mm(16), 'top': deck.mm(34), 'bottom': deck.mm(18)})
    bar_box, line_box = deck.grid(2, 1, box=chart_box, gap=deck.mm(9))
    deck.add_bar_chart('slide-04/bar', page, bar_box, ['A', 'B', 'C', 'D'], [42, 67, 54, 91], colors=[BLUE, TEAL, GOLD, 0x8B5CF6])
    deck.add_line_chart('slide-04/line', page, line_box, ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'], [12, 29, 24, 44, 51], color=TEAL)

    page = page_base('slide-05', 'Composition: donut and timeline', 5)
    visual_box = deck.content_box(margins={'left': deck.mm(16), 'right': deck.mm(16), 'top': deck.mm(34), 'bottom': deck.mm(18)})
    donut_box, timeline_box = deck.grid(2, 1, box=visual_box, gap=deck.mm(9), column_weights=[1, 1.4])
    deck.add_donut_chart('slide-05/donut', page, donut_box, ['Science', 'Engineering', 'Operations'], [48, 32, 20], colors=[BLUE, TEAL, GOLD], center_text='100%', center_subtitle='Allocation')
    deck.add_timeline('slide-05/timeline', page, timeline_box, [
        {'title': 'T0', 'body': 'Launch'},
        {'title': 'T+1m', 'body': 'Cruise'},
        {'title': 'T+6m', 'body': 'First light'},
        {'title': 'Now', 'body': 'Science'},
    ], colors=[BLUE, TEAL, GOLD, 0x8B5CF6])

    deck.save()
    deck.close()'''
        coverage = ['create/save PPT/PPTX/ODP/PDF', 'native slide bounds', 'explicit unit conversion', 'safe content boxes', 'grid and stack auto-layout', 'measured text boxes', 'high-level cards and footers', 'native editable TableShape', 'all native UNO chart families', 'alternating timelines', 'aspect-ratio-safe images', 'stable connectors and arrows', 'content collision diagnostics', 'graphic shapes', 'filled shapes', 'new slides', 'explicit in-slide geometry']
    facade_name = {'word': 'writer', 'spreadsheet': 'spreadsheet', 'presentation': 'presentation'}[document_type]
    modification = f'''def create_document(job):
    # Replace this placeholder with sourceDocument.assetName returned by action=plan.
    expert = job.expert('The requested edit requires direct access to existing Office objects.')
    doc = expert.open_document('exact-source-asset-name')
    expert.tag(doc, 'source-document', 'existing-document', {{'role': 'document'}})
    layout = job.{facade_name}('source-document-layout', component=doc)
    # Locate and edit only the requested existing content here.
    layout.save()
    layout.close()'''
    operations['expertFromFacade'] = '''expert = job.expert('The requested feature is not exposed by the stable facade.')
doc = expert.component(layout)
# Use doc only for that unmodeled feature and expert.tag(...) every raw object.'''
    return {
        'status': 'copy these installed-runtime patterns; do not paraphrase them into guessed UNO calls',
        'coverage': coverage,
        'rules': common_rules,
        'facadeSignatures': facade_signatures,
        'completeDocument': complete,
        'completeExistingDocumentModification': modification,
        'operations': operations,
    }


def inspect_target_api(subject, query, offset, limit, complete=False):
    try:
        services = list(subject.getSupportedServiceNames())
    except Exception:
        services = []
    properties = uno_property_summary(subject)
    methods = uno_method_summary(subject)
    if query:
        properties = [item for item in properties if query in item['name'].lower() or query in item['type'].lower()]
        methods = [name for name in methods if query in name.lower()]
    if complete:
        offset, limit = 0, max(len(properties), len(methods), 1)
    return {
        'services': services,
        'properties': properties[offset:offset + limit],
        'methods': methods[offset:offset + limit],
        'pagination': {
            'query': query or None,
            'offset': offset,
            'limit': limit,
            'propertyCount': len(properties),
            'methodCount': len(methods),
            'hasMoreProperties': offset + limit < len(properties),
            'hasMoreMethods': offset + limit < len(methods),
            'complete': complete,
        },
    }


def inspect_uno_api(soffice, profile, document_type, target, query='', offset=0, limit=120):
    normalized_query = str(query or '').strip().lower()
    if target == 'facade':
        cookbook = office_facade_cookbook(document_type, normalized_query)
        return {
            'renderer': 'libreoffice-uno-facade',
            'documentType': document_type,
            'target': 'facade',
            'nativeReflectionExposed': False,
            **cookbook,
            'note': (
                'The model-facing contract is a versioned Office facade. UNO services, properties, '
                'enums, structs, controllers, geometry conversion, and output filters are worker-owned.'
            ),
        }
    process = context = desktop = document = None
    try:
        process, context, desktop = connect_office(soffice, profile)
        document = desktop.loadComponentFromURL(factory_url(document_type), '_blank', 0, (property_value('Hidden', True),))
        offset, limit = max(0, int(offset)), min(2000, max(1, int(limit)))
        response = {
            'renderer': 'libreoffice-uno-api',
            'documentType': document_type,
            'target': target,
            'example': uno_examples(document_type),
            'imageExample': uno_image_example(document_type),
            'cookbook': uno_cookbook(document_type),
            'jobContract': {
                'assetPath': 'job.asset_path(name) accepts only an existing file in the current conversation workspace.',
                'listAssets': 'job.list_assets() returns every mounted conversation asset and byte size.',
                'documentBounds': {
                    'unit': '1/100 mm',
                    'word': ['kind', 'pageWidth', 'pageHeight', 'leftMargin', 'rightMargin', 'topMargin', 'bottomMargin', 'contentWidth', 'contentHeight'],
                    'spreadsheet': ['kind', 'unit'],
                    'presentation': ['kind', 'width', 'height'],
                    'rule': 'Use the stable facade by default. In expert mode, call job.document_bounds(doc) only after expert.new_document(...) or expert.open_document(...).',
                },
                'imageRule': 'Use GraphicObjectShape/GraphicURL for Impress and Calc. Use TextGraphicObject/GraphicURL for Writer. File URLs must come from uno.systemPathToFileUrl(str(job.asset_path(name))).',
            },
            'note': 'Reflection data and the cookbook come from this installed LibreOffice runtime. Copy the matching cookbook operation; use only reported members and never invent enum members, constants, numeric substitutes, or object methods.',
        }
        if target == 'all':
            response['targets'] = {
                item: inspect_target_api(inspect_target(document, document_type, item), normalized_query, 0, limit, complete=True)
                for item in targets_for_document_type(document_type)
            }
            response['complete'] = True
            return response
        response.update(inspect_target_api(inspect_target(document, document_type, target), normalized_query, offset, limit))
        return response
    finally:
        close_component(document)
        shutdown_office(process, desktop)


def document_fidelity_snapshot(component, document_type):
    if document_type == 'presentation':
        pages, shapes, images, text_characters = component.DrawPages.Count, 0, 0, 0
        for page_index in range(pages):
            page = component.DrawPages.getByIndex(page_index)
            shapes += page.getCount()
            for shape_index in range(page.getCount()):
                shape = page.getByIndex(shape_index)
                try:
                    if shape.supportsService('com.sun.star.drawing.GraphicObjectShape'):
                        images += 1
                except Exception:
                    pass
                try:
                    text_characters += len(str(shape.String or ''))
                except Exception:
                    pass
        return {'pages': pages, 'shapes': shapes, 'images': images, 'textCharacters': text_characters}
    if document_type == 'spreadsheet':
        return {'sheets': component.Sheets.Count}
    return {'textCharacters': len(str(component.Text.String or ''))}


def verify_modification_fidelity(source, output, document_type):
    before = document_fidelity_snapshot(source, document_type)
    after = document_fidelity_snapshot(output, document_type)
    if document_type == 'presentation':
        if after['pages'] != before['pages']:
            raise RuntimeError(f'Existing-file fidelity check failed: page count changed from {before["pages"]} to {after["pages"]}.')
        if after['images'] < before['images']:
            raise RuntimeError(f'Existing-file fidelity check failed: embedded image count dropped from {before["images"]} to {after["images"]}.')
        if before['shapes'] >= 4 and after['shapes'] < int(before['shapes'] * 0.65):
            raise RuntimeError(f'Existing-file fidelity check failed: shape count dropped from {before["shapes"]} to {after["shapes"]}.')
        if before['textCharacters'] >= 100 and after['textCharacters'] < int(before['textCharacters'] * 0.65):
            raise RuntimeError(f'Existing-file fidelity check failed: text content dropped from {before["textCharacters"]} to {after["textCharacters"]} characters.')
    elif document_type == 'spreadsheet' and after['sheets'] < before['sheets']:
        raise RuntimeError(f'Existing-file fidelity check failed: sheet count dropped from {before["sheets"]} to {after["sheets"]}.')
    elif document_type == 'word' and before['textCharacters'] >= 100 and after['textCharacters'] < int(before['textCharacters'] * 0.65):
        raise RuntimeError(f'Existing-file fidelity check failed: text content dropped from {before["textCharacters"]} to {after["textCharacters"]} characters.')
    return {'source': before, 'output': after}


def verify_package_media_fidelity(source_path, output_path):
    prefixes = {'.pptx': 'ppt/media/', '.docx': 'word/media/', '.xlsx': 'xl/media/'}
    prefix = prefixes.get(source_path.suffix.lower())
    if not prefix or output_path.suffix.lower() != source_path.suffix.lower():
        return None
    with zipfile.ZipFile(source_path) as archive:
        source_media = sum(1 for name in archive.namelist() if name.startswith(prefix) and not name.endswith('/'))
    with zipfile.ZipFile(output_path) as archive:
        output_media = sum(1 for name in archive.namelist() if name.startswith(prefix) and not name.endswith('/'))
    if output_media < source_media:
        raise RuntimeError(f'Existing-file fidelity check failed: packaged media count dropped from {source_media} to {output_media}.')
    return {'sourceMedia': source_media, 'outputMedia': output_media}


def map_issue(issue, element_map, artifact_name=None, locator=None):
    match = None
    if artifact_name:
        match = next((item for item in element_map if item.get('artifactName') == artifact_name), None)
    if match is None and locator:
        match = next((item for item in element_map if all(item.get('locator', {}).get(key) == value for key, value in locator.items())), None)
    if match:
        issue.update({
            'elementId': match.get('elementId'), 'line': match.get('line'), 'column': match.get('column'),
            'callLine': match.get('callLine'), 'callColumn': match.get('callColumn'),
            'locator': match.get('locator'),
        })
    return issue


def verify_and_preview(soffice, profile, output, preview, document_type, source=None, element_map=None,
                       context=None, desktop=None, existing_pipe=None):
    element_map = element_map or []
    if output.suffix.lower() == '.pdf':
        if output.stat().st_size < 64:
            raise RuntimeError('Generated PDF is empty')
        shutil.copyfile(output, preview)
        return {'format': 'pdf', 'verification': 'file-size'}
    process = component = source_component = None
    owns_office = desktop is None
    try:
        if desktop is None:
            process, context, desktop = connect_office(soffice, profile, existing_pipe)
        # Verification must never contend with the writer for an editable
        # handle. Large Office files can retain a short-lived lock after the
        # generating process has finished its synchronous store. Reopening as
        # read-only is sufficient for structural checks and PDF export, and it
        # avoids reporting a valid locked document as corrupt.
        component = desktop.loadComponentFromURL(
            output.as_uri(),
            '_blank',
            0,
            (property_value('Hidden', True), property_value('ReadOnly', True)),
        )
        if component is None:
            raise RuntimeError('LibreOffice could not reopen the generated document')
        if not component.supportsService(expected_service(document_type)):
            raise RuntimeError(f'Generated file does not reopen as {document_type}')
        fidelity = None
        if source is not None:
            package_fidelity = verify_package_media_fidelity(source, output)
            source_component = desktop.loadComponentFromURL(
                source.as_uri(), '_blank', 0,
                (property_value('Hidden', True), property_value('ReadOnly', True)),
            )
            if source_component is None:
                raise RuntimeError('LibreOffice could not reopen the source document for fidelity verification')
            fidelity = verify_modification_fidelity(source_component, component, document_type)
            fidelity['package'] = package_fidelity
        image_verification = verify_embedded_images(component, document_type, element_map)
        text_verification = verify_presentation_text(component, element_map) if document_type == 'presentation' else None
        chart_verification = verify_presentation_charts(component, element_map) if document_type == 'presentation' else None
        layout_verification = verify_presentation_layout(component, element_map) if document_type == 'presentation' else None
        spreadsheet_verification = verify_spreadsheet_content(component, element_map) if document_type == 'spreadsheet' else None
        word_layout_verification = verify_word_layout(component, element_map) if document_type == 'word' else None
        word_verification = verify_word_content(component, image_verification, word_layout_verification) if document_type == 'word' else None
        component.storeToURL(preview.as_uri(), (property_value('FilterName', PDF_FILTERS[document_type]), property_value('Overwrite', True)))
        if not preview.is_file() or preview.stat().st_size < 64:
            raise RuntimeError('LibreOffice could not export a PDF preview')
        checks = [item for item in (image_verification, chart_verification, layout_verification, spreadsheet_verification, word_layout_verification) if item]
        issues = [issue for check in checks for issue in check.get('issues', [])]
        common = {'issues': issues, 'passed': not any(item.get('severity') == 'error' for item in issues)}
        if document_type == 'presentation':
            return {**common, 'format': 'presentation', 'pages': component.DrawPages.Count, 'images': image_verification, 'text': text_verification, 'charts': chart_verification, 'layout': layout_verification, 'fidelity': fidelity}
        if document_type == 'spreadsheet':
            return {**common, 'format': 'spreadsheet', 'sheets': list(component.Sheets.getElementNames()), 'content': spreadsheet_verification, 'fidelity': fidelity}
        return {**common, 'format': 'word', 'textCharacters': len(str(component.Text.String or '')), 'images': image_verification, 'content': word_verification, 'fidelity': fidelity}
    finally:
        close_component(source_component)
        close_component(component)
        if owns_office:
            shutdown_office(process, desktop)


def verify_presentation_text(component, element_map=None):
    """Reject the common detached-TextShape failure after a fresh reopen."""
    text_shapes, non_empty_text_shapes, text_characters = 0, 0, 0
    shape_types = {}
    element_lookup = {
        (entry.get('locator', {}).get('slide'), entry.get('locator', {}).get('shape')): entry
        for entry in (element_map or [])
    }
    element_by_artifact_name = {
        str(entry.get('artifactName')): entry
        for entry in (element_map or [])
        if entry.get('artifactName')
    }

    def visit_shapes(container, use_index=False):
        for shape_index in range(container.getCount()):
            shape = container.getByIndex(shape_index)
            yield shape, (shape_index + 1 if use_index else None)
            try:
                shape_type = str(shape.getShapeType())
            except Exception:
                shape_type = ''
            if shape_type.endswith('GroupShape') and hasattr(shape, 'getCount'):
                yield from visit_shapes(shape)

    for page_index in range(component.DrawPages.Count):
        page = component.DrawPages.getByIndex(page_index)
        for shape, fallback_shape_index in visit_shapes(page, use_index=True):
            try:
                shape_type = str(shape.getShapeType())
            except Exception:
                shape_type = ''
            shape_types[shape_type or '(unknown)'] = shape_types.get(shape_type or '(unknown)', 0) + 1
            try:
                value = str(shape.String or '')
            except Exception:
                value = ''
            shape_name = str(getattr(shape, 'Name', '') or '')
            mapped = element_by_artifact_name.get(shape_name) or (
                element_lookup.get((page_index + 1, fallback_shape_index), {})
                if fallback_shape_index is not None else {}
            )
            is_text_shape = (
                str(mapped.get('kind') or '').strip().lower() == 'text'
                or shape_type.endswith('TextShape')
                or shape_type.endswith('OutlinerShape')
                or bool(value)
            )
            if not is_text_shape:
                continue
            text_shapes += 1
            text_characters += len(value)
            if value.strip():
                non_empty_text_shapes += 1
    if text_shapes and not non_empty_text_shapes:
        raise RuntimeError(
            f'Presentation text verification failed: {text_shapes} TextShape objects reopened with no text. '
            'In this LibreOffice runtime a TextShape must be attached before its text is assigned: '
            'set Position/Size, call page.add(shape), then set shape.String or shape.Text.String and formatting. '
            'Edit the current draft helper in that order and render again.'
        )
    return {
        'textShapes': text_shapes,
        'nonEmptyTextShapes': non_empty_text_shapes,
        'textCharacters': text_characters,
        'shapeTypes': shape_types,
    }


def verify_presentation_charts(component, element_map=None):
    """Reject native chart OLE objects that collapse or detach after PPTX reopen."""
    issues, checked, seen_element_ids = [], 0, set()
    expected_charts = [
        entry for entry in (element_map or [])
        if str(entry.get('kind') or '').strip().lower() == 'chart'
    ]
    element_lookup = {
        (entry.get('locator', {}).get('slide'), entry.get('locator', {}).get('shape')): entry
        for entry in (element_map or [])
    }
    element_by_artifact_name = {
        str(entry.get('artifactName')): entry
        for entry in (element_map or [])
        if entry.get('artifactName')
    }
    for page_index in range(component.DrawPages.Count):
        page = component.DrawPages.getByIndex(page_index)
        for shape_index in range(page.getCount()):
            shape = page.getByIndex(shape_index)
            shape_name = str(getattr(shape, 'Name', '') or '')
            mapped = element_by_artifact_name.get(shape_name) or element_lookup.get(
                (page_index + 1, shape_index + 1), {}
            )
            if str(mapped.get('kind') or '').strip().lower() != 'chart':
                continue
            checked += 1
            if mapped.get('elementId'):
                seen_element_ids.add(str(mapped.get('elementId')))
            try:
                position, chart_size = shape.Position, shape.Size
                width, height = int(chart_size.Width), int(chart_size.Height)
            except Exception:
                width = height = 0
            problem = ''
            if width <= 0 or height <= 0:
                problem = f'native chart reopened with non-positive size {width}x{height}'
            else:
                try:
                    chart_model = shape.Model
                    if chart_model is None or getattr(chart_model, 'Diagram', None) is None:
                        problem = 'native chart reopened without its embedded chart model or diagram'
                except Exception:
                    problem = 'native chart reopened without a readable embedded chart model'
            if not problem and 'chartTitle' in mapped:
                try:
                    title_object = chart_model.getTitleObject()
                    actual_title = ''.join(item.getString() for item in title_object.getText()) if title_object else ''
                    if actual_title.strip() != mapped['chartTitle']:
                        issues.append(map_issue({
                            'severity': 'error', 'type': 'presentation_chart_title_mismatch',
                            'description': (
                                f'Native chart title changed during export: expected {mapped["chartTitle"]!r}, '
                                f'got {actual_title!r}. This is a renderer/exporter fidelity failure; '
                                'preserve the authored title and fix the runtime, not the source text.'
                            ),
                        }, element_map or [], shape_name, {'slide': page_index + 1, 'shape': shape_index + 1}))
                except Exception as error:
                    issues.append(map_issue({
                        'severity': 'error', 'type': 'presentation_chart_title_unverified',
                        'description': f'Could not verify native chart title after export: {error}. Preserve the source and inspect the renderer.',
                    }, element_map or [], shape_name, {'slide': page_index + 1, 'shape': shape_index + 1}))
            if problem:
                issues.append(map_issue({
                    'severity': 'error', 'type': 'presentation_chart_degenerated',
                    'description': (
                        f'{problem}. The OLE2 chart did not survive the LibreOffice PPTX round trip; '
                        'inspect the renderer and use a stable native chart configuration. '
                        'Do not replace required editable/native charts with images or vectors without user approval.'
                    ),
                }, element_map or [], shape_name, {'slide': page_index + 1, 'shape': shape_index + 1}))
    for expected in expected_charts:
        element_id = str(expected.get('elementId') or '')
        if element_id and element_id not in seen_element_ids:
            issues.append({
                'severity': 'error', 'type': 'presentation_chart_missing_after_reopen',
                'elementId': element_id,
                'line': expected.get('line'), 'column': expected.get('column'),
                'locator': expected.get('locator'),
                'description': (
                    'Native chart is missing after the LibreOffice PPTX round trip. '
                    'Inspect the exporter and preserve required native/editable chart coverage; '
                    'do not silently replace the missing chart with an image or vector component.'
                ),
            })
    return {
        'checked': checked,
        'expected': len(expected_charts),
        'issues': issues,
        'passed': not any(issue.get('severity') == 'error' for issue in issues),
    }


def verify_presentation_layout(component, element_map=None):
    """Reject objective slide defects and non-intentional content collisions.

    Backgrounds, containers and decoration are excluded from collision checks.
    Content overlap is allowed only when the authored element record explicitly
    opts in with ``allowOverlap``. Untyped raw shapes match ``deck.add_shape``
    and default to decoration; raw semantic shapes must opt in with
    ``layoutRole=content``. This keeps card/background underlays out of the
    collision graph without making text or image collisions invisible.
    """
    issues, page_occupancy, ten_inch_canvas_pages = [], [], []
    checked_text_shapes = checked_content_shapes = 0
    element_lookup = {
        (entry.get('locator', {}).get('slide'), entry.get('locator', {}).get('shape')): entry
        for entry in (element_map or [])
    }
    element_by_artifact_name = {
        str(entry.get('artifactName')): entry
        for entry in (element_map or [])
        if entry.get('artifactName')
    }

    def intersection(left, right):
        overlap_width = max(0, min(left['x'] + left['width'], right['x'] + right['width']) - max(left['x'], right['x']))
        overlap_height = max(0, min(left['y'] + left['height'], right['y'] + right['height']) - max(left['y'], right['y']))
        return {
            'x': max(left['x'], right['x']), 'y': max(left['y'], right['y']),
            'width': overlap_width, 'height': overlap_height,
            'area': overlap_width * overlap_height,
        }

    def collision_threshold(left, right):
        kinds = {left['kind'], right['kind']}
        if kinds == {'text'}:
            return 0.02, 'text_overlap'
        if kinds == {'image'}:
            return 0.05, 'image_overlap'
        return 0.08 if kinds == {'text', 'image'} else 0.10, 'content_overlap'

    for page_index in range(component.DrawPages.Count):
        page = component.DrawPages.getByIndex(page_index)
        page_width, page_height = int(page.Width), int(page.Height)
        if page.getCount() == 0:
            issues.append({'severity': 'error', 'type': 'empty_page', 'page': page_index + 1, 'description': 'Page has no shapes.'})
            continue
        content_boxes, visible_boxes = [], []
        for shape_index in range(page.getCount()):
            shape = page.getByIndex(shape_index)
            position, shape_size = shape.Position, shape.Size
            x, y = int(position.X), int(position.Y)
            width, height = int(shape_size.Width), int(shape_size.Height)
            # PPTX export may convert or omit a drawing service (for example a
            # CaptionShape or MeasureShape), shifting every later shape index.
            # Names are the stable serialized identity; use the authored index
            # only as a fallback for formats/services that do not retain Name.
            shape_name = str(getattr(shape, 'Name', '') or '')
            mapped = element_by_artifact_name.get(shape_name) or element_lookup.get(
                (page_index + 1, shape_index + 1),
                {},
            )
            try:
                value = str(shape.String or '').strip()
            except Exception:
                value = ''
            kind = str(mapped.get('kind') or ('text' if value else '')).strip().lower()
            if not kind:
                try:
                    if shape.supportsService('com.sun.star.drawing.GraphicObjectShape'):
                        kind = 'image'
                except Exception:
                    pass
            if value:
                checked_text_shapes += 1
            if value and (width <= 0 or height <= 0 or x < 0 or y < 0 or x + width > page_width or y + height > page_height):
                issues.append(map_issue({
                    'severity': 'error', 'type': 'text_out_of_bounds', 'page': page_index + 1,
                    'shape': shape_index + 1,
                    'description': f'Text box is outside slide bounds: x={x}, y={y}, width={width}, height={height}, slideWidth={page_width}, slideHeight={page_height}.',
                }, element_map or [], shape_name, {'slide': page_index + 1, 'shape': shape_index + 1}))
            layout = mapped.get('layout') if isinstance(mapped.get('layout'), dict) else {}
            locator = mapped.get('locator') if isinstance(mapped.get('locator'), dict) else {}
            explicit_role = layout.get('role') or locator.get('layoutRole')
            default_role = 'decoration' if kind == 'shape' else 'content'
            role = str(explicit_role or default_role).strip().lower()
            allow_overlap = bool(layout.get('allowOverlap', locator.get('allowOverlap', False)))
            if role != 'background' and width > 0 and height > 0:
                visible_boxes.append({
                    'shape': shape_index + 1,
                    'elementId': mapped.get('elementId'),
                    'kind': kind,
                    'role': role,
                    'x': x,
                    'y': y,
                    'width': width,
                    'height': height,
                })
            if role in {'background', 'container', 'decoration'} or allow_overlap:
                continue
            if kind not in {'text', 'image', 'shape', 'chart', 'table', 'diagram', 'expert-element'}:
                continue
            checked_content_shapes += 1
            box = {
                'shape': shape_index + 1, 'elementId': mapped.get('elementId'),
                'kind': kind, 'role': role, 'text': value[:80],
                'x': x, 'y': y, 'width': width, 'height': height,
            }
            content_boxes.append(box)
            if width <= 0 or height <= 0 or x < 0 or y < 0 or x + width > page_width or y + height > page_height:
                issues.append({
                    'severity': 'error', 'type': 'content_out_of_bounds', 'page': page_index + 1,
                    'shape': shape_index + 1, 'elementIds': [mapped.get('elementId')] if mapped.get('elementId') else [],
                    'description': f'{kind} content is outside slide bounds: x={x}, y={y}, width={width}, height={height}, slideWidth={page_width}, slideHeight={page_height}.',
                    'repairHint': 'Move or resize only the reported elementId so every edge remains inside deck.bounds().',
                })
        is_wide_screen = abs((page_width / max(1, page_height)) - (16.0 / 9.0)) <= 0.02
        ten_inch_right_edge = int(round(10.05 * 2540))
        centered_on_ten_inches = [
            item for item in content_boxes
            if item['width'] >= int(round(7.0 * 2540))
            and abs((item['x'] + item['width'] / 2.0) - (5.0 * 2540)) <= int(round(0.15 * 2540))
        ]
        if (
            is_wide_screen
            and len(visible_boxes) >= 3
            and max((item['x'] + item['width'] for item in visible_boxes), default=page_width) <= ten_inch_right_edge
            and centered_on_ten_inches
        ):
            ten_inch_canvas_pages.append(page_index + 1)

        occupied_area = sum(max(0, item['width']) * max(0, item['height']) for item in content_boxes)
        occupancy = occupied_area / max(1, page_width * page_height)
        page_occupancy.append({'page': page_index + 1, 'contentBoxes': len(content_boxes), 'ratio': round(occupancy, 4)})
        if occupancy > 0.88:
            issues.append({
                'severity': 'warning', 'type': 'high_content_occupancy', 'page': page_index + 1,
                'description': f'Content boxes consume {occupancy:.0%} of the slide area before accounting for whitespace; visual crowding is likely.',
                'repairHint': 'Reduce information density, increase whitespace, or split the content across slides.',
            })
        for left_index in range(len(content_boxes)):
            left = content_boxes[left_index]
            for right in content_boxes[left_index + 1:]:
                overlap = intersection(left, right)
                if overlap['width'] < 120 or overlap['height'] < 120:
                    continue
                smaller_area = min(left['width'] * left['height'], right['width'] * right['height'])
                if smaller_area <= 0:
                    continue
                ratio = overlap['area'] / smaller_area
                threshold, issue_type = collision_threshold(left, right)
                if ratio < threshold:
                    continue
                element_ids = [value for value in (left.get('elementId'), right.get('elementId')) if value]
                issues.append({
                    'severity': 'error', 'type': issue_type, 'page': page_index + 1,
                    'shapes': [left['shape'], right['shape']], 'kinds': [left['kind'], right['kind']],
                    'elementIds': element_ids,
                    'intersection': {key: overlap[key] for key in ('x', 'y', 'width', 'height')},
                    'overlapRatio': round(ratio, 4),
                    'description': (
                        f'{left["kind"]} and {right["kind"]} overlap by {ratio:.0%} of the smaller box '
                        f'between shapes {left["shape"]} and {right["shape"]}.'
                    ),
                    'repairHint': (
                        'Move, resize, shorten, or reflow only the reported elementIds. '
                        'If the overlap is deliberate, set allow_overlap=True on that authored element.'
                    ),
                })
    minimum_canvas_mismatch_pages = max(2, int(math.ceil(component.DrawPages.Count * 0.6)))
    if len(ten_inch_canvas_pages) >= minimum_canvas_mismatch_pages:
        page_list = ', '.join(str(page) for page in ten_inch_canvas_pages)
        issues.append({
            'severity': 'error',
            'type': 'presentation_canvas_width_mismatch',
            'page': ten_inch_canvas_pages[0],
            'description': (
                f'Slides {page_list} appear to be composed on a 10 x 7.5 inch coordinate system, '
                'but this presentation uses a 13.333 x 7.5 inch wide-screen canvas. Their visible '
                'content stops near x=10in and wide content is centered near x=5in, leaving a '
                'systematic empty band on the right.'
            ),
            'repairHint': (
                "Do not rely on align='CENTER' to position a box. Use named layout slots or "
                'slide.grid/stack without an explicit box; otherwise derive freeform geometry from '
                'deck.bounds()/deck.content_box() and center inch boxes with x = (13.333 - width) / 2.'
            ),
        })
    return {
        'checkedTextShapes': checked_text_shapes,
        'checkedContentShapes': checked_content_shapes,
        'pageOccupancy': page_occupancy,
        'issues': issues,
        'passed': not any(item['severity'] == 'error' for item in issues),
    }


def verify_word_layout(component, element_map=None):
    """Report Writer layout risk without removing advanced authoring freedom."""
    issues = []
    styles = component.StyleFamilies.getByName('PageStyles')
    style = styles.getByName(styles.getElementNames()[0])
    page_width, page_height = int(style.Width), int(style.Height)
    content_width = page_width - int(style.LeftMargin) - int(style.RightMargin)
    content_height = page_height - int(style.TopMargin) - int(style.BottomMargin)
    if content_width <= 0 or content_height <= 0:
        raise RuntimeError('Writer layout verification failed: page margins leave no usable content area.')

    frame_count = 0
    try:
        frames = component.TextFrames
        for name in frames.getElementNames():
            frame = frames.getByName(name)
            frame_count += 1
            width, height = int(frame.Width), int(frame.Height)
            if width <= 0 or height <= 0:
                raise RuntimeError(f'Writer layout verification failed: text frame {name!r} has a non-positive size.')
            if width > content_width or height > content_height:
                issues.append({
                    'severity': 'warning', 'type': 'oversized_text_frame', 'element': name,
                    'description': f'Text frame size {width}x{height} exceeds the normal content area {content_width}x{content_height}; confirm this intentional freeform layout visually.',
                })
    except AttributeError:
        pass

    drawing_count = 0
    text_shape_count = 0
    try:
        draw_page = component.DrawPage
        drawing_count = int(draw_page.getCount())
        for index in range(drawing_count):
            shape = draw_page.getByIndex(index)
            shape_name = str(getattr(shape, 'Name', '') or '')
            anchor = getattr(shape, 'Anchor', None)
            anchor_type = str(getattr(shape, 'AnchorType', '') or '')
            if anchor is None and 'AT_PAGE' not in anchor_type:
                issues.append(map_issue({
                    'severity': 'error', 'type': 'writer_drawing_missing_anchor', 'element': index + 1,
                    'description': 'Writer drawing object has neither a text anchor nor an explicit AT_PAGE anchor; it can silently move to page 1 after DOCX serialization.',
                }, element_map or [], shape_name, {'drawing': index + 1}))
            try:
                text = str(shape.String or '').strip()
            except Exception:
                text = ''
            try:
                position, shape_size = shape.Position, shape.Size
            except Exception:
                continue
            x, y = int(position.X), int(position.Y)
            width, height = int(shape_size.Width), int(shape_size.Height)
            if width <= 0 or height <= 0:
                raise RuntimeError(f'Writer layout verification failed: drawing object {index + 1} has a non-positive size.')
            if not text:
                continue
            text_shape_count += 1
            tolerance = 100
            # Writer exposes positions for paragraph/character-anchored objects relative
            # to their anchor. Only AT_PAGE positions use absolute page coordinates.
            if 'AT_PAGE' in anchor_type and (x < -tolerance or y < -tolerance or x + width > page_width + tolerance or y + height > page_height + tolerance):
                issues.append(map_issue({
                    'severity': 'warning', 'type': 'drawing_text_out_of_page', 'element': index + 1,
                    'description': f'Drawing text object bounds x={x}, y={y}, width={width}, height={height} extend beyond page size {page_width}x{page_height}; confirm the bleed or crop is intentional.',
                }, element_map or [], shape_name, {'drawing': index + 1}))
    except AttributeError:
        pass

    table_count = 0
    try:
        tables = component.TextTables
        for name in tables.getElementNames():
            table_count += 1
            table = tables.getByName(name)
            relative_width = int(getattr(table, 'RelativeWidth', 0) or 0)
            if relative_width > 100:
                issues.append({
                    'severity': 'warning', 'type': 'oversized_table', 'element': name,
                    'description': f'Table RelativeWidth={relative_width} exceeds the normal text area; confirm the layout visually.',
                })
    except AttributeError:
        pass

    return {
        'pageWidth': page_width, 'pageHeight': page_height,
        'contentWidth': content_width, 'contentHeight': content_height,
        'textFrames': frame_count, 'drawingObjects': drawing_count,
        'drawingTextObjects': text_shape_count, 'tables': table_count,
        'issues': issues,
    }


def verify_word_content(component, image_verification, layout_verification):
    text = str(component.Text.String or '').strip()
    image_count = int((image_verification or {}).get('checked', 0))
    try:
        drawing_count = int(component.DrawPage.getCount())
    except Exception:
        drawing_count = 0
    if not text and image_count == 0 and drawing_count == 0:
        raise RuntimeError('Writer content verification failed: the generated document has no readable text or images.')
    return {
        'textCharacters': len(text), 'images': image_count, 'drawingObjects': drawing_count,
        'layout': layout_verification,
    }


def verify_spreadsheet_content(component, element_map=None):
    sheets = component.Sheets
    if sheets.Count < 1:
        raise RuntimeError('Spreadsheet content verification failed: the workbook has no sheets.')
    summaries, formula_errors, issues = [], [], []
    for sheet_name in sheets.getElementNames():
        sheet = sheets.getByName(sheet_name)
        cursor = sheet.createCursor()
        cursor.gotoEndOfUsedArea(True)
        address = cursor.RangeAddress
        used_rows = int(address.EndRow) + 1
        used_columns = int(address.EndColumn) + 1
        non_empty = 0
        try:
            content_flags = 1 | 2 | 4 | 8 | 16
            content_ranges = sheet.queryContentCells(content_flags)
            for address in content_ranges.RangeAddresses:
                non_empty += (int(address.EndRow) - int(address.StartRow) + 1) * (int(address.EndColumn) - int(address.StartColumn) + 1)
            formula_flag = uno.getConstantByName('com.sun.star.sheet.CellFlags.FORMULA')
            formula_ranges = sheet.queryContentCells(formula_flag)
            for address in formula_ranges.RangeAddresses:
                for row in range(int(address.StartRow), int(address.EndRow) + 1):
                    for column in range(int(address.StartColumn), int(address.EndColumn) + 1):
                        cell = sheet.getCellByPosition(column, row)
                        error_code = int(getattr(cell, 'Error', 0) or 0)
                        if error_code:
                            formula_errors.append({'sheet': sheet_name, 'row': row + 1, 'column': column + 1, 'error': error_code})
        except Exception:
            # Conservative fallback for older UNO builds: scan the complete
            # used area rather than silently ignoring formulas after row 500
            # or column 100.
            for row in range(used_rows):
                for column in range(used_columns):
                    cell = sheet.getCellByPosition(column, row)
                    formula = str(getattr(cell, 'Formula', '') or '')
                    value = str(getattr(cell, 'String', '') or '')
                    if formula or value or float(getattr(cell, 'Value', 0) or 0) != 0:
                        non_empty += 1
                    error_code = int(getattr(cell, 'Error', 0) or 0)
                    if error_code:
                        formula_errors.append({'sheet': sheet_name, 'row': row + 1, 'column': column + 1, 'error': error_code})
        summaries.append({'sheet': sheet_name, 'usedRows': used_rows, 'usedColumns': used_columns, 'nonEmptyCellsScanned': non_empty})
    if not any(item['nonEmptyCellsScanned'] for item in summaries):
        issues.append({'severity': 'error', 'type': 'empty_workbook', 'description': 'Every worksheet is empty.'})
    if formula_errors:
        sample = ', '.join(f'{item["sheet"]}!R{item["row"]}C{item["column"]}:{item["error"]}' for item in formula_errors[:10])
        first = formula_errors[0]
        issues.append(map_issue({
            'severity': 'error', 'type': 'formula_error',
            'description': f'{len(formula_errors)} formula errors detected ({sample}).',
        }, element_map or [], locator={'sheet': first['sheet'], 'row': first['row'], 'column': first['column']}))
    return {'sheets': summaries, 'formulaErrors': len(formula_errors), 'issues': issues,
            'passed': not any(item['severity'] == 'error' for item in issues)}


def verify_embedded_images(component, document_type, element_map=None):
    """Validate only native image objects after a fresh file reopen.

    This is output-level validation, not a model-source rewrite: it catches a
    missing image payload and any image that leaves its slide/page before a
    result is exposed as a successful artifact.
    """
    checked = 0
    if document_type == 'presentation':
        for page_index in range(component.DrawPages.Count):
            page = component.DrawPages.getByIndex(page_index)
            page_width, page_height = int(page.Width), int(page.Height)
            for shape_index in range(page.getCount()):
                shape = page.getByIndex(shape_index)
                try:
                    is_image = shape.supportsService('com.sun.star.drawing.GraphicObjectShape')
                except Exception:
                    is_image = False
                if not is_image:
                    continue
                checked += 1
                graphic_url = str(getattr(shape, 'GraphicURL', '') or '')
                if not graphic_url:
                    raise RuntimeError(f'Image verification failed: slide {page_index + 1}, image {shape_index + 1} has no embedded graphic')
                position, size = shape.Position, shape.Size
                x, y, width, height = int(position.X), int(position.Y), int(size.Width), int(size.Height)
                if width <= 0 or height <= 0 or x < 0 or y < 0 or x + width > page_width or y + height > page_height:
                    raise RuntimeError(
                        f'Image verification failed: slide {page_index + 1}, image {shape_index + 1} is outside slide bounds '
                        f'(x={x}, y={y}, width={width}, height={height}, slideWidth={page_width}, slideHeight={page_height}). '
                        'Edit the current draft image position/size using job.document_bounds(doc).'
                    )
        return {'checked': checked}
    if document_type == 'word':
        issues = []
        try:
            styles = component.StyleFamilies.getByName('PageStyles')
            style = styles.getByName(styles.getElementNames()[0])
            content_width = int(style.PageWidth) - int(style.LeftMargin) - int(style.RightMargin)
            content_height = int(style.PageHeight) - int(style.TopMargin) - int(style.BottomMargin)
            graphics = component.GraphicObjects
            for index in range(graphics.getCount()):
                image = graphics.getByIndex(index)
                checked += 1
                width, height = int(image.Width), int(image.Height)
                if width <= 0 or height <= 0:
                    raise RuntimeError(
                        f'Image verification failed: Writer image {index + 1} has a non-positive size '
                        f'(width={width}, height={height}).'
                    )
                if width > content_width or height > content_height:
                    issues.append({
                        'severity': 'warning', 'type': 'image_exceeds_text_area', 'image': index + 1,
                        'description': f'Writer image size {width}x{height} exceeds the normal content area {content_width}x{content_height}; confirm that the full-bleed or floating placement is intentional.',
                    })
        except AttributeError:
            # This LibreOffice build does not expose a Writer graphic collection.
            pass
        return {'checked': checked, 'issues': issues}
    return {'checked': 0}


PROGRESS_PREFIX = '__WEBPILOT_PROGRESS__'


def emit_progress(phase, message, current=None, total=None):
    payload = {'phase': phase, 'message': message}
    if current is not None:
        payload['current'] = current
    if total is not None:
        payload['total'] = total
    sys.stderr.write(PROGRESS_PREFIX + json.dumps(payload, ensure_ascii=False) + '\n')
    sys.stderr.flush()


def document_attribute_error(error, program):
    """Attribute errors inside the facade are not evidence of a bad draft API call."""
    worker_path = Path(__file__).resolve()
    program_path = Path(program).resolve()
    origin = None
    trace = error.__traceback__
    while trace is not None:
        filename = Path(trace.tb_frame.f_code.co_filename).resolve()
        if filename in (worker_path, program_path):
            origin = (filename, trace.tb_frame.f_code.co_name, trace.tb_lineno)
        trace = trace.tb_next
    if origin is not None and origin[0] == worker_path:
        return RuntimeError(
            f'UNO_WORKER_INTERNAL_ERROR: {origin[1]} at worker line {origin[2]}: {error}. '
            'The renderer failed internally; this does not identify a draft source defect. '
            'Do not edit the draft, query unoApi, or repeat the same render to repair this error. '
            'Report the runtime failure and retry only after the renderer is fixed.'
        )
    return RuntimeError(
        f'UNO draft attempted an unavailable member: {error}. '
        'Query the corresponding unoApi module, copy its exact installed signature and example, '
        'and edit the current draft.py without another feature-discovery call.'
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--program')
    parser.add_argument('--output')
    parser.add_argument('--preview')
    parser.add_argument('--assets')
    parser.add_argument('--expected-source-digest')
    parser.add_argument('--required-source-asset')
    parser.add_argument('--inspect-target', choices=('facade', 'all', 'document', 'page', 'text', 'cursor', 'sheet', 'cell', 'shape', 'table', 'table-column', 'table-row', 'chart', 'chart-data'))
    parser.add_argument('--api-query', default='')
    parser.add_argument('--api-offset', type=int, default=0)
    parser.add_argument('--api-limit', type=int, default=120)
    parser.add_argument('--document-type', required=True, choices=('word', 'spreadsheet', 'presentation'))
    parser.add_argument('--profile', required=True)
    parser.add_argument('--soffice', required=True)
    parser.add_argument('--uno-pipe')
    args = parser.parse_args()
    soffice, profile = Path(args.soffice).resolve(), Path(args.profile).resolve()
    if args.inspect_target:
        print(json.dumps(inspect_uno_api(soffice, profile, args.document_type, args.inspect_target, args.api_query, args.api_offset, args.api_limit), ensure_ascii=False))
        return
    if not all((args.program, args.output, args.preview, args.assets)):
        raise ValueError('program, output, preview, and assets are required for document generation')
    program, output, preview, assets = Path(args.program).resolve(), Path(args.output).resolve(), Path(args.preview).resolve(), Path(args.assets).resolve()
    if args.expected_source_digest:
        actual_source_digest = hashlib.sha256(program.read_bytes()).hexdigest()
        if actual_source_digest != args.expected_source_digest:
            raise RuntimeError('draft.py changed after validation; retry the render from the current saved source')
    if output.suffix.lower() not in FILTERS and output.suffix.lower() != '.pdf':
        raise ValueError(f'Unsupported output extension: {output.suffix}')
    if output.suffix.lower() in FILTERS and FILTERS[output.suffix.lower()][0] != args.document_type:
        raise ValueError(f'{output.suffix} is not valid for documentType={args.document_type}')
    output.parent.mkdir(parents=True, exist_ok=True)
    process = context = desktop = None
    try:
        emit_progress('execute', '正在启动 LibreOffice')
        process, context, desktop = connect_office(soffice, profile, args.uno_pipe)
        namespace = program_namespace(program)
        job = DocumentJob(output, assets, args.document_type, context, desktop, program)
        # Keep draft print output out of the machine-readable report channel.
        with contextlib.redirect_stdout(sys.stderr):
            try:
                emit_progress('execute', '正在执行文档脚本')
                heartbeat_stop = threading.Event()
                heartbeat = threading.Thread(
                    target=lambda: [emit_progress('execute', '文档脚本仍在执行') for _ in iter(lambda: not heartbeat_stop.wait(10), False)],
                    daemon=True,
                )
                heartbeat.start()
                try:
                    namespace['create_document'](job)
                finally:
                    heartbeat_stop.set()
                    heartbeat.join(timeout=1)
            except AttributeError as error:
                raise document_attribute_error(error, program) from error
        if args.required_source_asset and args.required_source_asset not in job.opened_documents:
            raise RuntimeError(
                f'Existing-file modification must open {args.required_source_asset!r} through source_name on a stable facade or expert.open_document(...). '
                'Creating a replacement document is not allowed for this plan.'
            )
        if not output.is_file() or output.stat().st_size < 64:
            raise RuntimeError(
                'create_document(job) did not create the requested output file. '
                'Ensure the facade returned by job.presentation/job.writer/job.spreadsheet calls save() exactly once before close().'
            )
        emit_progress('reopen', 'Reopening the saved Office artifact for structural verification')
        source = (assets / args.required_source_asset).resolve() if args.required_source_asset else None
        try:
            verification = verify_and_preview(
                soffice, profile.parent / 'verification-profile', output, preview,
                args.document_type, source, job.element_map(),
                context=context, desktop=desktop, existing_pipe=args.uno_pipe,
            )
        except Exception as error:
            # Closing the authored component can occasionally dispose the
            # shared Desktop after a shape-heavy Impress export. Re-running
            # the complete draft is wasteful and can repeat non-idempotent
            # work. Reopen the already-published candidate once in a fresh,
            # isolated verifier instead.
            message = str(error)
            if ('DisposedException' not in message
                    and 'Binary URP bridge already disposed' not in message
                    and 'bridge disposed during call' not in message):
                raise
            emit_progress('bridge-retry', 'Reopening the saved artifact in a fresh LibreOffice verifier', 1, 1)
            verification = verify_and_preview(
                soffice, profile.parent / f'verification-profile-{uuid.uuid4().hex}', output, preview,
                args.document_type, source, job.element_map(),
            )
    finally:
        shutdown_office(process, desktop)
    emit_progress('visual', '结构验证完成，预览已生成')
    print(json.dumps({
        'bytes': output.stat().st_size, 'output': str(output), 'preview': str(preview),
        'renderer': 'libreoffice-uno', 'verification': verification, 'elementMap': job.element_map(),
        'featureCounts': job.feature_counts,
        'staticDiagnostics': namespace.get('__webpilot_static_diagnostics__', []),
        'runtimeDiagnostics': job.runtime_diagnostics,
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
