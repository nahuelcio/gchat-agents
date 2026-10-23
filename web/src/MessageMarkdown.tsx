import { lazy, Suspense, type ReactNode } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArtifactCard } from "./ArtifactPreview";
import { gherkinLine, isGherkin } from "./gherkin";

const CodeBlock = lazy(() => import("./CodeBlock").then((m) => ({ default: m.CodeBlock })));
const MermaidDiagram = lazy(() => import("./MermaidDiagram").then((m) => ({ default: m.MermaidDiagram })));

const BARE_IMAGE =
  /(^|[\s(])(https?:\/\/[^\s<>)"']+\.(?:png|jpe?g|gif|webp|svg)(?:\?[^\s<>)"']*)?)/gi;

const ARTIFACT_MARK = /\[\[artifact:([a-f0-9]{24})\|([^\]]+)\]\]/g;

/** Turn bare image URLs into markdown images so they render inline. */
/** Quoted values and <params> inside a step stand out from the prose. */
function stepText(text: string): ReactNode[] {
  return text.split(/("[^"]*"|<[^>]+>)/).map((part, i) =>
    i % 2 ? <span key={i} className={part.startsWith("<") ? "gk-param" : "gk-string"}>{part}</span> : part,
  );
}

function GherkinBlock({ text }: { text: string }) {
  return (
    <pre className="message-pre gherkin">
      <code>
        {text.split("\n").map((raw, i) => {
          const l = gherkinLine(raw);
          return (
            <div key={i} className={`gk-${l.kind}`}>
              {"keyword" in l && <span className="gk-keyword">{l.keyword}</span>}
              {l.kind === "step" ? stepText(l.text) : l.text || "\u00a0"}
            </div>
          );
        })}
      </code>
    </pre>
  );
}

function promoteBareImageUrls(text: string): string {
  return text.replace(BARE_IMAGE, (_, lead: string, url: string) => `${lead}![](${url})`);
}

type Segment = { kind: "text"; text: string } | { kind: "artifact"; id: string; title: string };

function splitArtifacts(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  const re = new RegExp(ARTIFACT_MARK.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    out.push({ kind: "artifact", id: m[1]!, title: m[2]!.trim() || "Artifact" });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out.length ? out : [{ kind: "text", text }];
}

const components: Components = {
  pre({ children }) {
    return <>{children}</>;
  },
  code({ className, children }) {
    const text = String(children).replace(/\n$/, "");
    const lang = /language-(\w+)/.exec(className || "")?.[1];
    if (lang === "mermaid")
      return (
        <Suspense fallback={<pre className="mermaid-loading">{text}</pre>}>
          <MermaidDiagram source={text} />
        </Suspense>
      );
    if (isGherkin(lang, text)) return <GherkinBlock text={text} />;
    if (lang || text.includes("\n")) {
      const plain = (
        <pre className="message-pre">
          <code className={className}>{text}</code>
        </pre>
      );
      return lang ? <Suspense fallback={plain}><CodeBlock text={text} lang={lang} /></Suspense> : plain;
    }
    return <code className="message-code">{children}</code>;
  },
  img({ src, alt }) {
    if (!src) return null;
    return <img className="message-image" src={src} alt={alt || "image"} loading="lazy" />;
  },
  a({ href, children }) {
    if (!href) return <span>{children}</span>;
    const external = /^https?:\/\//i.test(href);
    return (
      <a href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : undefined)}>
        {children}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className="message-table-wrap">
        <table>{children}</table>
      </div>
    );
  },
};

function MarkdownChunk({ text }: { text: string }) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {promoteBareImageUrls(text)}
    </ReactMarkdown>
  );
}

export function MessageMarkdown({ text, mediaUrl }: { text: string; mediaUrl: (id: string) => string }) {
  if (!text) return null;
  const segments = splitArtifacts(text);
  const nodes: ReactNode[] = segments.map((seg, i) => {
    if (seg.kind === "artifact") {
      return <ArtifactCard key={`a-${seg.id}-${i}`} id={seg.id} title={seg.title} src={mediaUrl(seg.id)} />;
    }
    return <MarkdownChunk key={`t-${i}`} text={seg.text} />;
  });
  return <div className="message-text">{nodes}</div>;
}
