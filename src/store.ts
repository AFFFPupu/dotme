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
  // One consistent version of the store, to read many files at once and commit many changes as one.
  snapshot(): Snapshot;
}

// A file to write, or to delete when `content` is null.
export interface Change {
  path: string;
  content: string | null;
}

export interface Snapshot {
  // These files as they are at the snapshot's version (null: no such file), in as few calls as the store allows.
  read(paths: string[]): Promise<Map<string, string | null>>;
  // Every change as one commit on top of that version. False, with nothing written, if the store moved on.
  commit(changes: Change[], message: string): Promise<boolean>;
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
    // KV has no transactions: a commit re-checks what was read, then writes file by file.
    // Good enough for local development, the only place KV storage is used.
    snapshot() {
      const seen = new Map<string, string | null>();
      return {
        async read(paths) {
          const found = new Map<string, string | null>();
          for (const path of paths) {
            const content = await kv.get(key(path));
            seen.set(path, content);
            found.set(path, content);
          }
          return found;
        },
        async commit(changes) {
          for (const [path, content] of seen) if ((await kv.get(key(path))) !== content) return false;
          for (const change of changes) {
            if (change.content === null) await kv.delete(key(change.path));
            else await kv.put(key(change.path), change.content);
          }
          return true;
        },
      };
    },
  };
}

// The token expiry GitHub sent on the latest response ("" for none, null before any call),
// so owner pages can warn without an extra request.
let tokenExpiry: string | null = null;
export const lastTokenExpiry = () => tokenExpiry;

function githubStore(token: string, repo: string): Store {
  const [owner, name] = repo.split("/");
  const api = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`https://api.github.com/${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "dotme",
        "X-GitHub-Api-Version": "2022-11-28",
        ...init.headers,
      },
    });
    if (res.status !== 401) tokenExpiry = res.headers.get("github-authentication-token-expiration") ?? "";
    return res;
  };
  const contents = (path: string, init?: RequestInit) => api(`repos/${repo}/contents/${path}`, init);
  const json = async <T>(label: string, res: Response): Promise<T> => {
    if (!res.ok) throw new Error(`GitHub ${label}: ${res.status}`);
    return (await res.json()) as T;
  };
  // GraphQL reads many files in one call. Errors name the call and status (or error type), never the token.
  const graphql = async <T>(query: string, variables: Record<string, string>): Promise<T> => {
    const body = await json<{ data?: T; errors?: { type?: string }[] }>("graphql", await api("graphql", { method: "POST", body: JSON.stringify({ query, variables }) }));
    if (body.errors?.length || !body.data) throw new Error(`GitHub graphql: ${body.errors?.[0]?.type ?? "no data"}`);
    return body.data;
  };
  const toBase64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  const fromBase64 = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, "")), (c) => c.charCodeAt(0)));

  return {
    async read(path) {
      const res = await contents(path);
      if (res.status === 404) return null;
      const body = await json<{ content: string; sha: string }>(`read ${path}`, res);
      return { content: fromBase64(body.content), sha: body.sha };
    },
    async write(path, content, sha, message) {
      const res = await contents(path, {
        method: "PUT",
        body: JSON.stringify({ message, content: toBase64(content), ...(sha ? { sha } : {}) }),
      });
      if (res.status === 409 || res.status === 422) return false;
      if (!res.ok) throw new Error(`GitHub write ${path}: ${res.status}`);
      return true;
    },
    async remove(path, sha, message) {
      const res = await contents(path, { method: "DELETE", body: JSON.stringify({ message, sha }) });
      if (!res.ok && res.status !== 404) throw new Error(`GitHub delete ${path}: ${res.status}`);
    },
    async list(dir) {
      const res = await contents(dir);
      if (res.status === 404) return [];
      return (await json<{ path: string; type: string }[]>(`list ${dir}`, res)).filter((f) => f.type === "file").map((f) => f.path);
    },
    // Pinned to the default branch's head commit when first used: reads come from that commit, and the
    // commit only lands as a fast-forward of it. Five GitHub calls however many files a batch touches.
    snapshot() {
      let head: Promise<{ branch: string; commit: string; tree: string }> | undefined;
      const pin = () =>
        (head ??= graphql<{ repository: { defaultBranchRef: { name: string; target: { oid: string; tree: { oid: string } } } } }>(
          "query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { defaultBranchRef { name target { oid ... on Commit { tree { oid } } } } } }",
          { owner, name },
        ).then(({ repository: { defaultBranchRef: ref } }) => ({ branch: ref.name, commit: ref.target.oid, tree: ref.target.tree.oid })));
      return {
        async read(paths) {
          const { commit } = await pin();
          const found = new Map<string, string | null>();
          if (!paths.length) return found;
          const vars = Object.fromEntries(paths.map((path, i) => [`p${i}`, `${commit}:${path}`]));
          const query = `query($owner: String!, $name: String!, ${paths.map((_, i) => `$p${i}: String!`).join(", ")}) { repository(owner: $owner, name: $name) { ${paths
            .map((_, i) => `f${i}: object(expression: $p${i}) { ... on Blob { text isBinary isTruncated } }`)
            .join(" ")} } }`;
          const { repository } = await graphql<{ repository: Record<string, { text: string | null; isBinary: boolean; isTruncated: boolean } | null> }>(query, { owner, name, ...vars });
          paths.forEach((path, i) => {
            const blob = repository[`f${i}`];
            if (blob && (blob.isBinary || blob.isTruncated || blob.text === null)) throw new Error(`GitHub read ${path}: not a small text file`);
            found.set(path, blob ? blob.text : null);
          });
          return found;
        },
        async commit(changes, message) {
          const { branch, commit, tree } = await pin();
          const entries = changes.map(({ path, content }) => ({ path, mode: "100644", type: "blob", ...(content === null ? { sha: null } : { content }) }));
          const newTree = await json<{ sha: string }>("tree", await api(`repos/${repo}/git/trees`, { method: "POST", body: JSON.stringify({ base_tree: tree, tree: entries }) }));
          const newCommit = await json<{ sha: string }>("commit", await api(`repos/${repo}/git/commits`, { method: "POST", body: JSON.stringify({ message, tree: newTree.sha, parents: [commit] }) }));
          const res = await api(`repos/${repo}/git/refs/heads/${branch}`, { method: "PATCH", body: JSON.stringify({ sha: newCommit.sha, force: false }) });
          // Not a fast-forward: something else committed since the snapshot. The new commit is left unreferenced.
          if (res.status === 409 || res.status === 422) return false;
          if (!res.ok) throw new Error(`GitHub update ${branch}: ${res.status}`);
          return true;
        },
      };
    },
  };
}
