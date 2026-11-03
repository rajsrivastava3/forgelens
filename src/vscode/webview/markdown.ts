/** A small markdown renderer: everything is escaped first, so model output can never inject markup. */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInline(text: string): string {
  const codeSpans: string[] = [];
  let html = escapeHtml(text).replace(/`([^`]+)`/g, (_, code: string) => {
    codeSpans.push(`<code>${code}</code>`);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  html = html
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  // eslint-disable-next-line no-control-regex
  return html.replace(/\u0000(\d+)\u0000/g, (_, index: string) => codeSpans[Number(index)] ?? '');
}

/** Handles partial input too: an unclosed code fence renders as code while it streams. */
export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | undefined;

  const flushParagraph = (): void => {
    if (paragraph.length > 0) out.push(`<p>${renderInline(paragraph.join('\n')).replace(/\n/g, '<br>')}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (list) out.push(`<${list.tag}>${list.items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</${list.tag}>`);
    list = undefined;
  };
  const flush = (): void => {
    flushParagraph();
    flushList();
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const fence = /^\s*(```+|~~~+)(.*)$/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      for (i += 1; i < lines.length; i += 1) {
        const inner = lines[i] ?? '';
        if (inner.trimStart().startsWith(fence[1] ?? '```')) break;
        code.push(inner);
      }
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = Math.min((heading[1]?.length ?? 1) + 2, 6);
      out.push(`<h${level}>${renderInline(heading[2] ?? '')}</h${level}>`);
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const tag = bullet ? 'ul' : 'ol';
      if (list?.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push((bullet ?? numbered)?.[1] ?? '');
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flush();
  return out.join('');
}
