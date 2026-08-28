import uno


def _point(x, y):
    value = uno.createUnoStruct('com.sun.star.awt.Point')
    value.X, value.Y = int(x), int(y)
    return value


def _size(width, height):
    value = uno.createUnoStruct('com.sun.star.awt.Size')
    value.Width, value.Height = int(width), int(height)
    return value


def _expert_text(expert, document, page, element_id, text, x, y, width, height, font_size=18):
    shape = document.createInstance('com.sun.star.drawing.TextShape')
    shape.Position, shape.Size = _point(x, y), _size(width, height)
    page.add(shape)
    shape.String = text
    cursor = shape.Text.createTextCursor()
    cursor.gotoEnd(True)
    cursor.CharHeight = float(font_size)
    expert.tag(shape, element_id, 'text', {'role': 'expert-text'})
    return shape


def create_document(job):
    expert = job.expert('Stress coverage requires charts, tables, notes, hyperlinks, and advanced drawing properties.')
    document = expert.new_document('presentation')
    deck = job.presentation('deck', component=document)
    bounds = job.document_bounds(document)
    slide_width, slide_height = bounds['width'], bounds['height']

    # @webpilot-unit pages/slide-01
    page = deck.add_slide('slide-01')
    deck.add_shape('slide-01/background', page, 0, 0, slide_width, slide_height)
    background = page.getByIndex(0)
    background.FillStyle = uno.Enum('com.sun.star.drawing.FillStyle', 'SOLID')
    background.FillColor = 0x0B2545
    background.LineStyle = uno.Enum('com.sun.star.drawing.LineStyle', 'NONE')
    title = deck.add_text('slide-01/title', page, 'UNO Office 全面压力验证', 1700, 2500, 24500, 3300, font_size=30, color=0xFFFFFF)
    title.CharWeight = 150.0
    deck.add_text('slide-01/subtitle', page, '文本 · 表格 · 图表 · 图片 · 形状 · 超链接 · 备注', 1700, 6300, 24500, 1800, font_size=17, color=0xB8D8F0)
    deck.add_text('slide-01/footer', page, 'LibreOffice UNO → PPTX → LibreOffice / Microsoft Office', 1700, 13200, 24500, 1000, font_size=11, color=0xD7E8F5)
    # @webpilot-endunit

    # @webpilot-unit pages/slide-02
    page = deck.add_slide('slide-02')
    deck.add_text('slide-02/title', page, '多语言文本与富文本属性必须稳定', 1500, 700, 25000, 1800, font_size=25, color=0x0B2545)
    rich = _expert_text(expert, document, page, 'slide-02/rich-text', '中文 English العربية Русский\n粗体 · 斜体 · 下划线 · 字距', 1700, 3300, 23800, 4200, 22)
    cursor = rich.Text.createTextCursor()
    cursor.gotoStart(False)
    cursor.goRight(2, True)
    cursor.CharWeight = 150.0
    cursor.gotoEnd(True)
    cursor.CharColor = 0x2563EB
    rich.TextFitToSize = uno.Enum('com.sun.star.drawing.TextFitToSizeType', 'NONE')
    link = _expert_text(expert, document, page, 'slide-02/hyperlink', 'https://example.com/uno-validation', 1700, 9000, 15000, 1300, 15)
    link_cursor = link.Text.createTextCursor()
    link_cursor.gotoEnd(True)
    link_cursor.CharColor = 0x1565C0
    link_cursor.CharUnderline = 1
    link.OnClick = uno.Enum('com.sun.star.presentation.ClickAction', 'DOCUMENT')
    link.Bookmark = 'https://example.com/uno-validation'
    # @webpilot-endunit

    # @webpilot-unit pages/slide-03
    page = deck.add_slide('slide-03')
    deck.add_text('slide-03/title', page, '形状、透明度、旋转和连接线不能越界', 1500, 700, 25000, 1800, font_size=25, color=0x0B2545)
    rectangle = deck.add_shape('slide-03/rectangle', page, 2200, 3600, 6500, 4400)
    rectangle.FillStyle = uno.Enum('com.sun.star.drawing.FillStyle', 'SOLID')
    rectangle.FillColor = 0x2563EB
    rectangle.FillTransparence = 18
    rectangle.LineColor = 0x163B73
    rectangle.RotateAngle = 700
    ellipse = deck.add_shape('slide-03/ellipse', page, 10700, 3600, 5200, 5200, service='com.sun.star.drawing.EllipseShape')
    ellipse.FillStyle = uno.Enum('com.sun.star.drawing.FillStyle', 'SOLID')
    ellipse.FillColor = 0x10B981
    ellipse.LineStyle = uno.Enum('com.sun.star.drawing.LineStyle', 'NONE')
    line = deck.add_shape('slide-03/connector', page, 7800, 5200, 4300, 900, service='com.sun.star.drawing.LineShape')
    line.LineColor = 0xF59E0B
    line.LineWidth = 120
    _expert_text(expert, document, page, 'slide-03/callout', '旋转 7°', 2300, 8500, 6200, 1200, 15)
    _expert_text(expert, document, page, 'slide-03/ellipse-label', '圆形', 11300, 9000, 4000, 1200, 15)
    # @webpilot-endunit

    # @webpilot-unit pages/slide-04
    page = deck.add_slide('slide-04')
    deck.add_text('slide-04/title', page, '图片在两种缩放比例下保持清晰', 1500, 700, 25000, 1800, font_size=25, color=0x0B2545)
    deck.add_image('slide-04/image-wide', page, 'attachment-stress-image-office-image-fixture.png', 1600, 3100, 15800, 9000)
    deck.add_image('slide-04/image-thumb', page, 'attachment-stress-image-office-image-fixture.png', 19400, 4700, 6500, 4300)
    deck.add_text('slide-04/caption', page, '同一素材用于验证大图、缩略图和 PPTX 媒体关系。', 1600, 12800, 24000, 1100, font_size=14, color=0x334155)
    # @webpilot-endunit

    # @webpilot-unit pages/slide-05
    page = deck.add_slide('slide-05')
    deck.add_text('slide-05/title', page, '原生表格必须可以编辑并完整序列化', 1500, 700, 25000, 1800, font_size=25, color=0x0B2545)
    table_shape = document.createInstance('com.sun.star.drawing.TableShape')
    table_shape.Position, table_shape.Size = _point(2200, 3500), _size(23500, 7200)
    page.add(table_shape)
    table = table_shape.Model
    values = [
        ['维度', 'LibreOffice', 'Microsoft Office'],
        ['结构', 'OOXML 重开', 'COM 重开'],
        ['版式', 'PDF 渲染', 'PDF 渲染'],
        ['结论', '必须通过', '必须通过'],
    ]
    desired_rows, desired_columns = len(values), len(values[0])
    if table.Rows.Count < desired_rows:
        table.Rows.insertByIndex(table.Rows.Count, desired_rows - table.Rows.Count)
    if table.Columns.Count < desired_columns:
        table.Columns.insertByIndex(table.Columns.Count, desired_columns - table.Columns.Count)
    column_width = int(table_shape.Size.Width / desired_columns)
    row_height = int(table_shape.Size.Height / desired_rows)
    for column_index in range(desired_columns):
        table.Columns.getByIndex(column_index).Width = column_width
    for row_index in range(desired_rows):
        table.Rows.getByIndex(row_index).Height = row_height
    for row_index, row_values in enumerate(values):
        for column_index, value in enumerate(row_values):
            cell = table.getCellByPosition(column_index, row_index)
            cell.String = value
            cell_cursor = cell.createTextCursor()
            cell_cursor.gotoEnd(True)
            cell_cursor.CharHeight = 14
            if row_index == 0:
                cell_cursor.CharWeight = 150.0
                cell.FillColor = 0xDCEAF7
    expert.tag(table_shape, 'slide-05/table', 'table', {'slide': 5})
    # @webpilot-endunit

    # @webpilot-unit pages/slide-06
    page = deck.add_slide('slide-06')
    deck.add_text('slide-06/title', page, '原生图表对象验证嵌入关系和跨渲染器兼容性', 1500, 700, 25000, 1800, font_size=25, color=0x0B2545)
    chart = document.createInstance('com.sun.star.drawing.OLE2Shape')
    chart.CLSID = '12DCAE26-281F-416F-A234-C3086127382E'
    chart.Position, chart.Size = _point(2700, 3300), _size(22500, 9000)
    page.add(chart)
    expert.tag(chart, 'slide-06/chart', 'chart', {'slide': 6})
    chart.Model.createDefaultChart()
    chart_data = chart.Model.Data
    chart_data.setData(((18.0, 24.0, 31.0), (14.0, 22.0, 29.0)))
    chart_data.setRowDescriptions(('2025', '2026'))
    chart_data.setColumnDescriptions(('Q1', 'Q2', 'Q3'))
    deck.add_text('slide-06/caption', page, '默认 Chart2 数据用于验证可编辑图表对象，而不是位图替代。', 2700, 12900, 22000, 1000, font_size=13, color=0x475569)
    # @webpilot-endunit

    # @webpilot-unit pages/slide-07
    page = deck.add_slide('slide-07')
    deck.add_text('slide-07/title', page, '演讲者备注必须保留', 1500, 700, 25000, 1800, font_size=25, color=0x0B2545)
    deck.add_text('slide-07/body', page, '此页包含 Notes Page 文本，用于验证备注关系和序列化。', 2200, 4500, 22000, 2600, font_size=22, color=0x334155)
    notes_page = page.getNotesPage()
    notes = document.createInstance('com.sun.star.drawing.TextShape')
    notes.Position, notes.Size = _point(1200, 1200), _size(18000, 3500)
    notes_page.add(notes)
    notes.String = 'Speaker notes: explain the deterministic validation sequence and known limitations.'
    expert.tag(notes, 'slide-07/notes', 'speaker-notes', {'slide': 7})
    # @webpilot-endunit

    # @webpilot-unit pages/slide-08
    page = deck.add_slide('slide-08')
    deck.add_text('slide-08/title', page, '验证结论必须来自结构、渲染和逐页视觉检查', 1500, 900, 25000, 2200, font_size=25, color=0x0B2545)
    deck.add_text('slide-08/body', page, '结构通过 ≠ 版式正确\nLibreOffice 通过 ≠ Microsoft Office 一致\n视觉通过 ≠ 所有交互对象语义完整', 2500, 4200, 22500, 6000, font_size=22, color=0x1F2937)
    # @webpilot-endunit

    deck.save()
    deck.close()