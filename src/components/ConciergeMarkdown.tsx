import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import '../concierge-markdown.css';

// Responses are untrusted text. Allow ordinary web/mail links and local
// footnotes, but never executable, file, or application-specific URLs.
function safeUrl(url: string): string {
  if (url.startsWith('#')) return url;
  try {
    const parsed = new URL(url);
    return ['https:', 'http:', 'mailto:'].includes(parsed.protocol) ? url : '';
  } catch {
    return '';
  }
}

const components: Components = {
  a: ({ href, children, title }) => href ? (
    <a href={href} title={title} target={href.startsWith('#') ? undefined : '_blank'} rel="noopener noreferrer">
      {children}
    </a>
  ) : <span>{children}</span>,
  // Do not fetch model-supplied images automatically. Preserve the description
  // and let the user explicitly open a safe image link instead.
  img: ({ src, alt }) => (
    <span className="concierge-markdown-image">
      {src ? <a href={src} target="_blank" rel="noopener noreferrer">Image: {alt || 'Open image'}</a>
        : <span>Image: {alt || 'Unavailable image'}</span>}
    </span>
  ),
  table: ({ children }) => (
    <div className="concierge-markdown-table" role="region" aria-label="Response table" tabIndex={0}>
      <table>{children}</table>
    </div>
  ),
};

export function ConciergeMarkdown({ children }: { children: string }) {
  return (
    <div className="concierge-markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={components} urlTransform={safeUrl} skipHtml>
        {children}
      </Markdown>
    </div>
  );
}
