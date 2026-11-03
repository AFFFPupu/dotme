// File storage behind one interface: the user's private GitHub repo in
// production, KV for local development (STORAGE=kv).

export interface StoredFile {
  content: string;
  sha: string;
}

export interface Store {
  read(path: string): Promise<StoredFile | null>;
  // Writes only if the file is still at `sha` (null: must not exist). Returns false on a conflict.
  write(path: string, content: string, sha: string | null, message: string): Promise<boolean>;
  remove(path: string, sha: string, message: string): Promise<void>;
  // Paths of the files directly in `dir` ("" for the root), not in its subdirectories.
  list(dir: string): Promise<string[]>;
}

export interface StoreEnv {
  STORAGE?: string;
  OAUTH_KV: KVNamespace;
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
}

export function makeStore(env: StoreEnv): Store {
  if (env.STORAGE === "kv") return kvStore(env.OAUTH_KV);
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) throw new Error("GITHUB_TOKEN and GITHUB_REPO must be set");
  return githubStore(env.GITHUB_TOKEN, env.GITHUB_REPO);
}

function kvStore(kv: KVNamespace): Store {
  const key = (path: string) => `file:${path}`;
  const shaOf = async (content: string) =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(content)))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  return {
    async read(path) {
      const content = await kv.get(key(path));
      return content === null ? null : { content, sha: await shaOf(content) };
    },
    async write(path, content, sha) {
      const current = await this.read(path);
      if ((current?.sha ?? null) !== sha) return false;
      await kv.put(key(path), content);
      return true;
    },
    async remove(path) {
      await kv.delete(key(path));
    },
    async list(dir) {
      const prefix = dir ? `${dir}/` : "";
      const { keys } = await kv.list({ prefix: key(prefix) });
      return keys.map((k) => k.name.slice("file:".length)).filter((path) => !path.slice(prefix.length).includes("/"));
    },
  };
}

function githubStore(token: string, repo: string): Store {
  const api = (path: string, init: RequestInit = {}) =>
    fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "dotme",
        "X-GitHub-Api-Version": "2022-11-28",
        ...init.headers,
      },
    });
  const toBase64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  const fromBase64 = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, "")), (c) => c.charCodeAt(0)));

  return {
    async read(path) {
      const res = await api(path);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GitHub read ${path}: ${res.status}`);
      const body = (await res.json()) as { content: string; sha: string };
      return { content: fromBase64(body.content), sha: body.sha };
    },
    async write(path, content, sha, message) {
      const res = await api(path, {
        method: "PUT",
        body: JSON.stringify({ message, content: toBase64(content), ...(sha ? { sha } : {}) }),
      });
      if (res.status === 409 || res.status === 422) return false;
      if (!res.ok) throw new Error(`GitHub write ${path}: ${res.status}`);
      return true;
    },
    async remove(path, sha, message) {
      const res = await api(path, { method: "DELETE", body: JSON.stringify({ message, sha }) });
      if (!res.ok && res.status !== 404) throw new Error(`GitHub delete ${path}: ${res.status}`);
    },
    async list(dir) {
      const res = await api(dir);
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`GitHub list ${dir}: ${res.status}`);
      return ((await res.json()) as { path: string; type: string }[]).filter((f) => f.type === "file").map((f) => f.path);
    },
  };
}
