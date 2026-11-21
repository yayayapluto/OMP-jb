# omp-jailbreak

OMP extension that keeps a local clone of the
[jailbreaks](https://github.com/togg53192-cmd/jailbreaks) profile repository in sync and appends the
Markdown profile matching the active model to the system prompt of every request. The profile is
re-resolved on each prompt, so switching models with `/model` changes the injected file on the very
next turn.

The profile repository is third-party content. The plugin only clones/fetches it into a cache under
`~/.omp/jailbreak-omp` and never modifies the upstream repo.

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Install](#install)
  - [Step 1 — Install git (prerequisite)](#step-1--install-git-prerequisite)
  - [Step 2 — Install the extension into OMP](#step-2--install-the-extension-into-omp)
  - [Step 3 — Verify it loaded](#step-3--verify-it-loaded)
- [Usage](#usage)
  - [How a session flows](#how-a-session-flows)
  - [`/jailbreak`](#jailbreak)
  - [`/jailbreak sync`](#jailbreak-sync)
  - [Reading the fields](#reading-the-fields)
  - [Common prompts](#common-prompts)
- [Configuration](#configuration)
- [What it reads and writes](#what-it-reads-and-writes)
- [Architecture](#architecture)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Security notes](#security-notes)
- [License](#license)

## Features

- **Per-prompt injection** — the profile is resolved and appended on every `before_agent_start`, not
  once per session. The base OMP system prompt is kept; the profile is an extra entry in the
  `systemPrompt` array.
- **Automatic repo sync** — on `session_start` the cache is cloned on first use, or fetched and
  fast-forwarded when it already exists. If the clone is missing or empty at prompt time, sync runs
  again before resolving.
- **Model matching without configuration** — the signature comes from the live session
  (`provider`, `id`, `name`, `identity.class`, `identity.family`, `identity.revision`). No model
  names are hard-coded.
- **Status indicator** — footer shows `🔓 Jailbreak ON` when a profile matched and
  `🔒 Jailbreak OFF` when none did; it is cleared on `session_shutdown`.
- **`/jailbreak` command** — prints the active model, the chosen file and its score, or forces a
  sync with `/jailbreak sync`.
- **mtime + size cache** — unchanged profile files are not re-read from disk.
- **Fail-soft git** — a network or git failure marks the sync `offline` and the previous clone keeps
  being used; the session is never aborted.

## Requirements

- OMP with extension support (`omp` CLI; verified against `omp/18.4.3`).
- `git` on `PATH`. The plugin shells out to `git` for clone, fetch, merge and reset.
- Network access to GitHub for the first clone and for each fetch that finds new commits.
- Bun 1.3+ only for running the test suite and for the single-file smoke test; the plugin itself runs
  inside OMP's own runtime.

## Install

### Step 1 — Install git (prerequisite)

The extension has nothing to load profiles from without `git`:

```bash
git --version
```

If that fails, install git first. Without it the very first sync reports
`Jailbreak repo sync failed: …` and no profile is ever found.

### Step 2 — Install the extension into OMP

Pick one.

**From the GitHub repository:**

```bash
omp plugin install github:yayayapluto/OMP-jb
```

**From a local checkout:**

```bash
git clone https://github.com/yayayapluto/OMP-jb.git
cd OMP-jb
omp plugin link .
```

`omp plugin link` registers the working tree so edits take effect on the next session.

**Load one file directly (quick test, nothing registered):**

```bash
omp --no-extensions -e ./extensions/jailbreak.ts -p "Reply with exactly: ok"
```

`package.json` declares `omp.extensions: ["./extensions/jailbreak.ts"]` and the matching
`pi.extensions` entry, so `omp plugin install` / `link` find the entry point automatically. There is
no marketplace catalog (`.omp-plugin/marketplace.json`) in this repo, so
`omp plugin marketplace add` does not work here — use `omp plugin install` with the GitHub target.

### Step 3 — Verify it loaded

```bash
omp plugin list
```

Look for `omp-jailbreak` in the list. Then, inside an OMP session, run:

```
/jailbreak
```

A profile line means the extension loaded, synced and matched:

```text
deepseek-v4.1-flash -> DeepSeek/deepseek-4-1.md (score 13)
```

You can also confirm the footer shows `🔓 Jailbreak ON` for a model that has a profile.

## Usage

### How a session flows

1. Session starts → `syncRepo()` runs in the background. First run clones
   `https://github.com/togg53192-cmd/jailbreaks.git` (`--depth 1 --single-branch`) into
   `<root>/repo`; later runs `git fetch --depth 1 origin HEAD` and fast-forward.
2. The profile list is rebuilt by walking `<root>/repo` up to four directory levels, collecting
   `*.md` files and skipping dotfiles and the repository's root `README.md`.
3. The active model is read from the session and scored against every profile path.
4. On each prompt, `before_agent_start` appends the winning file to the system prompt:

   ```text
   <jailbreak_profile model="DeepSeek V4.1 Flash" source="DeepSeek/deepseek-4-1.md">
   …Markdown profile…
   </jailbreak_profile>
   ```

5. If no model is active, or no profile clears the matching threshold, the prompt is sent unchanged
   and the footer shows `🔒 Jailbreak OFF`.

Nothing is written into the session or the profile repository; the clone is a cache owned by the
plugin.

### `/jailbreak`

```
/jailbreak
```

Syncs if needed, resolves the current model and notifies with the match and score, or with:

```text
deepseek-v3.2: no matching profile in 53 files
```

If the session has no active model at all, it notifies `No active model`.

### `/jailbreak sync`

```
/jailbreak sync
```

Clears the in-flight sync task, runs the sync again and notifies with the profile count and status:

```text
Jailbreak profiles: 53 (updated abc1234)
```

`current` means HEAD already matched `FETCH_HEAD`; `offline` means git failed and the old clone is
still in use.

### Reading the fields

| Field | Meaning | What to do |
| --- | --- | --- |
| `<model id> -> <relPath> (score N)` | A profile matched; `N` is the score from the table below | Nothing |
| `no matching profile in N files` | No path scored, or no path had a strong family token | Check upstream has a file for this family; run `/jailbreak sync` |
| `Jailbreak profiles: N (current …)` | HEAD already up to date | Nothing |
| `Jailbreak profiles: N (updated <sha>)` | Fast-forwarded to a new HEAD | Nothing |
| `Jailbreak profiles: N (cloned <sha>)` | First clone succeeded | Nothing |
| `Jailbreak profiles: N (offline)` | Fetch/clone failed | Check network and `git --version` |
| Footer `🔓 Jailbreak ON` | Injection is active for the current model | Nothing |
| Footer `🔒 Jailbreak OFF` | No model or no matching profile | Run `/jailbreak` to see which |

Scoring, as implemented in `resolveProfile()`:

| Component | Weight |
| --- | --- |
| Family token exact match, length ≥ 4 | +5 (counts as strong) |
| Family token exact match, length 2–3 | +2 |
| Prefix/substring match on a token of length ≥ 4 | +3 (counts as strong) |
| Each model version number also present in the filename | +1 |
| Full version run appears in the filename | +6 |
| Same major, different minor | +2 |
| File major newer than the model | −4 |
| File major older than the model | −2 |

A profile needs at least one strong family token; otherwise it is skipped entirely. Generic filename
words (`prompt`, `system`, `agents`, `jailbreak`, `model`, `opencode`, `policy`, …) are ignored so
they cannot outscore a family name. Highest score wins; ties go to the lexicographically smaller
path, so the result is deterministic.

### Common prompts

| You want | Type |
| --- | --- |
| See which profile this model uses | `/jailbreak` |
| Pull new profiles from upstream | `/jailbreak sync` |
| Check the extension is registered | `omp plugin list` |
| Test one file without installing | `omp --no-extensions -e ./extensions/jailbreak.ts -p "hi"` |

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMP_JAILBREAK_DIR` | `~/.omp/jailbreak-omp` | Cache root. The clone lives at `<root>/repo`. |

There is no config file and no model mapping to maintain; selection is fully automatic. Env vars
other than `OMP_JAILBREAK_DIR` are not read.

## What it reads and writes

| Path / variable | Access | Purpose |
| --- | --- | --- |
| `OMP_JAILBREAK_DIR` | read | Overrides the cache root |
| `~/.omp/jailbreak-omp/repo` | write (git clone/fetch/merge/reset) | Cached clone of the profile repo |
| `<root>/repo/**/*.md` | read | Profile candidates (depth ≤ 4, dotfiles and root `README.md` skipped) |
| `~/.omp/jailbreak-omp/repo/.git` | read | Presence decides clone vs. fetch |
| `git` on `PATH` | execute | All repository operations, 25 s timeout each |

No other files are touched. Git runs with `GIT_TERMINAL_PROMPT=0` and an empty `GIT_ASKPASS`, so it
never blocks waiting for credentials. No ports are opened and no credentials are read.

## Architecture

```text
OMP-jb/
├── extensions/
│   └── jailbreak.ts     # OMP handlers: session_start, before_agent_start, session_shutdown, /jailbreak
├── src/
│   └── core.ts          # repo URL, state dir, git sync, profile scan, resolver, cache, injection block
├── test/
│   ├── resolve.test.ts  # resolver ranking and family separation
│   └── sync.test.ts     # clone → update → current against a local bare origin
├── package.json         # name, scripts.test, omp.extensions entry
└── README.md
```

Prompt-time flow:

```text
before_agent_start
  ├─ profiles empty? → syncRepo() → listProfiles()
  ├─ model = ctx.models.current() ?? ctx.model   → none? footer OFF, return undefined
  ├─ resolveProfile(profiles, signature)          → no match? footer OFF, return undefined
  ├─ readProfile(root, relPath, cache)            → stat, reuse text if mtime+size unchanged
  └─ return { systemPrompt: [...existing, renderInjection(...)] }
```

Sync flow:

```text
syncRepo(dir)
  ├─ no <dir>/.git  → git clone --depth 1 --single-branch <REPO_URL> <dir>   → "cloned"
  └─ has .git
       ├─ git rev-parse HEAD
       ├─ git fetch --depth 1 origin HEAD
       ├─ HEAD == FETCH_HEAD ?                                                → "current"
       ├─ git merge --ff-only FETCH_HEAD  (fallback: git reset --hard FETCH_HEAD) → "updated"
       └─ any failure                                                         → "offline"
```

## Development

```bash
bun test
```

Current result: 7 tests across 2 files, 11 assertions (`resolve.test.ts`, `sync.test.ts`). The sync
test builds a throwaway bare repository in the OS temp dir and exercises clone, update and
already-current; it does not need the real upstream repo.

Loading the extension in a real session:

```bash
omp --no-extensions -e ./extensions/jailbreak.ts -p "Reply with exactly: ok"
```

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Notification `Jailbreak repo sync failed: …` | `git` missing, or no network to GitHub | `git --version`; `git ls-remote https://github.com/togg53192-cmd/jailbreaks.git HEAD` |
| `/jailbreak` says `no matching profile in N files` | Upstream has no file for that model family, or the family token is too short/weak to score | `/jailbreak sync`, then check upstream for a matching family |
| `/jailbreak` says `no matching profile in 0 files` | Clone missing or unreadable | Inspect `~/.omp/jailbreak-omp/repo`; delete the cache dir to force a fresh clone |
| `/jailbreak` says `No active model` | Session has no model selected | Select a model, then retry |
| Footer stays `🔒 Jailbreak OFF` for a model that has a profile | Profile list not loaded yet, or family token mismatch | Run `/jailbreak` to see the score and profile count |
| Profile edits are not picked up | Injection uses the cached clone, not your working copy | `/jailbreak sync`; the `mtime`+`size` cache then re-reads the file |
| Large token usage per request | One whole profile file is appended to every prompt by design | Use a smaller upstream profile; the plugin does not truncate |
| Extension not loaded | Not registered in OMP | `omp plugin list`, then `omp plugin doctor` |

## Security notes

- The clone is plugin-owned cache. `git reset --hard` is only used on that cache when upstream
  rewrites history, never on a user working tree.
- Profile Markdown is injected verbatim into the system prompt. Upstream content is third-party and
  therefore untrusted instruction text; review profiles before relying on them.
- Git commands use a fixed URL (`https://github.com/togg53192-cmd/jailbreaks.git`), fixed arguments
  and no shell interpolation. `GIT_TERMINAL_PROMPT=0` prevents interactive credential prompts.
- The plugin opens no listener and reads no credentials, cookies or model configuration.

## License

MIT, as declared in `package.json`. Not affiliated with the upstream profile repository.
