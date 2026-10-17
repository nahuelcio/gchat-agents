import { useEffect, useRef } from "react";
import { mount } from "pele";

export function MermaidDiagram({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.replaceChildren();
    const diagram = mount(el, source, {
      images: false,
      linkRel: "noopener noreferrer",
    });
    return () => {
      diagram.destroy();
      el.replaceChildren();
    };
  }, [source]);

  return <div className="message-diagram" ref={ref} />;
}
