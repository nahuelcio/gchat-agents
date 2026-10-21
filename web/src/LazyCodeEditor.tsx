import { lazy, Suspense, type ComponentProps } from "react";

const Editor = lazy(() => import("./CodeEditor").then((m) => ({ default: m.CodeEditor })));

type Props = ComponentProps<typeof Editor>;

export function CodeEditor(props: Props) {
  const minHeight = props.minHeight ?? 160;
  return (
    <Suspense fallback={<div className="code-editor" style={{ minHeight }} aria-busy="true" />}>
      <Editor {...props} />
    </Suspense>
  );
}
