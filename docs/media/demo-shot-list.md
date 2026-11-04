# Demo video shot list

A 60 to 90 second screen recording of the full loop: Claude Code proposes a
preference, you approve it on your phone with a passkey, and a new Codex
session already follows it. Record it for real; no mockups or edited output.

## Before recording

- Use an install with demo data only (the [`seed/`](../../seed/) files), not
  your own preferences: the Codex session shows the hook output on screen.
  A fresh install from [INSTALL.md](../../INSTALL.md) works well for this.
- Make sure the data repo has no package manager preference yet.
- Have Claude Code reply with a link instead of its dialog, so the approval
  happens on the phone: connect it again with **Approve in this app's own
  dialog** unticked on the consent page. (Or press Decline in the dialog,
  which also falls back to the link.) Turn it back on after recording.
- Phone: sign out of `<url>/approve` so the passkey prompt appears. Have the
  approval link ready to open on the phone, for example through Handoff or
  by opening `<url>/approve`, which lists pending proposals.
- A small Node project folder with a `package.json` and no lockfile, open in
  both Claude Code and Codex.
- Terminal: large font (18 pt or more), a plain theme, nothing personal in
  the prompt, the window title or the tab bar. Turn on Do Not Disturb.
- Phone: screen record at the same time, or mirror it with QuickTime, so
  both can be cut together.

## Shots

| # | Time | Screen | What happens | Caption |
|---|---|---|---|---|
| 1 | 0:00-0:05 | Title card | dotme logo and the tagline. | Dotfiles for your AI agents |
| 2 | 0:05-0:15 | Claude Code | Type: "Use pnpm in my projects, never npm. Remember that." | Tell one agent |
| 3 | 0:15-0:27 | Claude Code | The agent asks to save it, you say yes, it calls `propose_change`. Hold on the tool call so the category, the text and the evidence are readable. | It proposes, with evidence |
| 4 | 0:27-0:32 | Claude Code | The reply says "pending approval" with a link. | Nothing is saved yet |
| 5 | 0:32-0:47 | Phone | Open the link. Sign in with Face ID (the passkey prompt). The proposal shows agent `claude-code`, the change and the evidence. Tap Approve. Dot celebrates. | You approve, on your phone |
| 6 | 0:47-0:55 | Browser | The data repo on GitHub: the new commit, with the agent's name and the evidence in its message. Optional; cut it if the video runs long. | Every change is a commit |
| 7 | 0:55-1:10 | Codex | Start a new session in the project. The first lines show dotme's preferences, including the pnpm line. | A different agent, a new session |
| 8 | 1:10-1:22 | Codex | Type: "Add zod to this project." Codex runs `pnpm add zod`. | It already knows |
| 9 | 1:22-1:30 | End card | Repo URL and "Self-hosted on Cloudflare's free plan". | github.com/AFFFPupu/dotme |

## Notes

- Keep it under 90 seconds; cut shot 6 first, then shorten shot 7.
- No voiceover is needed; the captions carry it. If you add one, keep it to
  what is on screen.
- Do not speed up the approval in shot 5: the passkey prompt is the point.
- Export an `.mp4` (H.264, 1920x1080 or 1280x720) for the README, and a
  short GIF of shots 5 to 8 if you want one in place of `hero.gif`.
- If a take shows a real token, a personal preference or a private repo,
  record it again rather than blurring.
