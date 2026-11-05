import { describe, expect, it } from "vitest";
import { resultNotice } from "../src/pages";

const links = { file: (path: string) => `https://github.com/octo/data/blob/HEAD/${path}`, commit: (sha: string) => `https://github.com/octo/data/commit/${sha}` };
const sha = "0123456789abcdef0123456789abcdef01234567";

describe("result notice", () => {
  it("names and links where approved proposals were saved", () => {
    const notice = resultNotice(new URLSearchParams([["approved", "3"], ["saved", "coding"], ["saved", "life"], ["commit", sha]]), links);
    expect(notice).toContain("Approved 3 proposals.");
    expect(notice).toContain(`Saved in <a href="https://github.com/octo/data/blob/HEAD/coding.md">coding.md</a> and <a href="https://github.com/octo/data/blob/HEAD/life.md">life.md</a> in your preferences repo on GitHub.`);
    expect(notice).toContain(`<a href="https://github.com/octo/data/commit/${sha}">See the commit</a>`);
  });

  it("names the file without links when the store has none", () => {
    const notice = resultNotice(new URLSearchParams([["approved", "1"], ["saved", "coding"]]));
    expect(notice).toContain("Approved 1 proposal. Saved in <code>coding.md</code>.");
    expect(notice).not.toContain("<a ");
  });

  it("ignores category names and shas that are not valid", () => {
    const notice = resultNotice(new URLSearchParams([["approved", "1"], ["saved", "../x"], ["saved", '"><script>'], ["commit", "javascript:x"]]), links);
    expect(notice).toContain("Approved 1 proposal.</p>");
    expect(notice).not.toContain("Saved in");
    const noCommit = resultNotice(new URLSearchParams([["approved", "1"], ["saved", "coding"], ["commit", "nope"]]), links);
    expect(noCommit).toContain("coding.md");
    expect(noCommit).not.toContain("See the commit");
  });
});
