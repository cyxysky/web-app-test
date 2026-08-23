from __future__ import annotations

import argparse
import ast
import contextlib
import hashlib
import json
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
    pipe_name = f'webpilot_{uuid.uuid4().hex}'
    accept = f'pipe,name={pipe_name};urp;StarOffice.ComponentContext'
    process = subprocess.Popen([
        str(soffice), '--headless', '--nologo', '--nodefault', '--nofirststartwizard', '--norestore', '--nolockcheck',
        f'-env:UserInstallation={profile.as_uri()}', f'--accept={accept}',
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    local = uno.getComponentContext()
    resolver = local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver', local)
    deadline, last_error = time.monotonic() + 20, None
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
    except Exception:
        pass
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
    opened_documents: set = field(default_factory=set, compare=False)

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

    def new_document(self, kind=None):
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

    def open_document(self, name: str):
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

    def close(self, component):
        close_component(component)


def validate_program(source: str):
    tree = ast.parse(source, filename='draft.py', mode='exec')
    entrypoints = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == 'create_document']
    if len(entrypoints) != 1 or len(entrypoints[0].args.args) != 1:
        raise ValueError('Draft must define exactly one synchronous create_document(job) function')
    if isinstance(entrypoints[0], ast.AsyncFunctionDef):
        raise ValueError('create_document(job) must be synchronous')


def program_namespace(program_path: Path):
    source = program_path.read_text(encoding='utf-8')
    validate_program(source)
    namespace = {'__name__': '__webpilot_document_draft__', '__file__': str(program_path), 'uno': uno}
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
    raise ValueError(f'target={target} is not valid for documentType={document_type}')


def targets_for_document_type(document_type):
    return {
        'word': ('document', 'text'),
        'spreadsheet': ('document', 'sheet', 'cell'),
        'presentation': ('document', 'page', 'shape'),
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
        'ControlCharacter has paragraph/line characters but no PAGE_BREAK member. Writer page breaks use the paragraph BreakType enum.',
        'For Impress TextShape objects, assign Position and Size, call page.add(shape), and only then assign String/Text and text formatting. Text written before page.add(shape) is lost by this LibreOffice runtime.',
        'For an existing-file modification plan, call job.open_document(exactSourceAssetName), mutate that returned component, and store it to job.output_url. Never replace it with job.new_document().',
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
            'openExisting': '''doc = job.open_document('exact-source-asset-name.docx')
# Modify this component and save to job.output_url; do not create a replacement document.''',
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
        complete = '''import uno

def save_document(doc, job):
    suffix = job.output_path.suffix.lower()
    filters = {'.doc': 'MS Word 97', '.docx': 'Office Open XML Text', '.odt': 'writer8', '.pdf': 'writer_pdf_Export'}
    properties = (job.property('FilterName', filters[suffix]), job.property('Overwrite', True))
    (doc.storeToURL if suffix == '.pdf' else doc.storeAsURL)(job.output_url, properties)

def create_document(job):
    doc = job.new_document('writer')
    text = doc.Text
    page_styles = doc.StyleFamilies.getByName('PageStyles')
    page_style = page_styles.getByName(page_styles.getElementNames()[0])
    page_style.Width, page_style.Height = 21000, 29700
    page_style.LeftMargin = page_style.RightMargin = 2000
    page_style.HeaderIsOn, page_style.FooterIsOn = True, True
    page_style.HeaderText.String = 'UNO Writer report'
    page_style.FooterText.String = 'Generated with verified UNO patterns'
    bounds = job.document_bounds(doc)
    paragraph_break = uno.getConstantByName('com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK')

    cursor = text.createTextCursor(); cursor.gotoEnd(False)
    cursor.CharHeight, cursor.CharWeight = 20, 150.0
    text.insertString(cursor, 'UNO Writer report', False)
    text.insertControlCharacter(cursor, paragraph_break, False)

    cursor = text.createTextCursor(); cursor.gotoEnd(False)
    cursor.CharHeight = 11
    text.insertString(cursor, 'Usable width: %s (1/100 mm)' % bounds['contentWidth'], False)
    text.insertControlCharacter(cursor, paragraph_break, False)

    cursor = text.createTextCursor(); cursor.gotoEnd(False)
    cursor.BreakType = uno.Enum('com.sun.star.style.BreakType', 'PAGE_BEFORE')
    text.insertControlCharacter(cursor, paragraph_break, False)

    table = doc.createInstance('com.sun.star.text.TextTable')
    table.initialize(2, 2)
    cursor = text.createTextCursor(); cursor.gotoEnd(False)
    text.insertTextContent(cursor, table, False)
    table.RelativeWidth = 100
    separators = list(table.TableColumnSeparators)
    separators[0].Position = int(table.TableColumnRelativeSum * 0.35)
    table.TableColumnSeparators = tuple(separators)
    table.getCellByName('A1').String, table.getCellByName('B1').String = 'Field', 'Value'
    table.getCellByName('A2').String, table.getCellByName('B2').String = 'Status', 'Verified pattern'

    save_document(doc, job)
    job.close(doc)'''
        coverage = ['create/save DOC/DOCX/ODT/PDF', 'native page bounds', 'append-at-end cursors', 'paragraph and line spacing', 'page breaks', 'images and anchors', 'relative table widths', 'page style and header']
    elif document_type == 'spreadsheet':
        operations = {
            'openExisting': '''doc = job.open_document('exact-source-asset-name.xlsx')
# Modify this component and save to job.output_url; do not create a replacement workbook.''',
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
        complete = '''def save_document(doc, job):
    suffix = job.output_path.suffix.lower()
    filters = {'.xls': 'MS Excel 97', '.xlsx': 'Calc MS Excel 2007 XML', '.ods': 'calc8', '.pdf': 'calc_pdf_Export'}
    properties = (job.property('FilterName', filters[suffix]), job.property('Overwrite', True))
    (doc.storeToURL if suffix == '.pdf' else doc.storeAsURL)(job.output_url, properties)

def create_document(job):
    doc = job.new_document('calc')
    sheet = doc.Sheets.getByIndex(0)
    sheet.Name = 'Summary'
    sheet.getCellByPosition(0, 0).String = 'Item'
    sheet.getCellByPosition(1, 0).String = 'Amount'
    sheet.getCellByPosition(0, 1).String = 'Revenue'
    sheet.getCellByPosition(1, 1).Value = 1200.5
    sheet.getCellByPosition(1, 2).Formula = '=B2*1.2'
    sheet.getCellRangeByName('A1:B1').CharWeight = 150.0
    sheet.Columns.getByIndex(0).Width = 4200
    sheet.Columns.getByIndex(1).Width = 3000
    save_document(doc, job)
    job.close(doc)'''
        coverage = ['create/save XLS/XLSX/ODS/PDF', 'strings, numbers, and formulas', 'cell formatting', 'row/column sizing', 'merged cells and freeze panes', 'images on draw page', 'multiple sheets']
    else:
        operations = {
            'openExisting': '''doc = job.open_document('exact-source-asset-name.pptx')
# Modify this component and save to job.output_url; preserve all existing pages, images, and unrelated shapes.''',
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
        complete = '''import uno

def point(x, y):
    value = uno.createUnoStruct('com.sun.star.awt.Point'); value.X, value.Y = x, y
    return value

def size(width, height):
    value = uno.createUnoStruct('com.sun.star.awt.Size'); value.Width, value.Height = width, height
    return value

def save_document(doc, job):
    suffix = job.output_path.suffix.lower()
    filters = {'.ppt': 'MS PowerPoint 97', '.pptx': 'Impress MS PowerPoint 2007 XML', '.odp': 'impress8', '.pdf': 'impress_pdf_Export'}
    properties = (job.property('FilterName', filters[suffix]), job.property('Overwrite', True))
    (doc.storeToURL if suffix == '.pdf' else doc.storeAsURL)(job.output_url, properties)

def create_document(job):
    doc = job.new_document('impress')
    page = doc.DrawPages.getByIndex(0)
    bounds = job.document_bounds(doc)
    shape = doc.createInstance('com.sun.star.drawing.TextShape')
    shape.Position, shape.Size = point(1600, 1200), size(bounds['width'] - 3200, 3200)
    page.add(shape)
    shape.String = 'UNO Impress deck'
    shape.TextFitToSize = uno.Enum('com.sun.star.drawing.TextFitToSizeType', 'NONE')
    shape.CharHeight, shape.CharWeight = 28, 150.0
    save_document(doc, job)
    job.close(doc)'''
        coverage = ['create/save PPT/PPTX/ODP/PDF', 'native slide bounds', 'text shapes with fixed point-size formatting', 'graphic shapes', 'filled shapes', 'new slides', 'explicit in-slide geometry']
    modification = save_examples[document_type] + '''

def create_document(job):
    # Replace this placeholder with sourceDocument.assetName returned by action=plan.
    doc = job.open_document('exact-source-asset-name')
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
                    'rule': 'Call job.document_bounds(doc) only after job.new_document(...), then use exactly the keys for documentType above.',
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


def verify_and_preview(soffice, profile, output, preview, document_type, source=None):
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
        image_verification = verify_embedded_images(component, document_type)
        text_verification = verify_presentation_text(component) if document_type == 'presentation' else None
        layout_verification = verify_presentation_layout(component) if document_type == 'presentation' else None
        spreadsheet_verification = verify_spreadsheet_content(component) if document_type == 'spreadsheet' else None
        word_verification = verify_word_content(component, image_verification) if document_type == 'word' else None
        component.storeToURL(preview.as_uri(), (property_value('FilterName', PDF_FILTERS[document_type]), property_value('Overwrite', True)))
        if not preview.is_file() or preview.stat().st_size < 64:
            raise RuntimeError('LibreOffice could not export a PDF preview')
        if document_type == 'presentation':
            return {'format': 'presentation', 'pages': component.DrawPages.Count, 'images': image_verification, 'text': text_verification, 'layout': layout_verification, 'fidelity': fidelity}
        if document_type == 'spreadsheet':
            return {'format': 'spreadsheet', 'sheets': list(component.Sheets.getElementNames()), 'content': spreadsheet_verification, 'fidelity': fidelity}
        return {'format': 'word', 'textCharacters': len(str(component.Text.String or '')), 'images': image_verification, 'content': word_verification, 'fidelity': fidelity}
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


def verify_presentation_layout(component):
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
                issues.append({
                    'severity': 'error', 'type': 'text_out_of_bounds', 'page': page_index + 1,
                    'shape': shape_index + 1,
                    'description': f'Text box is outside slide bounds: x={x}, y={y}, width={width}, height={height}, slideWidth={page_width}, slideHeight={page_height}.',
                })
            text_boxes.append({'shape': shape_index + 1, 'text': value[:80], 'x': x, 'y': y, 'width': width, 'height': height})
        for left_index in range(len(text_boxes)):
            left = text_boxes[left_index]
            for right in text_boxes[left_index + 1:]:
                overlap_width = max(0, min(left['x'] + left['width'], right['x'] + right['width']) - max(left['x'], right['x']))
                overlap_height = max(0, min(left['y'] + left['height'], right['y'] + right['height']) - max(left['y'], right['y']))
                overlap_area = overlap_width * overlap_height
                smaller_area = min(left['width'] * left['height'], right['width'] * right['height'])
                if smaller_area > 0 and overlap_area / smaller_area >= 0.75:
                    issues.append({
                        'severity': 'error', 'type': 'text_overlap', 'page': page_index + 1,
                        'shapes': [left['shape'], right['shape']],
                        'description': f'High-confidence text-box overlap between shapes {left["shape"]} and {right["shape"]}.',
                    })
    errors = [issue for issue in issues if issue['severity'] == 'error']
    if errors:
        summary = '; '.join(f'page {item["page"]}: {item["type"]} - {item["description"]}' for item in errors[:8])
        raise RuntimeError(f'Presentation layout verification failed: {summary}')
    return {'checkedTextShapes': checked_text_shapes, 'issues': issues}


def verify_word_content(component, image_verification):
    text = str(component.Text.String or '').strip()
    image_count = int((image_verification or {}).get('checked', 0))
    try:
        drawing_count = int(component.DrawPage.getCount())
    except Exception:
        drawing_count = 0
    if not text and image_count == 0 and drawing_count == 0:
        raise RuntimeError('Writer content verification failed: the generated document has no readable text or images.')
    return {'textCharacters': len(text), 'images': image_count, 'drawingObjects': drawing_count}


def verify_spreadsheet_content(component):
    sheets = component.Sheets
    if sheets.Count < 1:
        raise RuntimeError('Spreadsheet content verification failed: the workbook has no sheets.')
    summaries, formula_errors = [], []
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
        raise RuntimeError('Spreadsheet content verification failed: every sheet is empty.')
    if formula_errors:
        sample = ', '.join(f'{item["sheet"]}!R{item["row"]}C{item["column"]}:{item["error"]}' for item in formula_errors[:10])
        raise RuntimeError(f'Spreadsheet formula verification failed: {len(formula_errors)} formula errors detected ({sample}).')
    return {'sheets': summaries, 'formulaErrors': 0}


def verify_embedded_images(component, document_type):
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
                if width <= 0 or height <= 0 or width > content_width or height > content_height:
                    raise RuntimeError(
                        f'Image verification failed: Writer image {index + 1} exceeds printable page bounds '
                        f'(width={width}, height={height}, contentWidth={content_width}, contentHeight={content_height}). '
                        'Edit the current draft image size using job.document_bounds(doc).'
                    )
        except AttributeError:
            # This LibreOffice build does not expose a Writer graphic collection.
            pass
        return {'checked': checked}
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
    parser.add_argument('--inspect-target', choices=('all', 'document', 'page', 'text', 'sheet', 'cell', 'shape'))
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
        job = DocumentJob(output, assets, args.document_type, context, desktop)
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
                f'Existing-file modification must call job.open_document({args.required_source_asset!r}). '
                'Creating a replacement document with job.new_document() is not allowed for this plan.'
            )
        if not output.is_file() or output.stat().st_size < 64:
            raise RuntimeError('create_document(job) did not create the requested output file')
        emit_progress('reopen', '文档已保存，正在重新打开验证')
    finally:
        shutdown_office(process, desktop)
    source = (assets / args.required_source_asset).resolve() if args.required_source_asset else None
    verification = verify_and_preview(soffice, profile.parent / 'verification-profile', output, preview, args.document_type, source)
    emit_progress('visual', '结构验证完成，预览已生成')
    print(json.dumps({'bytes': output.stat().st_size, 'output': str(output), 'preview': str(preview), 'renderer': 'libreoffice-uno', 'verification': verification}, ensure_ascii=False))


if __name__ == '__main__':
    main()
