// Reads, proposals and approvals over the store. Agents can only propose;
// only the owner, on the approval page, turns a proposal into a commit.

import { applyProposal, DEFAULT_CATEGORIES, isCategoryName, newId, parsePreferences, serializePreferences } from "./prefs";
import type { Category, Preference, Proposal } from "./prefs";
import type { Change, Store } from "./store";

const prefPath = (category: Category) => `${category}.md`;
const pendingPath = (id: string) => `pending/${id}.json`;

export async function getPreferences(store: Store, category: Category): Promise<Preference[]> {
  const file = await store.read(prefPath(category));
  return file ? parsePreferences(file.content) : [];
}

export async function propose(store: Store, input: Omit<Proposal, "id" | "createdAt">): Promise<Proposal> {
  if (!isCategoryName(input.category)) throw new Error(`Invalid category name: ${input.category}`);
  if (input.op !== "add") {
    const existing = await getPreferences(store, input.category);
    if (!existing.some((p) => p.id === input.replaces)) throw new Error(`No preference ${input.replaces} in ${input.category}`);
  }
  if (input.op !== "remove" && !input.text) throw new Error("text is required to add or change a preference");
  const proposal: Proposal = { ...input, id: newId("q"), createdAt: new Date().toISOString() };
  await store.write(pendingPath(proposal.id), JSON.stringify(proposal, null, 2) + "\n", null, `Proposal ${proposal.id} from ${proposal.by}`);
  return proposal;
}

export async function getProposal(store: Store, id: string): Promise<{ proposal: Proposal; sha: string } | null> {
  if (!/^q-[0-9a-f]{8}$/.test(id)) return null;
  const file = await store.read(pendingPath(id));
  return file ? { proposal: JSON.parse(file.content) as Proposal, sha: file.sha } : null;
}

// Every category in the store: the defaults plus each `<name>.md` file at the root, sorted with the
// defaults first. Adding a file adds a category; existing connections only see it once re-authorized.
export async function listCategories(store: Store): Promise<Category[]> {
  const found = (await store.list(""))
    .map((path) => path.match(/^([^/]+)\.md$/)?.[1])
    .filter(isCategoryName)
    .filter((name) => !(DEFAULT_CATEGORIES as readonly string[]).includes(name))
    .sort();
  return [...DEFAULT_CATEGORIES, ...new Set(found)];
}

// Open proposals, oldest first. Without `categories` (the owner's view), every category.
// The proposals are read together, so the number of calls does not grow with the list.
export async function listPending(store: Store, categories?: readonly Category[]): Promise<Proposal[]> {
  const files = await store.snapshot().read(await store.list("pending"));
  const proposals = [...files.values()].filter((content) => content !== null).map((content) => JSON.parse(content) as Proposal);
  return proposals.filter((p) => !categories || categories.includes(p.category)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// Other open proposals touching the same preference, shown next to this one.
export function conflictsWith(proposal: Proposal, pending: Proposal[]): Proposal[] {
  return pending.filter((p) => p.id !== proposal.id && p.category === proposal.category && p.replaces && p.replaces === proposal.replaces);
}

// A decision the owner cannot make as asked (already handled, target gone, file busy). Pages show
// its message as a friendly page instead of a server error.
export class ProposalError extends Error {}

export async function approve(store: Store, id: string, when: string | undefined): Promise<void> {
  const result = await decide(store, "approve", [id], () => when);
  if (result.gone.length) throw new ProposalError("Proposal not found: it was already approved or rejected.");
  if (result.failed.length) throw new ProposalError(result.failed[0].reason);
}

export async function reject(store: Store, id: string): Promise<void> {
  await decide(store, "reject", [id]);
}

export interface Decided {
  done: string[];
  // Already approved or rejected, or never existed.
  gone: string[];
  // Approving these together would touch the same preference twice; they need a decision one at a time.
  skipped: string[];
  // Could not be applied, with the reason; still pending.
  failed: { id: string; reason: string }[];
}

// Approves or rejects many proposals as one commit: every changed category file is written and every
// decided proposal closed together, so the number of store calls does not grow with the batch. The
// commit message still lists each proposal with its agent and evidence. `whenFor` is the scope each
// approval is saved with (by default the one it was proposed with).
export async function decide(
  store: Store,
  decision: "approve" | "reject",
  ids: string[],
  whenFor: (proposal: Proposal) => string | undefined = (p) => p.when,
): Promise<Decided> {
  const valid = [...new Set(ids)].filter((id) => /^q-[0-9a-f]{8}$/.test(id));
  // If something else commits in between, start over from the new version.
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = store.snapshot();
    const files = await snapshot.read(valid.map(pendingPath));
    const found = valid
      .map((id) => files.get(pendingPath(id)))
      .filter((content) => content != null)
      .map((content) => JSON.parse(content) as Proposal)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const result: Decided = { done: [], gone: [...new Set(ids)].filter((id) => !found.some((p) => p.id === id)), skipped: [], failed: [] };
    const changes: Change[] = [];
    const entries: Entry[] = [];

    if (decision === "reject") {
      for (const p of found) {
        result.done.push(p.id);
        entries.push({ title: `Close proposal ${p.id}: rejected`, details: [] });
      }
    } else {
      const chosen = found.filter((p) => {
        const conflict = conflictsWith(p, found).length > 0;
        if (conflict) result.skipped.push(p.id);
        return !conflict;
      });
      const categories = [...new Set(chosen.map((p) => p.category))];
      const current = await snapshot.read(categories.map(prefPath));
      const prefs = new Map(categories.map((c) => [c, parsePreferences(current.get(prefPath(c)) ?? "")] as const));
      const today = new Date().toISOString().slice(0, 10);
      for (const p of chosen) {
        const before = prefs.get(p.category)!;
        // Another approval (or a hand edit) removed the preference this one changes or removes.
        if (p.op !== "add" && !before.some((pref) => pref.id === p.replaces)) {
          result.failed.push({ id: p.id, reason: `The preference this proposal ${p.op === "remove" ? "removes" : "changes"} (${p.replaces}) is no longer in ${p.category}. Reject it.` });
          continue;
        }
        const when = whenFor(p);
        prefs.set(p.category, applyProposal(before, p, when, today));
        result.done.push(p.id);
        entries.push(approvalEntry(p, when));
      }
      for (const category of new Set(found.filter((p) => result.done.includes(p.id)).map((p) => p.category))) {
        changes.push({ path: prefPath(category), content: serializePreferences(category, prefs.get(category)!) });
      }
    }

    if (!result.done.length) return result;
    changes.push(...result.done.map((id) => ({ path: pendingPath(id), content: null })));
    if (await snapshot.commit(changes, commitMessage(decision, entries))) return result;
  }
  throw new ProposalError("Your preferences kept changing while saving; try again.");
}

// One entry of a commit message: a title line and the lines that explain it.
interface Entry {
  title: string;
  details: string[];
}

function approvalEntry(proposal: Proposal, when: string | undefined): Entry {
  return {
    title: `${proposal.op} ${proposal.category}: ${proposal.text ?? proposal.replaces}`,
    details: [`Proposed by ${proposal.by} (${proposal.id}), approved by the owner.`, ...(when ? [`Scope: ${when}`] : []), `Evidence: ${proposal.evidence}`],
  };
}

// A single decision reads as before; a batch gets a summary line and one list item per proposal.
function commitMessage(decision: "approve" | "reject", entries: Entry[]): string {
  if (entries.length === 1) {
    const [{ title, details }] = entries;
    return decision === "reject" ? title : [title, "", ...details].join("\n");
  }
  const items = entries.map(({ title, details }) => [`- ${title}`, ...details.map((d) => `  ${d}`)].join("\n"));
  return [`${decision === "approve" ? "Approve" : "Reject"} ${entries.length} proposals`, ...items].join("\n\n");
}
