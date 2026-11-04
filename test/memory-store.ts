// In-memory Store with the same conditional-write contract as the real ones,
// plus a hook to simulate a concurrent change just before a write (or a commit of that path).
import type { Store } from "../src/store";

export function memoryStore() {
  const files = new Map<string, string>();
  const messages: string[] = [];
  // Every multi-file commit, with the paths it changed.
  const commits: { message: string; paths: string[] }[] = [];
  const shaOf = (content: string) => `${content.length}:${[...content].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)}`;
  const store: Store & { files: Map<string, string>; messages: string[]; commits: typeof commits; beforeWrite?: (path: string) => void } = {
    files,
    messages,
    commits,
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
    snapshot() {
      const seen = new Map<string, string | null>();
      return {
        async read(paths) {
          for (const path of paths) seen.set(path, files.get(path) ?? null);
          return new Map(paths.map((path) => [path, seen.get(path)!]));
        },
        async commit(changes, message) {
          for (const change of changes) store.beforeWrite?.(change.path);
          for (const [path, content] of seen) if ((files.get(path) ?? null) !== content) return false;
          for (const { path, content } of changes) content === null ? files.delete(path) : files.set(path, content);
          messages.push(message);
          commits.push({ message, paths: changes.map((c) => c.path) });
          return true;
        },
      };
    },
  };
  return store;
}
