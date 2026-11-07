export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const cap = (s) => s[0].toUpperCase() + s.slice(1);

// Minimal markdown for the rules pages: headings, lists, tables, bold, italics, paragraphs.
export function md(text) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>').replace(/\\\*/g, '*');
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      i--;
      const cells = (r) => r.split('|').slice(1, -1).map((c) => c.trim());
      out.push(`<table><tr>${cells(rows[0]).map((c) => `<th>${inline(c)}</th>`).join('')}</tr>${rows
        .slice(2)
        .map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
        .join('')}</table>`);
    } else if (/^ *- /.test(l)) {
      const items = [];
      while (i < lines.length && /^ *- /.test(lines[i])) items.push(lines[i++].replace(/^ *- /, ''));
      i--;
      out.push(`<ul>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`);
    } else if (/^\d+\. /.test(l)) {
      const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) items.push(lines[i++].replace(/^\d+\. /, ''));
      i--;
      out.push(`<ol>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</ol>`);
    } else if (l.startsWith('#')) {
      const level = l.match(/^#+/)[0].length;
      out.push(`<h${level + 2}>${inline(l.replace(/^#+\s*/, ''))}</h${level + 2}>`);
    } else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  return out.join('');
}
