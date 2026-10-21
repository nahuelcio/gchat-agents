export function poll(load: () => void, ms: number): () => void {
  const tick = () => {
    if (!document.hidden) load();
  };
  load();
  const id = setInterval(tick, ms);
  document.addEventListener("visibilitychange", tick);
  return () => {
    clearInterval(id);
    document.removeEventListener("visibilitychange", tick);
  };
}

export function whenChanged<T>(set: (value: T) => void): (value: T) => void {
  let last: string | undefined;
  return (value) => {
    const json = JSON.stringify(value);
    if (json === last) return;
    last = json;
    set(value);
  };
}
