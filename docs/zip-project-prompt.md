# Prompt: Zip this project to the parent folder

You are working in a git repository at a known path. Create a clean zip of the project to its parent folder using the steps below. **Two non-obvious gotchas to follow exactly** — skipping either one inflates the archive from ~2 MB to 8+ MB:

1. **Use `git repack -a -d`, not `git gc`.** `git gc` often leaves multiple `.pack` files in `.git/objects/pack/`, each ~1 MB. `git repack -a -d` consolidates them all into a single pack. This alone can shave 5–7 MB.

2. **Delete the existing zip before creating a new one.** Do *not* let zip update an existing archive — its update mode keeps stale `.pack` files inside the zip even after you repack the live `.git` directory. Always start from a fresh `rm -f`.

## Steps

1. Run `git repack -a -d`.

2. Run `rm -f ../<project-name>.zip`.

3. Create the zip from the parent directory, including the project folder, with these exclusions:
   - `<project>/node_modules/*`
   - `<project>/.env` (never include secrets)
   - `<project>/reports/*`
   - `<project>/dist/*`
   - `<project>/dist-ui/*`
   - `<project>/memory/*`
   - Any nested `node_modules` directories — find them with `find . -name node_modules -type d -not -path '*/node_modules/*/node_modules/*'` and add each one to the exclusion list.
   - Build outputs for any nested toolchains (e.g. Rust `target/`, Tauri `src-tauri/target/`).

4. Verify: run `ls -lh` on the resulting file. Expected size for a typical TypeScript/Node project with a packed `.git` is **1–3 MB**. If it's larger than 5 MB, run `unzip -l <zip> | sort -rn | head -20` to find the bloat — usually unexpected `node_modules`, `target/`, or unconsolidated `.pack` files.

Report the final path and size.
