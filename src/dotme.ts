// Reads, proposals and approvals over the store. Agents can only propose;
// only the owner, on the approval page, turns a proposal into a commit.

import { applyProposal, DEFAULT_CATEGORIES, isCategoryName, newId, parsePreferences, serializePreferences } from "./prefs";
import type { Category, Preference, Proposal } from "./prefs";
import type { Store } from "./store";

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
export async function listPending(store: Store, categories?: readonly Category[]): Promise<Proposal[]> {
  const paths = await store.list("pending");
  const proposals = await Promise.all(paths.map(async (path) => JSON.parse((await store.read(path))!.content) as Proposal));
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
  const found = await getProposal(store, id);
  if (!found) throw new ProposalError("Proposal not found: it was already approved or rejected.");
  await approveFound(store, found, when);
}

// Approves a proposal already read with getProposal, so a batch reads each proposal once.
export async function approveFound(store: Store, found: { proposal: Proposal; sha: string }, when: string | undefined): Promise<void> {
  const { proposal, sha } = found;
  const id = proposal.id;
  const path = prefPath(proposal.category);
  const today = new Date().toISOString().slice(0, 10);
  const message = [
    `${proposal.op} ${proposal.category}: ${proposal.text ?? proposal.replaces}`,
    "",
    `Proposed by ${proposal.by} (${proposal.id}), approved by the owner.`,
    when ? `Scope: ${when}` : null,
    `Evidence: ${proposal.evidence}`,
  ].filter((line) => line !== null).join("\n");

  // Conditional write: if another approval changed the file in between, re-read and re-apply.
  for (let attempt = 0; attempt < 3; attempt++) {
    const file = await store.read(path);
    const current = file ? parsePreferences(file.content) : [];
    // Another approval (or a hand edit) removed the preference this one changes or removes.
    if (proposal.op !== "add" && !current.some((p) => p.id === proposal.replaces)) {
      throw new ProposalError(`The preference this proposal ${proposal.op === "remove" ? "removes" : "changes"} (${proposal.replaces}) is no longer in ${proposal.category}. Reject it.`);
    }
    const next = applyProposal(current, proposal, when, today);
    if (await store.write(path, serializePreferences(proposal.category, next), file?.sha ?? null, message)) {
      await store.remove(pendingPath(id), sha, `Close proposal ${id}: approved`);
      return;
    }
  }
  throw new ProposalError(`${proposal.category} kept changing while saving; try again.`);
}

export async function reject(store: Store, id: string): Promise<void> {
  const found = await getProposal(store, id);
  if (found) await rejectFound(store, found);
}

export async function rejectFound(store: Store, found: { proposal: Proposal; sha: string }): Promise<void> {
  await store.remove(pendingPath(found.proposal.id), found.sha, `Close proposal ${found.proposal.id}: rejected`);
}
