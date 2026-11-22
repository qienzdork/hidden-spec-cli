[![competition](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/qienzdork/hidden-spec-cli/rank.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/qienzdork/hidden-spec-cli/reward.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)

# mend

`mend` is one patch tool for every AI edit format. It applies AI-written
edits to a tree of text files, all or nothing: every file is changed or
nothing is.

It reads four formats to one contract (`SPEC.md` in the kit): unified diffs
(often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and
JSON text-editor tool calls. Edits name their lines at the first of three
matching tiers — exact, trailing-whitespace-insensitive, then
leading-and-trailing-whitespace-insensitive with re-indentation — so a
model's drifted whitespace or indentation still lands, and a `--strict`
run matches exactly.

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a patch file, or `-` / absent to read the patch from standard
input. `--check` does everything but write. Exit 0 lists what changed,
exit 1 lists the edits that failed, exit 2 is a usage, missing-patch,
format or parse error. Node 22, standard library only, no network.
