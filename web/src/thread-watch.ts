import { createHost, webSocketLink, type WebSocketLike } from "@earendil-works/chord";
import { ThreadView } from "../../harness/thread-view";
import type { ThreadViewState } from "./thread-progress";

export function watchThreadView(thread: string, onView: (view: ThreadViewState) => void): () => void {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${scheme}://${location.host}/api/team/view?thread=${encodeURIComponent(thread)}`);
  const host = createHost({ self: {}, kind: "client" });
  host.connect(webSocketLink(socket as WebSocketLike), { principal: {} });
  let stopped = false;
  let stop = () => {};
  void host.get(ThreadView, {}).then(
    (ref) => {
      const unsubscribe = ref.view.subscribe((value) => onView(value as ThreadViewState));
      stop = () => {
        unsubscribe();
        ref.release();
      };
      if (stopped) stop();
    },
    () => {},
  );
  return () => {
    stopped = true;
    stop();
    void host.close();
  };
}
