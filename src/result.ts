/** Format model answers without executing their HTML or loading remote images. */
export function renderAnswer(markdown: string): string {
  return Bun.markdown.render(
    markdown,
    {
      text: Bun.escapeHTML,
      html: Bun.escapeHTML,
      heading: (text, { level }) => {
        const tag = `h${Math.min(level + 2, 6)}`;
        return `<${tag} dir="auto">${text}</${tag}>`;
      },
      paragraph: (text) => `<p dir="auto">${text}</p>`,
      strong: (text) => `<strong>${text}</strong>`,
      emphasis: (text) => `<em>${text}</em>`,
      strikethrough: (text) => `<del>${text}</del>`,
      codespan: (text) => `<code>${text}</code>`,
      code: (text, meta) =>
        `<div class="result-code"><div class="result-code-bar"><span>${Bun.escapeHTML(meta?.language || "Code")}</span><button type="button" data-copy-code>Copy code</button></div><pre dir="ltr"><code>${text}</code></pre></div>`,
      blockquote: (text) => `<blockquote>${text}</blockquote>`,
      list: (text, { ordered, start }) =>
        ordered ? `<ol start="${start ?? 1}">${text}</ol>` : `<ul>${text}</ul>`,
      listItem: (text, { checked }) =>
        `<li>${checked === undefined ? "" : checked ? "☑ " : "☐ "}${text}</li>`,
      hr: () => "<hr>",
      table: (text) =>
        `<div class="result-table" tabindex="0" role="region" aria-label="Answer table"><table>${text}</table></div>`,
      thead: (text) => `<thead>${text}</thead>`,
      tbody: (text) => `<tbody>${text}</tbody>`,
      tr: (text) => `<tr>${text}</tr>`,
      th: (text) => `<th scope="col">${text}</th>`,
      td: (text) => `<td>${text}</td>`,
      link: (text, { href }) => {
        try {
          const url = new URL(href);
          if (["http:", "https:"].includes(url.protocol))
            return `<a href="${Bun.escapeHTML(url.href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
        } catch {
          // Unresolvable links remain readable without becoming navigation.
        }
        return text;
      },
      image: (text) => text,
    },
    {
      noHtmlBlocks: true,
      noHtmlSpans: true,
      autolinks: { url: true, www: true },
    },
  );
}
