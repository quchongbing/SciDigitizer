# Public release workflow

SciDigitizer keeps the private Gitea development history separate from the clean public GitHub history:

- `SciDitizer` is the development repository whose `origin` is the local Gitea server.
- The sibling `SciDigitizer-public` repository publishes audited snapshots to `quchongbing/SciDigitizer` on GitHub.

Never add the GitHub repository as a remote of the development repository or push its `main` branch to GitHub. The development history may contain removed assets and old author metadata.

## Publish an update

Commit, test, and push the development repository to Gitea first. From its root, run:

```bash
npm run public:sync
```

The command stops unless both worktrees are clean, the destination is on `main`, and its `origin` is the expected GitHub repository. It copies only files tracked by the current Gitea commit, scans the snapshot for local paths and private metadata, and never copies `.git` history.

Review and publish from the public repository:

```bash
cd ../SciDigitizer-public
git status --short
git diff --check
git diff
git add -A
git diff --cached --check
git commit -m "Describe the public update"
git push
```

The public repository must use the GitHub-provided `noreply` author address. The synchronization command deliberately does not commit or push, so every public change remains reviewable.
