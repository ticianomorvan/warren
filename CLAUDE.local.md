# Warren: local notes (not in git)

## Vercel

Warren lives in the owner's personal Vercel account, which is not this machine's default login.

- Account `ticianomorvan-personal`, team `ticiano-morvans-projects-189f42b9` (Hobby), project `warren`.
- Its login is stored in `~/.vercel.personal`. Every Vercel command for Warren needs `-Q ~/.vercel.personal`:
  `vercel -Q ~/.vercel.personal --scope ticiano-morvans-projects-189f42b9 domains ls`
- In an interactive shell the alias `vercel-personal` adds the flag. Aliases do not expand in an agent's shell, so
  agents write the flag out.
- Plain `vercel` is the work login (PatagonAI). Never run a Warren command without the flag.
- If the login has expired, run `vercel login -Q ~/.vercel.personal` in the background and give the owner the
  device URL it prints.

## Addresses

- Production: `https://heywarren.app` (attached 2026-11-17). `https://warren-opal.vercel.app` still works, and the
  Resend webhook still points at it. Notices are Web Push only since 2026-11-18 (slice 3).
- Inbound mail will use the subdomain `in.heywarren.app`; not set up yet.

## Plans

- Current spec: `~/.claude/plans/warren-strategy-stack.md`.
- Older notes, research and reports: `~/Projects/personal/warren-notes` (its own git repo; on this Mac `~/projects/personal/warren` is the code repo).
