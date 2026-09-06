const { parentPort } = require('node:worker_threads');
  const { readFile } = require('node:fs/promises');
  const { createHash } = require('node:crypto');
  const documents = new Map();

  function decodeXml(value) {
    return value.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  }
  function officeXmlText(value) {
    return decodeXml(value.replace(/<a:br\s*\/>/g, '\n').replace(/<a:p[^>]*>/g, '')
      .replace(/<\/a:p>/g, '\n').replace(/<text:line-break\s*\/>/g, '\n')
      .replace(/<text:p[^>]*>/g, '').replace(/<\/text:p>/g, '\n'))
      .replace(/\n{3,}/g, '\n\n').trim();
  }
  async function zipFrom(buffer) {
    const imported = await import('jszip');
    const JSZip = imported.default || imported;
    return JSZip.loadAsync(buffer);
  }
  function binaryOfficeText(buffer) {
    const CFB = require('cfb');
    const container = CFB.read(buffer, { type: 'buffer' });
    return container.FileIndex.filter((entry) => entry.content && entry.content.length)
      .map((entry) => Buffer.from(entry.content))
      .flatMap((content) => [content.toString('utf16le'), content.toString('latin1')])
      .flatMap((value) => value.match(/[\p{L}\p{N}][\p{L}\p{N}\p{P}\p{Z}\r\n\t]{2,}/gu) || [])
      .map((value) => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]+/g, ' ').replace(/\s+/g, ' ').trim())
      .filter((value) => value.length >= 3).filter((value, index, values) => values.indexOf(value) === index)
      .slice(0, 10000).join('\n').trim();
  }
  async function extract(job) {
    const buffer = await readFile(job.path);
    if (createHash('sha256').update(buffer).digest('hex') !== job.digest) throw new Error('File changed during extraction. Read the current revision again.');
    if ((job.sheet || job.range) && job.kind !== 'spreadsheet') throw new Error('sheet/range are supported only for spreadsheets.');
    if (job.contentPages?.length && job.kind !== 'pdf') throw new Error('contentPages are supported only for PDF text.');
    if (job.section && job.extension !== '.docx') throw new Error('section selects an exact DOCX heading.');
    if (job.kind === 'pdf') {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: buffer });
      try {
        const result = await parser.getText(job.contentPages?.length ? { partial: job.contentPages } : undefined);
        if (job.contentPages?.some(page => page > result.total)) throw new Error('Requested PDF page exceeds page count: ' + result.total);
        return result.text.trim();
      } finally { await parser.destroy(); }
    }
    if (job.kind === 'word') {
      if (job.extension === '.doc') return binaryOfficeText(buffer);
      if (job.extension === '.odt') {
        const archive = await zipFrom(buffer);
        const document = archive.files['content.xml'];
        if (!document) throw new Error('OpenDocument 文件缺少 content.xml。');
        return officeXmlText(await document.async('text'));
      }
      const imported = await import('mammoth');
      const mammoth = imported.default || imported;
      if (job.section) {
        const html = (await mammoth.convertToHtml({ buffer })).value;
        const headings = [...html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)];
        const matches = headings.filter(match => decodeXml(match[2]).trim() === job.section);
        if (matches.length !== 1) throw new Error(matches.length ? 'Heading is ambiguous: ' + job.section : 'Heading not found. Available headings: ' + headings.map(match => decodeXml(match[2]).trim()).join(' | '));
        const first = matches[0];
        const end = headings.find(match => match.index > first.index && Number(match[1]) <= Number(first[1]))?.index ?? html.length;
        return decodeXml(html.slice(first.index, end).replace(/<\/(?:p|h[1-6]|tr|li)>/gi, '\n').replace(/<\/t[dh]>/gi, '\t')).trim();
      }
      return (await mammoth.extractRawText({ buffer })).value.trim();
    }
    if (job.kind === 'spreadsheet') {
      const XLSX = require('xlsx');
      let workbook = documents.get(job.digest);
      if (!workbook) {
        workbook = XLSX.read(buffer, { cellDates: true, dense: false, type: 'buffer' });
        documents.clear();
        if (buffer.length <= 8 * 1024 * 1024) documents.set(job.digest, workbook);
      }
      const names = job.sheet ? [job.sheet] : workbook.SheetNames;
      if (job.sheet && !workbook.Sheets[job.sheet]) throw new Error('Worksheet not found. Available worksheets: ' + workbook.SheetNames.join(' | '));
      if (job.range && !job.sheet && names.length !== 1) throw new Error('Specify sheet for a multi-sheet workbook.');
      if (job.range && !/^\$?[A-Z]{1,3}\$?[1-9]\d*(?::\$?[A-Z]{1,3}\$?[1-9]\d*)?$/i.test(job.range)) throw new Error('range must be an A1 cell or rectangle.');
      const range = job.range ? XLSX.utils.decode_range(job.range.replace(/\$/g, '').toUpperCase()) : undefined;
      if (range && (range.e.r < range.s.r || range.e.c < range.s.c || range.e.r >= 1048576 || range.e.c >= 16384 || (range.e.r-range.s.r+1)*(range.e.c-range.s.c+1) > 100000)) throw new Error('Requested range is invalid or exceeds 100000 cells.');
      return names.map((name) => {
        const original = workbook.Sheets[name];
        const selected = range ? Object.assign(Object.create(original), { '!ref': XLSX.utils.encode_range(range) }) : original;
        return '## 工作表：' + name + (job.range ? ' | 范围：' + job.range : '') + '\n' + XLSX.utils.sheet_to_csv(selected).trim();
      }).join('\n\n').trim();
    }
    if (job.kind === 'presentation') {
      if (['.ppt', '.pps', '.pot'].includes(job.extension)) return binaryOfficeText(buffer);
      const archive = await zipFrom(buffer);
      const slides = Object.keys(archive.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
        .sort((left, right) => Number((left.match(/\d+/) || [0])[0]) - Number((right.match(/\d+/) || [0])[0]));
      if (!slides.length && archive.files['content.xml']) return officeXmlText(await archive.files['content.xml'].async('text'));
      const values = await Promise.all(slides.map(async (name, index) => '## 幻灯片 ' + (index + 1) + '\n' + officeXmlText(await archive.files[name].async('text'))));
      return values.join('\n\n').trim();
    }
    if (job.kind === 'archive') {
      const archive = await zipFrom(buffer);
      const names = Object.values(archive.files).filter((entry) => !entry.dir).map((entry) => entry.name).slice(0, 2000);
      return '压缩包文件列表（' + names.length + ' 项）：\n' + names.join('\n');
    }
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '').trim();
    if (text && !buffer.includes(0)) return text;
    if (job.kind === 'text') return '';
    throw new Error('该文件是未知二进制格式，当前没有可用的文本解析器。');
  }
  parentPort.on('message', async (job) => {
    try { parentPort.postMessage({ id: job.id, ok: true, value: await extract(job) }); }
    catch (error) { parentPort.postMessage({ id: job.id, ok: false, error: error instanceof Error ? error.message : String(error) }); }
  });
