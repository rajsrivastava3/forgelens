import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/vscode/webview/markdown';

describe('renderMarkdown', () => {
  it('escapes everything, so model output cannot inject markup', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> **<b>** `<script>`');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img');
    expect(html).toContain('<strong>&lt;b&gt;</strong>');
    expect(html).toContain('<code>&lt;script&gt;</code>');
  });

  it('only links http and https', () => {
    expect(renderMarkdown('[a](https://x.dev/y)')).toContain('<a href="https://x.dev/y">a</a>');
    expect(renderMarkdown('[a](javascript:alert(1))')).not.toContain('<a ');
  });

  it('renders paragraphs, headings and lists', () => {
    expect(renderMarkdown('# T\n\nline one\nline two')).toBe('<h3>T</h3><p>line one<br>line two</p>');
    expect(renderMarkdown('- a\n- b\n\n1. c')).toBe('<ul><li>a</li><li>b</li></ul><ol><li>c</li></ol>');
  });

  it('renders an unclosed code fence while it is still streaming', () => {
    expect(renderMarkdown('```py\nx = 1')).toBe('<pre><code>x = 1</code></pre>');
    expect(renderMarkdown('```\n**not bold**\n```\nafter')).toBe('<pre><code>**not bold**</code></pre><p>after</p>');
  });

  it('leaves markdown inside code spans alone', () => {
    expect(renderMarkdown('`a*b*c` and *d*')).toBe('<p><code>a*b*c</code> and <em>d</em></p>');
  });

  it('copes with empty or partial input', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown('**bold not closed')).toBe('<p>**bold not closed</p>');
  });
});
