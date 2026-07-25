---
name: easyaiflow-git-publishing
created: 2026-07-25
updated: 2026-07-25
source: user-request
scope: project
project: EasyAIFlow
project_root: D:\AIAgent\EasyAIFlow
---

# EasyAIFlow Git Publishing

- For commits and pushes in EasyAIFlow, use local `git` commands directly.
- Do not require or use GitHub CLI, the GitHub app, or GitHub plugins unless the user explicitly asks for them.
- When the user says `push`, inspect and stage only the intended files, commit them, and push the current branch with `git`.
- Preserve unrelated local files and changes, including `.tmp-run/`.
