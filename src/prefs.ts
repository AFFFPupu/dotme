// Preference files: one Markdown file per category, one preference per list item.
//
//   - Prefer Cloudflare over Supabase for personal projects.
//     id: p-3f9a · when: personal projects · since: 2026-10-29 · by: grok-bot

export const CATEGORIES = ["collab", "coding", "life"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Preference {
  id: string;
  text: string;
  when?: string;
  since: string;
  by: string;
}

export interface Proposal {
  id: string;
  category: Category;
  op: "add" | "change" | "remove";
  text?: string;
  when?: string;
  replaces?: string;
  evidence: string;
  by: string;
  createdAt: string;
}

export function parsePreferences(markdown: string): Preference[] {
  const prefs: Preference[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const item = lines[i].match(/^- (.+)$/);
    if (!item) continue;
    const fields: Record<string, string> = {};
    const meta = lines[i + 1]?.match(/^  (.+)$/);
    if (meta) {
      for (const part of meta[1].split(" · ")) {
        const [key, ...rest] = part.split(": ");
        fields[key.trim()] = rest.join(": ").trim();
      }
      i++;
    }
    prefs.push({ id: fields.id ?? "", text: item[1], when: fields.when || undefined, since: fields.since ?? "", by: fields.by ?? "" });
  }
  return prefs;
}

export function serializePreferences(category: Category, prefs: Preference[]): string {
  const items = prefs.map((p) => {
    const meta = [`id: ${p.id}`, p.when ? `when: ${p.when}` : null, `since: ${p.since}`, `by: ${p.by}`].filter(Boolean).join(" · ");
    return `- ${p.text}\n  ${meta}`;
  });
  return `# ${category}\n\n${items.join("\n")}\n`;
}

// Apply an approved proposal. `when` lets the owner scope it on the approval page.
export function applyProposal(prefs: Preference[], proposal: Proposal, when: string | undefined, today: string): Preference[] {
  if (proposal.op === "remove") return prefs.filter((p) => p.id !== proposal.replaces);
  const next: Preference = { id: proposal.replaces ?? newId("p"), text: proposal.text!, when, since: today, by: proposal.by };
  if (proposal.op === "change") return prefs.map((p) => (p.id === proposal.replaces ? next : p));
  return [...prefs, next];
}

export function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return `${prefix}-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// Single-line, bounded text so a proposal cannot smuggle extra list items or fields into a file.
export function cleanLine(value: string, max: number): string {
  return value.replace(/\s+/g, " ").replace(/ · /g, " - ").trim().slice(0, max);
}
