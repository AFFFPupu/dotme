// In-memory Store with the same conditional-write contract as the real ones,
// plus a hook to simulate a concurrent change just before a write.
import type { Store } from "../src/store";

export function memoryStore() {
  const files = new Map<string, string>();
  const messages: string[] = [];
  const shaOf = (content: string) => `${content.length}:${[...content].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)}`;
  const store: Store & { files: Map<string, string>; messages: string[]; beforeWrite?: (path: string) => void } = {
    files,
    messages,
    async read(path) {
      const content = files.get(path);
      return content === undefined ? null : { content, sha: shaOf(content) };
    },
    async write(path, content, sha, message) {
      store.beforeWrite?.(path);
      const current = files.get(path);
      if ((current === undefined ? null : shaOf(current)) !== sha) return false;
      files.set(path, content);
      messages.push(message);
      return true;
    },
    async remove(path, _sha, message) {
      files.delete(path);
      messages.push(message);
    },
    async list(dir) {
      const prefix = dir ? `${dir}/` : "";
      return [...files.keys()].filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"));
    },
  };
  return store;
}
