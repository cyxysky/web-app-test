function parseInline(text: string) {
  return text.split(/(<br \/>)/g).map((part, index) => (part === '<br />' ? <br key={index} /> : part));
}

function parseImage(trimmed: string, key: number, onImageClick?: (url: string) => void) {
  const match = trimmed.match(/^!\[(.*)]\((.*)\)$/);
  if (!match) return undefined;

  return (
    <figure className="report-shot" key={key}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img alt={match[1]} onClick={onImageClick ? () => onImageClick(match[2]) : undefined} src={match[2]} />
      <figcaption>{match[1]}</figcaption>
    </figure>
  );
}

function parseStepSection(lines: string[], startIndex: number, onImageClick?: (url: string) => void) {
  const title = lines[startIndex].trim().slice(4);
  const children: React.ReactNode[] = [];
  let index = startIndex + 1;

  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith('# ') || trimmed.startsWith('## ') || trimmed.startsWith('### ')) break;
    if (!trimmed) {
      index += 1;
      continue;
    }

    const image = parseImage(trimmed, index, onImageClick);
    if (image) {
      children.push(image);
      index += 1;
      continue;
    }

    if (trimmed.startsWith('- ')) {
      const items: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith('- ')) {
        items.push(lines[index].trim().slice(2));
        index += 1;
      }
      children.push(
        <ul className="report-step-list" key={index}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{parseInline(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    children.push(<p key={index}>{parseInline(trimmed)}</p>);
    index += 1;
  }

  return {
    node: (
      <section className="report-step-card" key={startIndex}>
        <h3>{title}</h3>
        {children}
      </section>
    ),
    nextIndex: index,
  };
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

export function MarkdownReport({ markdown, onImageClick }: { markdown: string; onImageClick?: (url: string) => void }) {
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

    if (trimmed.startsWith('### ')) {
      const section = parseStepSection(lines, index, onImageClick);
      nodes.push(section.node);
      index = section.nextIndex;
      continue;
    }

    const image = parseImage(trimmed, index, onImageClick);
    if (image) {
      nodes.push(image);
    } else if (trimmed.startsWith('# ')) {
      nodes.push(<h1 key={index}>{trimmed.slice(2)}</h1>);
    } else if (trimmed.startsWith('## ')) {
      nodes.push(<h2 key={index}>{trimmed.slice(3)}</h2>);
    } else if (trimmed.startsWith('- ')) {
      const items: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith('- ')) {
        items.push(lines[index].trim().slice(2));
        index += 1;
      }
      nodes.push(
        <ul key={index} style={{width: "100%", overflow: "hidden", whiteSpace: "pre-wrap", wordBreak: "break-all"}}>
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
