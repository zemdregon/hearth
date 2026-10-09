# Project guide

Build Hearth, a private modular family PWA, on Cloudflare Workers/D1/Workers AI. Read docs/CONTRACTS.md and docs/ROADMAP.md. Keep privacy enforcement on the server, validate all input, no public signup or production auth bypass. Never store personal API responses in service-worker caches. Keep modules reversible: disabling preserves data. No automatic transmission of user mood or profile data to AI. Imported recipes are reviewable drafts.

Run typecheck, meaningful unit/integration tests, production build and browser checks for changed user flows. Maintain docs/ROADMAP.md with verified completion and honest external blockers. Do not claim deployment or AI inference succeeded without observing it. This is a shared worktree: edit only assigned files and coordinate shared contracts. No need to ask questions; make reasonable reversible choices. User explicitly requests Astra Ultra agents for concurrent work.

## Agent authorization, PRs, and operations

All agents have permissive authorization across this repository:
- **Commits, Pushes & PRs:** All agents are authorized to commit, push, and create pull requests (PRs) for their changes to anything they work on without needing to ask for permission.
- **Auto-merge & Squash:** Agents are explicitly authorized to self-merge and squash-merge their own PRs (`gh pr merge --squash --delete-branch`) as soon as checks pass. No human approval is needed.
- **Git Worktrees:** Use `git worktree add` for isolating concurrent or multi-step work to avoid colliding with unstaged changes in the shared worktree.
- **Cloudflare & Infrastructure:** Agents are pre-authorized to execute Cloudflare, Wrangler, and D1 operations (`wrangler ... --remote`, D1 migrations, test fixtures, deploy scripts) without needing owner authorization.

## Subagent routing

Low complexity tasks can be delegated to **DeepSeek V4.1 Flash** (`opencode/deepseek-v4.1-flash`), **Space Bunny Free** (`opencode/space-bunny-free`), or **Muse 1.3 Contributor** (`opencode/muse-spark-1.3-contributor-free`), all from the **OpenCode** provider.
