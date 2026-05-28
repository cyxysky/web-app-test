function parseInline(text: string) {
  return text.split(/(<br \/>)/g).map((part, index) => (part === '<br />' ? <br key={index} /> : part));
}

function parseTable(lines: string[], startIndex: number) {
  const tableLines: string[] = [];
  let index = startIndex;

  while (index < lines.length && lines[index].trim().startsWith('|')) {
    tableLines.push(lines[index]);
    index += 1;
  }

  const [headerLine, separatorLine, ...bodyLines] = tableLines;
  const headers = splitTableRow(headerLine);
  const hasSeparator = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(separatorLine || '');
  const rows = hasSeparator ? bodyLines.map(splitTableRow) : tableLines.slice(1).map(splitTableRow);

  return {
    node: (
      <div className="markdown-table-wrap" key={`table-${startIndex}`}>
        <table>
          <thead>
            <tr>
              {headers.map((header, cellIndex) => (
                <th key={cellIndex}>{parseInline(header)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>{parseInline(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ),
    nextIndex: index,
  };
}

function splitTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, '|').trim());
}

export function MarkdownReport({ markdown }: { markdown: string }) {
  const lines = markdown.split(/\r?\n/);
  const nodes: React.ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    if (trimmed.startsWith('|') && lines[index + 1]?.trim().startsWith('|')) {
      const table = parseTable(lines, index);
      nodes.push(table.node);
      index = table.nextIndex;
      continue;
    }

    if (trimmed.startsWith('# ')) {
      nodes.push(<h1 key={index}>{trimmed.slice(2)}</h1>);
    } else if (trimmed.startsWith('## ')) {
      nodes.push(<h2 key={index}>{trimmed.slice(3)}</h2>);
    } else if (trimmed.startsWith('### ')) {
      nodes.push(<h3 key={index}>{trimmed.slice(4)}</h3>);
    } else if (trimmed.startsWith('- ')) {
      const items: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith('- ')) {
        items.push(lines[index].trim().slice(2));
        index += 1;
      }
      nodes.push(
        <ul key={index}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{parseInline(item)}</li>
          ))}
        </ul>,
      );
      continue;
    } else {
      nodes.push(<p key={index}>{parseInline(trimmed)}</p>);
    }

    index += 1;
  }

  return <div className="markdown-report">{nodes}</div>;
}
