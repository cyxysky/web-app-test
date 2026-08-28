import uno


def _append_rich_paragraph(expert, document):
    text = document.Text
    cursor = text.createTextCursor()
    cursor.gotoEnd(False)
    bookmark = document.createInstance('com.sun.star.text.Bookmark')
    expert.tag(bookmark, 'section-02/rich-text', 'paragraph-marker', {'section': 2})
    text.insertTextContent(cursor, bookmark, False)
    cursor.CharHeight = 12
    cursor.CharWeight = 150.0
    text.insertString(cursor, '粗体 Bold  ', False)
    cursor.CharWeight = 100.0
    cursor.CharPosture = uno.Enum('com.sun.star.awt.FontSlant', 'ITALIC')
    cursor.CharColor = 0x2563EB
    text.insertString(cursor, '斜体 Italic  ', False)
    cursor.CharPosture = uno.Enum('com.sun.star.awt.FontSlant', 'NONE')
    cursor.CharUnderline = 1
    cursor.HyperLinkURL = 'https://example.com/uno-validation'
    text.insertString(cursor, '可点击超链接', False)
    cursor.HyperLinkURL = ''
    cursor.CharUnderline = 0
    text.insertControlCharacter(cursor, uno.getConstantByName('com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK'), False)


def _append_footnote_and_annotation(expert, document):
    text = document.Text
    cursor = text.createTextCursor()
    cursor.gotoEnd(False)
    text.insertString(cursor, '脚注与批注锚点', False)
    footnote_marker = document.createInstance('com.sun.star.text.Bookmark')
    expert.tag(footnote_marker, 'section-05/footnote-marker', 'footnote-marker', {'section': 5})
    text.insertTextContent(cursor, footnote_marker, False)
    footnote = document.createInstance('com.sun.star.text.Footnote')
    text.insertTextContent(cursor, footnote, False)
    footnote.Label = '1'
    footnote.Text.String = '这是通过原生 UNO 创建的脚注内容。'
    text.insertString(cursor, '，后面继续正文。', False)
    annotation_marker = document.createInstance('com.sun.star.text.Bookmark')
    expert.tag(annotation_marker, 'section-05/annotation-marker', 'annotation-marker', {'section': 5})
    text.insertTextContent(cursor, annotation_marker, False)
    annotation = document.createInstance('com.sun.star.text.TextField.Annotation')
    annotation.Author = 'WebPilot UNO validation'
    annotation.Content = '批注结构测试：此对象通常不会出现在 PDF 中。'
    text.insertTextContent(cursor, annotation, False)
    text.insertControlCharacter(cursor, uno.getConstantByName('com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK'), False)


def create_document(job):
    expert = job.expert('Stress coverage requires rich text, hyperlinks, footnotes, annotations, frames, and drawing objects.')
    document = expert.new_document('writer')
    layout = job.writer('document', component=document)
    layout.set_page('page-style', width=21590, height=27940, margins=(2540, 2540, 2200, 2200))
    layout.set_header_footer(
        header='UNO Writer 全面压力验证',
        footer='结构 + 双渲染器 + 逐页视觉检查',
        header_element_id='header',
        footer_element_id='footer',
    )

    # @webpilot-unit pages/page-01
    layout.add_heading('cover/title', 'UNO Writer 全面压力验证', level=1, color=0x0B2545, align='CENTER')
    layout.add_paragraph('cover/subtitle', '覆盖常见正文、复杂对象和高风险版式边界', font_size=14, color=0x475569, align='CENTER', space_after=420)
    layout.add_paragraph('cover/meta', 'DOCX · LibreOffice Writer · Microsoft Word · 2026-08-28', font_size=10, color=0x64748B, align='CENTER')
    layout.add_page_break('page-break-02')
    # @webpilot-endunit

    # @webpilot-unit pages/page-02
    layout.add_heading('section-01/title', '1. 标题、正文、段落间距与多语言', level=1, color=0x0B2545)
    layout.add_paragraph('section-01/body', '这是一段用于验证自动换行、行距和分页的正文。English text verifies Latin metrics; العربية and Русский verify mixed-script fallback. Emoji: ✓ ★ ⚠.', font_size=11, line_spacing=1.25, space_after=180)
    layout.add_heading('section-01/h2', '1.1 二级标题', level=2, color=0x2563EB)
    layout.add_paragraph('section-01/long-body', '长段落用于观察边界处的换行行为。' * 16, font_size=10.5, line_spacing=1.3, space_after=220)
    layout.add_heading('section-02/title', '2. 富文本与超链接', level=1, color=0x0B2545)
    _append_rich_paragraph(expert, document)
    layout.add_heading('section-03/title', '3. 项目符号与层级', level=1, color=0x0B2545)
    layout.add_bullets('section-03/bullets', ['第一项：短文本', '第二项：这是一条会自动换行的较长项目符号，用于检查第二行是否与正文文本对齐。', '第三项：中文与 English 混排'], level=0, font_size=11)
    layout.add_bullets('section-03/nested', ['嵌套项目 A', '嵌套项目 B'], level=1, font_size=10.5)
    # @webpilot-endunit

    # @webpilot-unit pages/page-03
    layout.add_page_break('page-break-03')
    layout.add_heading('section-04/title', '4. 表格、列宽、换行与跨页', level=1, color=0x0B2545)
    rows = [['编号', '项目', '状态', '说明']]
    for index in range(1, 16):
        rows.append([str(index), '验证项 ' + str(index), '通过' if index % 3 else '关注', '用于验证可变行高、长文本自动换行以及表格接近分页边界时的行为。' if index % 2 else '短说明'])
    layout.add_table('section-04/table', rows, column_widths=[10, 22, 14, 54], header=True, font_size=9)
    layout.add_paragraph('section-04/caption', '表 1：15 行安全余量表格。跨页临界差异由双渲染闸门另行检测。', font_size=9, italic=True, color=0x64748B, space_before=160, space_after=220)
    # @webpilot-endunit

    # @webpilot-unit pages/page-04
    layout.add_page_break('page-break-04')
    layout.add_heading('section-05/title', '5. 图片、脚注和批注', level=1, color=0x0B2545)
    layout.add_inline_image('section-05/image', 'attachment-stress-image-office-image-fixture.png', width=12500)
    layout.add_paragraph('section-05/image-caption', '图 1：用于验证内联图片、比例和分页。', font_size=9, italic=True, color=0x64748B, align='CENTER', space_after=260)
    _append_footnote_and_annotation(expert, document)
    # @webpilot-endunit

    # @webpilot-unit pages/page-05
    layout.add_page_break('page-break-05')
    layout.add_heading('section-06/title', '6. 浮动文本框与绘图对象', level=1, color=0x0B2545)
    layout.add_paragraph('section-06/intro', '以下对象位于独立页面，避免与流式正文发生非预期重叠。', font_size=11, space_after=300)
    cursor = document.Text.createTextCursor()
    cursor.gotoEnd(False)
    frame = document.createInstance('com.sun.star.text.TextFrame')
    frame.Width, frame.Height = 7200, 3200
    frame.AnchorType = uno.Enum('com.sun.star.text.TextContentAnchorType', 'AS_CHARACTER')
    document.Text.insertTextContent(cursor, frame, False)
    frame.Text.String = '原生 UNO TextFrame\n用于验证文本框内部换行。'
    expert.tag(frame, 'section-06/text-frame', 'text-frame', {'section': 6})
    document.Text.insertControlCharacter(cursor, uno.getConstantByName('com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK'), False)
    draw_page = document.DrawPage
    shape = document.createInstance('com.sun.star.drawing.RectangleShape')
    position = uno.createUnoStruct('com.sun.star.awt.Point')
    position.X, position.Y = 12500, 9000
    shape_size = uno.createUnoStruct('com.sun.star.awt.Size')
    shape_size.Width, shape_size.Height = 5000, 2600
    shape.Position, shape.Size = position, shape_size
    shape.AnchorType = uno.Enum('com.sun.star.text.TextContentAnchorType', 'AT_PAGE')
    shape.AnchorPageNo = 6
    shape.FillStyle = uno.Enum('com.sun.star.drawing.FillStyle', 'SOLID')
    shape.FillColor = 0xDCEAF7
    shape.LineColor = 0x2563EB
    draw_page.add(shape)
    expert.tag(shape, 'section-06/drawing-shape', 'shape', {'section': 6})
    layout.add_paragraph('section-06/outro', '绘图对象应保持在页面可用区域内，并且不遮挡上方文本框。', font_size=11, space_before=3200, space_after=180)
    # @webpilot-endunit

    # @webpilot-unit pages/page-06
    layout.add_page_break('page-break-06')
    layout.add_heading('section-07/title', '7. 最终检查清单', level=1, color=0x0B2545)
    layout.add_table('section-07/checklist', [
        ['检查项', '期望结果'],
        ['字符', '无乱码、无缺字'],
        ['版式', '无重叠、无裁切、无异常空白页'],
        ['表格', '完整、可编辑、换行自然'],
        ['对象', '图片、脚注、批注、文本框和形状保留'],
        ['渲染', 'LibreOffice 与 Microsoft Office 页数一致'],
    ], column_widths=[28, 72], header=True, font_size=10)
    layout.add_paragraph('section-07/conclusion', '结构检查只能证明文件包可读；最终结论仍然依赖双渲染器和逐页视觉检查。', font_size=11, bold=True, color=0x0B2545, space_before=260, space_after=180)
    # @webpilot-endunit

    layout.save()
    layout.close()