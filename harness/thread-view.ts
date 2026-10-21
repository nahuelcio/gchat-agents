import { hostNamed, remote } from "@earendil-works/chord";
import { Type } from "typebox";

export type ThreadViewPrincipal = { thread: string };

export const ThreadView = remote("switchboard.thread-view", {
  version: 1,
  input: Type.Object({}),
  host: hostNamed("view"),
  variants: {
    viewer: { state: { view: Type.Any() } },
  },
});
