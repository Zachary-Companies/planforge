// Small self-contained markdown renderer for plan documents.
// Covers: headings, paragraphs, bold/italic/strikethrough, inline code,
// fenced code blocks, links (sanitized), ordered/unordered lists (nested),
// tables, blockquotes, horizontal rules. Everything is HTML-escaped first.

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function safeLink(text, href) {
  // href arrives already HTML-escaped; block javascript: & friends.
  const ok = /^(https?:|mailto:|#|\/|\.\/|[a-z0-9_-])/i.test(href) && !/^\s*javascript:/i.test(href);
  if (!ok) return text;
  const external = /^https?:/i.test(href);
  return `<a href="${href}"${external ? ' target="_blank" rel="noopener"' : ''}>${text}</a>`;
}

function inline(src) {
  let t = escapeHtml(src);
  // protect code spans from further formatting
  const stash = [];
  t = t.replace(/`([^`]+)`/g, (_, code) => {
    stash.push(`<code>${code}</code>`);
    return `\u0001${stash.length - 1}\u0001`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  t = t.replace(/(^|[\s(>])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  t = t.replace(/(^|[\s(>])_([^_\s][^_]*)_/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, txt, href) => safeLink(txt, href));
  t = t.replace(/(^|[\s(])(https?:\/\/[^\s)<]+)/g, (_, pre, url) => pre + safeLink(url, url));
  t = t.replace(/\u0001(\d+)\u0001/g, (_, n) => stash[Number(n)]);
  return t;
}

const splitRow = (line) => line
  .replace(/^\s*\|/, '')
  .replace(/\|\s*$/, '')
  .split('|')
  .map((c) => c.trim());

function renderTable(header, aligns, rows) {
  const alignAttr = (i) => {
    const a = aligns[i];
    return a ? ` style="text-align:${a}"` : '';
  };
  let html = '<div class="md-table-wrap"><table><thead><tr>';
  header.forEach((cell, i) => { html += `<th${alignAttr(i)}>${inline(cell)}</th>`; });
  html += '</tr></thead><tbody>';
  for (const row of rows) {
    html += '<tr>';
    header.forEach((_, i) => { html += `<td${alignAttr(i)}>${inline(row[i] ?? '')}</td>`; });
    html += '</tr>';
  }
  return `${html}</tbody></table></div>`;
}

function parseAligns(sepLine) {
  return splitRow(sepLine).map((c) => {
    const l = c.startsWith(':');
    const r = c.endsWith(':');
    if (l && r) return 'center';
    if (r) return 'right';
    if (l) return 'left';
    return null;
  });
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function collectListItems(lines, start) {
  const items = [];
  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(LIST_ITEM);
    if (m) {
      items.push({
        indent: m[1].replace(/\t/g, '  ').length,
        ordered: /\d/.test(m[2]),
        text: [m[3]],
      });
      i += 1;
      continue;
    }
    // indented continuation of the previous item
    if (items.length && /^\s{2,}\S/.test(lines[i])) {
      items[items.length - 1].text.push(lines[i].trim());
      i += 1;
      continue;
    }
    break;
  }
  return { items, next: i };
}

function buildList(items) {
  let i = 0;
  const level = (indent) => {
    const ordered = items[i].ordered;
    let html = ordered ? '<ol>' : '<ul>';
    while (i < items.length && items[i].indent >= indent) {
      if (items[i].indent > indent) {
        const sub = level(items[i].indent);
        // nest the sublist inside the previous <li>
        html = html.endsWith('</li>') ? `${html.slice(0, -5)}${sub}</li>` : html + sub;
      } else {
        html += `<li>${inline(items[i].text.join(' '))}</li>`;
        i += 1;
      }
    }
    return html + (ordered ? '</ol>' : '</ul>');
  };
  return level(items[0].indent);
}

export function renderMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flushPara = () => {
    if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      flushPara();
      const lang = fence[1].trim();
      const buf = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i += 1; }
      i += 1; // closing fence
      out.push(`<pre class="codeblock"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    if (!line.trim()) { flushPara(); i += 1; continue; }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      const depth = heading[1].length;
      const text = heading[2].replace(/\s#+\s*$/, '');
      out.push(`<h${depth} id="${slugify(text)}">${inline(text)}</h${depth}>`);
      i += 1;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); out.push('<hr>'); i += 1; continue; }

    if (/^\s*>/.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length
      && /^\s*\|?[\s:-]+(\|[\s:-]+)+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flushPara();
      const header = splitRow(line);
      const aligns = parseAligns(lines[i + 1]);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(splitRow(lines[i])); i += 1; }
      out.push(renderTable(header, aligns, rows));
      continue;
    }

    if (LIST_ITEM.test(line)) {
      flushPara();
      const { items, next } = collectListItems(lines, i);
      out.push(buildList(items));
      i = next;
      continue;
    }

    para.push(line.trim());
    i += 1;
  }
  flushPara();
  return out.join('\n');
}
