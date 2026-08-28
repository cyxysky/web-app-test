from __future__ import annotations

import argparse
import ast
import contextlib
import hashlib
import inspect
import json
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
import zipfile
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
    (document.storeToURL if suffix == '.pdf' else document.storeAsURL)(job.output_url, properties)


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


def connect_office(soffice: Path, profile: Path):
    profile.mkdir(parents=True, exist_ok=True)
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', local)
    last_error = None
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

    @property
    def output_url(self):
        return self.output_path.as_uri()

    def asset_path(self, name: str):
        candidate = (self.assets_path / name).resolve()
        if candidate != self.assets_path and self.assets_path not in candidate.parents:
            raise ValueError('Asset paths must stay within job.assets_path')
        if not candidate.is_file():
            available = ', '.join(item['name'] for item in self.list_assets()) or '(none)'
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
        return self.desktop.loadComponentFromURL(factories[kind], '_blank', 0, (self.property('Hidden', True),))

    def new_document(self, kind=None):
        raise RuntimeError("Direct job.new_document() is expert-only. Use a stable layout facade, or job.expert(reason).new_document(kind).")

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
        raise RuntimeError("Direct job.open_document() is expert-only. Pass source_name to a stable layout facade, or use job.expert(reason).open_document(name).")

    def close(self, component):
        close_component(component)

    def _source_location(self):
        expected = str(self.source_path.resolve())
        for frame in inspect.stack():
            try:
                if str(Path(frame.filename).resolve()) == expected:
                    return {'line': int(frame.lineno), 'column': 1}
            except Exception:
                continue
        return {}

    def register_element(self, element_id, kind, target=None, locator=None, force_artifact_name=False):
        value = str(element_id or '').strip()
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,127}', value):
            raise ValueError('elementId must use 1-128 ASCII letters, numbers, dot, underscore, slash, or hyphen')
        if value in self.element_records:
            raise ValueError(f'Duplicate elementId: {value}. elementId values must be stable and unique.')
        artifact_name = 'wp_' + re.sub(r'[^A-Za-z0-9_]', '_', value)
        record = {
            'elementId': value, 'artifactName': artifact_name, 'kind': str(kind),
            **self._source_location(), 'locator': dict(locator or {}),
        }
        self.element_records[value] = record
        if target is not None:
            for property_name in ('Name', 'Title'):
                try:
                    if hasattr(target, property_name) and (force_artifact_name or not str(getattr(target, property_name, '') or '')):
                        setattr(target, property_name, artifact_name)
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
        return PresentationLayout(self, target)

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


class UnoExpertAccess:
    """Explicit escape hatch for features not modeled by the stable facades."""

    def __init__(self, job, reason):
        self.job, self.reason = job, reason
        self.context, self.desktop, self.uno = job.context, job.desktop, uno

    def new_document(self, kind=None):
        return self.job._new_document(kind)

    def open_document(self, name):
        return self.job._open_document(name)

    def tag(self, target, element_id, kind='expert-element', locator=None):
        return self.job.register_element(element_id, kind, target, locator, force_artifact_name=True)


class WriterLayout:
    """Stable flow-layout helpers backed by native UNO Writer objects.

    The facade is the default authoring surface because paragraphs, tables and
    inline media participate in Writer pagination. Advanced objects require
    an explicit ``job.expert(reason)`` escape hatch.
    """

    def __init__(self, job, component):
        self.job = job
        self._component = component
        self._paragraph_count = 0

    def _end_cursor(self):
        cursor = self._component.Text.createTextCursor()
        cursor.gotoEnd(False)
        return cursor

    def _page_style(self):
        styles = self._component.StyleFamilies.getByName('PageStyles')
        return styles.getByName(styles.getElementNames()[0])

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
            style.HeaderText.String = str(header)
            record = self.job.register_element(header_element_id, 'header', style.HeaderText, {'role': 'header'})
            cursor = style.HeaderText.createTextCursor()
            cursor.gotoStart(False)
            bookmark = self._component.createInstance('com.sun.star.text.Bookmark')
            bookmark.Name = record['artifactName']
            style.HeaderText.insertTextContent(cursor, bookmark, False)
        if footer:
            if not footer_element_id:
                raise ValueError('footer_element_id is required when footer text is present')
            style.FooterText.String = str(footer)
            record = self.job.register_element(footer_element_id, 'footer', style.FooterText, {'role': 'footer'})
            cursor = style.FooterText.createTextCursor()
            cursor.gotoStart(False)
            bookmark = self._component.createInstance('com.sun.star.text.Bookmark')
            bookmark.Name = record['artifactName']
            style.FooterText.insertTextContent(cursor, bookmark, False)
        return self

    def add_paragraph(self, element_id, value='', font_size=11, bold=False, italic=False, color=0x000000,
                      align='LEFT', line_spacing=1.3, space_before=0, space_after=180, paragraph_style=None):
        cursor = self._end_cursor()
        cursor.NumberingStyleName = ''
        if paragraph_style:
            cursor.ParaStyleName = str(paragraph_style)
        cursor.CharHeight = float(font_size)
        cursor.CharWeight = 150.0 if bold else 100.0
        cursor.CharPosture = uno.Enum('com.sun.star.awt.FontSlant', 'ITALIC' if italic else 'NONE')
        cursor.CharColor = int(color)
        cursor.ParaAdjust = uno.Enum('com.sun.star.style.ParagraphAdjust', str(align).upper())
        spacing = uno.createUnoStruct('com.sun.star.style.LineSpacing')
        spacing.Mode, spacing.Height = 0, max(100, int(float(line_spacing) * 100))
        cursor.ParaLineSpacing = spacing
        cursor.ParaTopMargin = max(0, int(space_before))
        cursor.ParaBottomMargin = max(0, int(space_after))
        self._paragraph_count += 1
        record = self.job.register_element(element_id, 'paragraph', None, {'paragraph': self._paragraph_count})
        bookmark = self._component.createInstance('com.sun.star.text.Bookmark')
        bookmark.Name = record['artifactName']
        self._component.Text.insertTextContent(cursor, bookmark, False)
        self._component.Text.insertString(cursor, str(value), False)
        paragraph_break = uno.getConstantByName('com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK')
        self._component.Text.insertControlCharacter(cursor, paragraph_break, False)
        return self

    def add_heading(self, element_id, value, level=1, color=0x1F2937, align='LEFT'):
        sizes = {1: 24, 2: 18, 3: 15, 4: 13}
        level = min(4, max(1, int(level)))
        return self.add_paragraph(
            element_id, value,
            font_size=sizes[level],
            bold=True,
            color=color,
            align=align,
            line_spacing=1.15,
            space_before=220 if level > 1 else 0,
            space_after=180,
            paragraph_style=f'Heading {level}',
        )

    def add_bullets(self, element_id, values, level=0, font_size=11, color=0x000000):
        list_level = max(0, int(level))
        for index, value in enumerate(values):
            cursor = self._end_cursor()
            cursor.CharHeight = float(font_size)
            cursor.CharColor = int(color)
            cursor.ParaBottomMargin = 80
            cursor.NumberingStyleName = 'List 1'
            cursor.NumberingLevel = list_level
            self._paragraph_count += 1
            record = self.job.register_element(
                f'{element_id}/{index + 1}', 'list-item', None,
                {'paragraph': self._paragraph_count, 'level': list_level},
            )
            bookmark = self._component.createInstance('com.sun.star.text.Bookmark')
            bookmark.Name = record['artifactName']
            self._component.Text.insertTextContent(cursor, bookmark, False)
            self._component.Text.insertString(cursor, str(value), False)
            paragraph_break = uno.getConstantByName('com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK')
            self._component.Text.insertControlCharacter(cursor, paragraph_break, False)
        return self

    def add_table(self, element_id, rows, column_widths=None, header=True, font_size=10):
        data = [list(row) for row in rows]
        if not data or not data[0]:
            raise ValueError('Writer table requires at least one row and one column')
        column_count = len(data[0])
        if any(len(row) != column_count for row in data):
            raise ValueError('Writer table rows must all have the same column count')
        cursor = self._end_cursor()
        record = self.job.register_element(element_id, 'table', None, {'table': len(self._component.TextTables.ElementNames) + 1})
        bookmark = self._component.createInstance('com.sun.star.text.Bookmark')
        bookmark.Name = record['artifactName']
        self._component.Text.insertTextContent(cursor, bookmark, False)
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
                cell.String = str(value)
                cell_cursor = cell.createTextCursor()
                cell_cursor.gotoEnd(True)
                cell_cursor.CharHeight = float(font_size)
                if header and row_index == 0:
                    cell_cursor.CharWeight = 150.0
                    cell.BackColor = 0xE8EEF7
        return table

    def add_inline_image(self, element_id, asset_name, width=None, height=None):
        cursor = self._end_cursor()
        record = self.job.register_element(element_id, 'image', None, {'image': len(self.job.element_records)})
        bookmark = self._component.createInstance('com.sun.star.text.Bookmark')
        bookmark.Name = record['artifactName']
        self._component.Text.insertTextContent(cursor, bookmark, False)
        image = self._component.createInstance('com.sun.star.text.TextGraphicObject')
        image.GraphicURL = uno.systemPathToFileUrl(str(self.job.asset_path(asset_name)))
        image.AnchorType = uno.Enum('com.sun.star.text.TextContentAnchorType', 'AS_CHARACTER')
        bounds = self.job.document_bounds(self._component)
        try:
            natural_size = image.Graphic.Size100thMM
            natural_width, natural_height = int(natural_size.Width), int(natural_size.Height)
        except Exception:
            natural_width, natural_height = 12000, 7000
        if width is not None and height is None and natural_width > 0:
            height = int(float(width) * natural_height / natural_width)
        elif height is not None and width is None and natural_height > 0:
            width = int(float(height) * natural_width / natural_height)
        elif width is None and height is None:
            scale = min(1.0, bounds['contentWidth'] / natural_width, bounds['contentHeight'] / natural_height)
            width, height = int(natural_width * scale), int(natural_height * scale)
        image.Width = min(int(width or natural_width), bounds['contentWidth'])
        image.Height = min(int(height or natural_height), bounds['contentHeight'])
        if image.Width <= 0 or image.Height <= 0:
            raise ValueError('Writer inline image dimensions must be positive')
        self._component.Text.insertTextContent(cursor, image, False)
        return image

    def add_page_break(self, element_id):
        cursor = self._end_cursor()
        cursor.NumberingStyleName = ''
        record = self.job.register_element(element_id, 'page-break', None, {'paragraph': self._paragraph_count + 1})
        bookmark = self._component.createInstance('com.sun.star.text.Bookmark')
        bookmark.Name = record['artifactName']
        self._component.Text.insertTextContent(cursor, bookmark, False)
        cursor.BreakType = uno.Enum('com.sun.star.style.BreakType', 'PAGE_BEFORE')
        paragraph_break = uno.getConstantByName('com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK')
        self._component.Text.insertControlCharacter(cursor, paragraph_break, False)
        return self

    def save(self):
        suffix = self.job.output_path.suffix.lower()
        filters = {
            '.doc': 'MS Word 97', '.docx': 'Office Open XML Text',
            '.odt': 'writer8', '.pdf': 'writer_pdf_Export',
        }
        if suffix not in filters:
            raise ValueError(f'Unsupported Writer output extension: {suffix}')
        properties = (self.job.property('FilterName', filters[suffix]), self.job.property('Overwrite', True))
        (self._component.storeToURL if suffix == '.pdf' else self._component.storeAsURL)(self.job.output_url, properties)
        return self

    def close(self):
        self.job.close(self._component)


class PresentationLayout:
    """Stable Impress geometry helpers. Expert mode covers unmodeled services."""

    def __init__(self, job, component):
        self.job, self._component = job, component
        self._slide_count = 0

    def add_slide(self, element_id):
        if self._slide_count == 0 and self._component.DrawPages.Count == 1:
            page = self._component.DrawPages.getByIndex(0)
            while page.getCount():
                page.remove(page.getByIndex(0))
        else:
            page = self._component.DrawPages.insertNewByIndex(self._component.DrawPages.Count)
        self._slide_count += 1
        self.job.register_element(
            element_id,
            'slide',
            page,
            {'slide': self._slide_count},
            force_artifact_name=True,
        )
        return page

    def _add_shape(self, page, element_id, service, x, y, width, height, kind):
        if min(int(x), int(y)) < 0 or int(width) <= 0 or int(height) <= 0:
            raise ValueError('Presentation geometry requires non-negative position and positive size')
        shape = self._component.createInstance(service)
        shape.Position, shape.Size = point(int(x), int(y)), size(int(width), int(height))
        page.add(shape)
        page_name = str(getattr(page, 'Name', '') or '')
        page_record = next((item for item in self.job.element_records.values() if item.get('artifactName') == page_name), None)
        page_index = int((page_record or {}).get('locator', {}).get('slide') or 1)
        self.job.register_element(element_id, kind, shape, {'slide': page_index, 'shape': int(page.getCount())})
        return shape

    def add_text(self, element_id, page, text, x, y, width, height, font_size=18, color=0x000000):
        shape = self._add_shape(page, element_id, 'com.sun.star.drawing.TextShape', x, y, width, height, 'text')
        shape.String = str(text)
        cursor = shape.Text.createTextCursor()
        cursor.gotoEnd(True)
        cursor.CharHeight, cursor.CharColor = float(font_size), int(color)
        return shape

    def add_shape(self, element_id, page, x, y, width, height, service='com.sun.star.drawing.RectangleShape'):
        return self._add_shape(page, element_id, service, x, y, width, height, 'shape')

    def add_image(self, element_id, page, asset_name, x, y, width, height):
        shape = self._add_shape(page, element_id, 'com.sun.star.drawing.GraphicObjectShape', x, y, width, height, 'image')
        shape.GraphicURL = uno.systemPathToFileUrl(str(self.job.asset_path(asset_name)))
        return shape

    def save(self):
        save_document(self._component, self.job)
        return self

    def close(self):
        self.job.close(self._component)


class SpreadsheetLayout:
    """Stable Calc cell/range helpers. Expert mode covers charts and uncommon services."""

    def __init__(self, job, component):
        self.job, self._component = job, component

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
        record = self.job.register_element(element_id, 'cell', cell, {'sheet': str(sheet.Name), 'row': int(row) + 1, 'column': int(column) + 1})
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
        })
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

    def save(self):
        save_document(self._component, self.job)
        return self

    def close(self):
        self.job.close(self._component)


def validate_program(source: str):
    tree = ast.parse(source, filename='draft.py', mode='exec')
    entrypoints = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == 'create_document']
    if len(entrypoints) != 1 or len(entrypoints[0].args.args) != 1:
        raise ValueError('Draft must define exactly one synchronous create_document(job) function')
    if isinstance(entrypoints[0], ast.AsyncFunctionDef):
        raise ValueError('create_document(job) must be synchronous')
    diagnostics, expert_calls, tag_calls = [], 0, 0
    element_methods = {
        'add_paragraph', 'add_heading', 'add_bullets', 'add_table', 'add_inline_image', 'add_page_break',
        'add_slide', 'add_text', 'add_shape', 'add_image', 'add_worksheet', 'set_cell', 'set_range',
    }
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            name = node.func.attr if isinstance(node.func, ast.Attribute) else node.func.id if isinstance(node.func, ast.Name) else ''
            if name in {'eval', 'exec', 'compile', '__import__'}:
                diagnostics.append({'code': 'UNSAFE_DYNAMIC_EXECUTION', 'line': node.lineno, 'column': node.col_offset + 1,
                                    'message': f'{name} is forbidden in an Office draft.', 'severity': 'error'})
            if name in element_methods:
                first = node.args[0] if node.args else next((item.value for item in node.keywords if item.arg == 'element_id'), None)
                if not isinstance(first, ast.Constant) or not isinstance(first.value, str):
                    diagnostics.append({'code': 'ELEMENT_ID_REQUIRED', 'line': node.lineno, 'column': node.col_offset + 1,
                                        'message': f'{name} requires a stable string element_id.', 'severity': 'error'})
            if name == 'expert':
                expert_calls += 1
                reason = node.args[0] if node.args else None
                if not isinstance(reason, ast.Constant) or not isinstance(reason.value, str) or len(reason.value.strip()) < 8:
                    diagnostics.append({'code': 'EXPERT_REASON_REQUIRED', 'line': node.lineno, 'column': node.col_offset + 1,
                                        'message': 'job.expert(reason) requires a concrete reason of at least 8 characters.', 'severity': 'error'})
                else:
                    diagnostics.append({'code': 'EXPERT_MODE_USED', 'line': node.lineno, 'column': node.col_offset + 1,
                                        'message': f'Expert mode declared: {reason.value.strip()}', 'severity': 'warning'})
            if name == 'tag':
                tag_calls += 1
        if isinstance(node, ast.Attribute) and node.attr == 'raw':
            diagnostics.append({'code': 'RAW_ACCESS_REQUIRES_EXPERT_MODE', 'line': node.lineno, 'column': node.col_offset + 1,
                                'message': 'Direct .raw access is not available; use job.expert(reason).', 'severity': 'error'})
    if expert_calls and not tag_calls:
        diagnostics.append({'code': 'EXPERT_ELEMENTS_NOT_TAGGED', 'message': 'Expert mode is used, but no expert.tag(...) call was found.', 'severity': 'error'})
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


def uno_cookbook(document_type):
    """Executable patterns for the high-frequency UNO authoring operations.

    Reflection tells the model which members exist, but not how UNO enum,
    constant-group, struct, cursor, table, and export APIs compose. Keep these
    examples next to the installed reflection response so authors can copy a
    known pattern instead of guessing from member names.
    """
    common_rules = [
        'All geometry is in 1/100 mm. Read job.document_bounds(doc); never assume A4 or a slide size.',
        'CharHeight is always measured in typographic points (pt), not 1/100 mm. Assign the requested point value directly; never multiply by 35.28 or any geometry conversion factor.',
        'uno.Enum(typeName, memberName) is for UNO enum types. uno.getConstantByName(fullyQualifiedName) is for constant groups. Never substitute guessed integers.',
        'Create a fresh end cursor with cursor = doc.Text.createTextCursor(); cursor.gotoEnd(False) before appending Writer content.',
        'Use job.writer(element_id), job.presentation(element_id), or job.spreadsheet(element_id) by default. Every generated element requires a stable elementId.',
        'For an unmodeled feature, call expert = job.expert(concrete_reason), create the raw UNO object through expert, and register every created object with expert.tag(target, element_id, kind, locator).',
        'ControlCharacter has paragraph/line characters but no PAGE_BREAK member. Writer page breaks use the paragraph BreakType enum.',
        'For Impress TextShape objects, assign Position and Size, call page.add(shape), and only then assign String/Text and text formatting. Text written before page.add(shape) is lost by this LibreOffice runtime.',
        'For an existing-file modification plan, pass source_name=exactSourceAssetName to the matching stable facade. If expert access is required, call expert.open_document(name). Never create a replacement document.',
        'Use storeToURL for PDF export and storeAsURL for editable Office formats. Select the filter from job.output_path.suffix.',
        'Close the document only after the synchronous store/export call has returned.',
    ]
    save_examples = {
        'word': '''def save_document(doc, job):
    suffix = job.output_path.suffix.lower()
    filters = {
        '.doc': 'MS Word 97', '.docx': 'Office Open XML Text',
        '.odt': 'writer8', '.pdf': 'writer_pdf_Export',
    }
    properties = (job.property('FilterName', filters[suffix]), job.property('Overwrite', True))
    (doc.storeToURL if suffix == '.pdf' else doc.storeAsURL)(job.output_url, properties)''',
        'spreadsheet': '''def save_document(doc, job):
    suffix = job.output_path.suffix.lower()
    filters = {
        '.xls': 'MS Excel 97', '.xlsx': 'Calc MS Excel 2007 XML',
        '.ods': 'calc8', '.pdf': 'calc_pdf_Export',
    }
    properties = (job.property('FilterName', filters[suffix]), job.property('Overwrite', True))
    (doc.storeToURL if suffix == '.pdf' else doc.storeAsURL)(job.output_url, properties)''',
        'presentation': '''def save_document(doc, job):
    suffix = job.output_path.suffix.lower()
    filters = {
        '.ppt': 'MS PowerPoint 97', '.pptx': 'Impress MS PowerPoint 2007 XML',
        '.odp': 'impress8', '.pdf': 'impress_pdf_Export',
    }
    properties = (job.property('FilterName', filters[suffix]), job.property('Overwrite', True))
    (doc.storeToURL if suffix == '.pdf' else doc.storeAsURL)(job.output_url, properties)''',
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
        operations = {
            'openExisting': '''deck = job.presentation('source-deck', source_name='exact-source-asset-name.pptx')
# Modify through the stable facade and preserve all unrelated slides and objects.''',
            'bounds': '''bounds = job.document_bounds(doc)
# Exact keys: kind, width, height. Values are 1/100 mm.
slide_width, slide_height = bounds['width'], bounds['height']''',
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
page.add(card)''',
            'newSlide': '''page = doc.DrawPages.insertNewByIndex(doc.DrawPages.Count)
# Add shapes only after assigning explicit Position and Size inside bounds.''',
            'save': save_examples['presentation'],
        }
        complete = '''def create_document(job):
    deck = job.presentation('deck')
    page = deck.add_slide('slide-01')
    deck.add_text('slide-01/title', page, 'UNO Impress deck', 1600, 1200, 22000, 3200, font_size=28)
    deck.add_shape('slide-01/card', page, 1600, 5200, 9000, 5000)
    deck.save()
    deck.close()'''
        coverage = ['create/save PPT/PPTX/ODP/PDF', 'native slide bounds', 'text shapes with fixed point-size formatting', 'graphic shapes', 'filled shapes', 'new slides', 'explicit in-slide geometry']
    modification = save_examples[document_type] + '''

def create_document(job):
    # Replace this placeholder with sourceDocument.assetName returned by action=plan.
    expert = job.expert('The requested edit requires direct access to existing Office objects.')
    doc = expert.open_document('exact-source-asset-name')
    expert.tag(doc, 'source-document', 'existing-document', {'role': 'document'})
    # Locate and edit only the requested existing content here.
    save_document(doc, job)
    job.close(doc)'''
    return {
        'status': 'copy these installed-runtime patterns; do not paraphrase them into guessed UNO calls',
        'coverage': coverage,
        'rules': common_rules,
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
    process = context = desktop = document = None
    try:
        process, context, desktop = connect_office(soffice, profile)
        document = desktop.loadComponentFromURL(factory_url(document_type), '_blank', 0, (property_value('Hidden', True),))
        normalized_query = str(query or '').strip().lower()
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
            'locator': match.get('locator'),
        })
    return issue


def verify_and_preview(soffice, profile, output, preview, document_type, source=None, element_map=None):
    element_map = element_map or []
    if output.suffix.lower() == '.pdf':
        if output.stat().st_size < 64:
            raise RuntimeError('Generated PDF is empty')
        shutil.copyfile(output, preview)
        return {'format': 'pdf', 'verification': 'file-size'}
    process = context = desktop = component = source_component = None
    try:
        process, context, desktop = connect_office(soffice, profile)
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
        text_verification = verify_presentation_text(component) if document_type == 'presentation' else None
        layout_verification = verify_presentation_layout(component, element_map) if document_type == 'presentation' else None
        spreadsheet_verification = verify_spreadsheet_content(component, element_map) if document_type == 'spreadsheet' else None
        word_layout_verification = verify_word_layout(component, element_map) if document_type == 'word' else None
        word_verification = verify_word_content(component, image_verification, word_layout_verification) if document_type == 'word' else None
        component.storeToURL(preview.as_uri(), (property_value('FilterName', PDF_FILTERS[document_type]), property_value('Overwrite', True)))
        if not preview.is_file() or preview.stat().st_size < 64:
            raise RuntimeError('LibreOffice could not export a PDF preview')
        checks = [item for item in (image_verification, layout_verification, spreadsheet_verification, word_layout_verification) if item]
        issues = [issue for check in checks for issue in check.get('issues', [])]
        common = {'issues': issues, 'passed': not any(item.get('severity') == 'error' for item in issues)}
        if document_type == 'presentation':
            return {**common, 'format': 'presentation', 'pages': component.DrawPages.Count, 'images': image_verification, 'text': text_verification, 'layout': layout_verification, 'fidelity': fidelity}
        if document_type == 'spreadsheet':
            return {**common, 'format': 'spreadsheet', 'sheets': list(component.Sheets.getElementNames()), 'content': spreadsheet_verification, 'fidelity': fidelity}
        return {**common, 'format': 'word', 'textCharacters': len(str(component.Text.String or '')), 'images': image_verification, 'content': word_verification, 'fidelity': fidelity}
    finally:
        close_component(source_component)
        close_component(component)
        shutdown_office(process, desktop)


def verify_presentation_text(component):
    """Reject the common detached-TextShape failure after a fresh reopen."""
    text_shapes, non_empty_text_shapes, text_characters = 0, 0, 0
    shape_types = {}
    for page_index in range(component.DrawPages.Count):
        page = component.DrawPages.getByIndex(page_index)
        for shape_index in range(page.getCount()):
            shape = page.getByIndex(shape_index)
            try:
                shape_type = str(shape.getShapeType())
            except Exception:
                shape_type = ''
            shape_types[shape_type or '(unknown)'] = shape_types.get(shape_type or '(unknown)', 0) + 1
            if shape_type.startswith('com.sun.star.presentation.'):
                continue
            try:
                value = str(shape.String or '')
            except Exception:
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


def verify_presentation_layout(component, element_map=None):
    """Reject objective slide defects and report high-confidence overlap diagnostics."""
    issues = []
    checked_text_shapes = 0
    for page_index in range(component.DrawPages.Count):
        page = component.DrawPages.getByIndex(page_index)
        page_width, page_height = int(page.Width), int(page.Height)
        if page.getCount() == 0:
            issues.append({'severity': 'error', 'type': 'empty_page', 'page': page_index + 1, 'description': 'Page has no shapes.'})
            continue
        text_boxes = []
        for shape_index in range(page.getCount()):
            shape = page.getByIndex(shape_index)
            try:
                value = str(shape.String or '').strip()
            except Exception:
                value = ''
            if not value:
                continue
            checked_text_shapes += 1
            position, shape_size = shape.Position, shape.Size
            x, y = int(position.X), int(position.Y)
            width, height = int(shape_size.Width), int(shape_size.Height)
            if width <= 0 or height <= 0 or x < 0 or y < 0 or x + width > page_width or y + height > page_height:
                issues.append(map_issue({
                    'severity': 'error', 'type': 'text_out_of_bounds', 'page': page_index + 1,
                    'shape': shape_index + 1,
                    'description': f'Text box is outside slide bounds: x={x}, y={y}, width={width}, height={height}, slideWidth={page_width}, slideHeight={page_height}.',
                }, element_map or [], str(getattr(shape, 'Name', '') or ''), {'slide': page_index + 1, 'shape': shape_index + 1}))
            text_boxes.append({'shape': shape_index + 1, 'text': value[:80], 'x': x, 'y': y, 'width': width, 'height': height})
        for left_index in range(len(text_boxes)):
            left = text_boxes[left_index]
            for right in text_boxes[left_index + 1:]:
                overlap_width = max(0, min(left['x'] + left['width'], right['x'] + right['width']) - max(left['x'], right['x']))
                overlap_height = max(0, min(left['y'] + left['height'], right['y'] + right['height']) - max(left['y'], right['y']))
                overlap_area = overlap_width * overlap_height
                smaller_area = min(left['width'] * left['height'], right['width'] * right['height'])
                if smaller_area > 0 and overlap_area / smaller_area >= 0.75:
                    issue = {
                        'severity': 'error', 'type': 'text_overlap', 'page': page_index + 1,
                        'shapes': [left['shape'], right['shape']],
                        'description': f'High-confidence text-box overlap between shapes {left["shape"]} and {right["shape"]}.',
                    }
                    issue['elementIds'] = [item.get('elementId') for item in [
                        next((entry for entry in (element_map or []) if entry.get('locator', {}).get('slide') == page_index + 1 and entry.get('locator', {}).get('shape') == left['shape']), {}),
                        next((entry for entry in (element_map or []) if entry.get('locator', {}).get('slide') == page_index + 1 and entry.get('locator', {}).get('shape') == right['shape']), {}),
                    ] if item.get('elementId')]
                    issues.append(issue)
    return {'checkedTextShapes': checked_text_shapes, 'issues': issues, 'passed': not any(item['severity'] == 'error' for item in issues)}


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
        for row in range(min(used_rows, 500)):
            for column in range(min(used_columns, 100)):
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--program')
    parser.add_argument('--output')
    parser.add_argument('--preview')
    parser.add_argument('--assets')
    parser.add_argument('--expected-source-digest')
    parser.add_argument('--required-source-asset')
    parser.add_argument('--inspect-target', choices=('all', 'document', 'page', 'text', 'cursor', 'sheet', 'cell', 'shape', 'table', 'table-column', 'table-row', 'chart', 'chart-data'))
    parser.add_argument('--api-query', default='')
    parser.add_argument('--api-offset', type=int, default=0)
    parser.add_argument('--api-limit', type=int, default=120)
    parser.add_argument('--document-type', required=True, choices=('word', 'spreadsheet', 'presentation'))
    parser.add_argument('--profile', required=True)
    parser.add_argument('--soffice', required=True)
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
        process, context, desktop = connect_office(soffice, profile)
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
                raise RuntimeError(
                    f'UNO draft attempted an unavailable member: {error}. '
                    'Call file action=unoApi for the relevant target, copy the matching returned cookbook operation, '
                    'and edit the current draft.py with that installed-runtime pattern.'
                ) from error
        if args.required_source_asset and args.required_source_asset not in job.opened_documents:
            raise RuntimeError(
                f'Existing-file modification must open {args.required_source_asset!r} through source_name on a stable facade or expert.open_document(...). '
                'Creating a replacement document is not allowed for this plan.'
            )
        if not output.is_file() or output.stat().st_size < 64:
            raise RuntimeError('create_document(job) did not create the requested output file')
        emit_progress('reopen', '文档已保存，正在重新打开验证')
    finally:
        shutdown_office(process, desktop)
    source = (assets / args.required_source_asset).resolve() if args.required_source_asset else None
    verification = verify_and_preview(
        soffice, profile.parent / 'verification-profile', output, preview, args.document_type, source, job.element_map()
    )
    emit_progress('visual', '结构验证完成，预览已生成')
    print(json.dumps({
        'bytes': output.stat().st_size, 'output': str(output), 'preview': str(preview),
        'renderer': 'libreoffice-uno', 'verification': verification, 'elementMap': job.element_map(),
        'staticDiagnostics': namespace.get('__webpilot_static_diagnostics__', []),
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
