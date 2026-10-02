# pupilla

A Claude Code mod that learns to predict your next prompt. It works like a reverse LLM: given the agent's output, it predicts your input. After each turn it offers up to five guesses above the prompt, each with a confidence (high, medium or low; at most one high). Press a digit to put a guess in the prompt box, then Enter to send it (or edit it first). If one guess is high, it is also the dim suggestion in the empty prompt, and Tab takes it. When it has no real idea, it shows nothing.

Every reply you send, typed or picked, is a training example. The goal is that, over time, you mostly pick rather than type.

## How it learns

No published framework does this directly: one user, online, a text memory, a top-5 set with calibrated confidence and abstention. pupilla combines the parts that fit:

| Part | Rule | Source |
| --- | --- | --- |
| Memory | Raw (agent output → your reply) episodes are the source of truth (last 400). A short profile and a bank of at most 40 plain-language rules ("when the agent asks whether to commit, the user says 'commit this'") are derived from them in batches, never rewritten every turn. | MemGPT (Packer et al. 2023); Zhang et al. 2026 on memories degrading when an LLM re-summarizes them every turn |
| Prediction | The predictor first infers your state (satisfied, blocked, wants the next step), then writes up to 5 distinct candidates in your own style, taken from past replies, each with a stated probability and the rules it used. The probabilities are mutually exclusive, and the remainder is "something else". | HumanLM (Wu et al. 2026); Naous et al. 2025, ICLR 2026, on assistant models being poor user simulators; Tian et al. 2023 on verbalized confidence |
| Rule credit | Each rule is a discounted Beta(a, b): a candidate citing it scores y ∈ {0, ½, 1}, then a ← 1 + γ(a−1) + y and b ← 1 + γ(b−1) + (1−y), with γ = 0.97, so old evidence fades and the bank tracks drift. Rules go into the prompt by upper confidence bound (UCB), so new rules get tried. Rules that keep failing are pruned. | HypoGeniC (Zhou et al. 2024); discounted Thompson / UCB bandits |
| Rule induction | Misses go into a miss bank, each with the grader's one-line note on what the guess failed to anticipate. After 5 misses or 25 turns, a reflector model proposes at most 4 ADD / EDIT / DELETE edits, checked against recent replies, and rewrites the profile. | ExpeL (Zhao et al. 2024); Reflexion (Shinn et al. 2023); CIPHER (Gao et al. 2024); Hypothesis Search (Wang et al. 2024) |
| Calibration | Stated probabilities are mapped to observed hit rates through 10 discounted reliability bins, pulled toward the stated value while a bin has little data. Labels: high ≥ 50% (top guess only), medium ≥ 20%, low below that. | standard histogram binning |
| Abstention | A set is shown only if its calibrated total ≥ τ. τ moves online toward a 50% hit rate for shown sets: a shown miss raises it, a shown hit lowers it, and a hidden set that would have hit lowers it too. | Adaptive conformal inference (Gibbs & Candès 2021); Mozannar et al. 2024 on when to show a suggestion |
| Grading | An exact match costs nothing. Otherwise a small model scores each guess: 1 = same request, ½ = same intent but different specifics, 0 = different. Hidden guesses are graded too, so abstaining still teaches calibration. | Brier score (Gneiting & Raftery 2007) as the running metric |
| Outcome | Every reply to a shown set is classed as sent a guess as-is, took one and edited it, or wrote your own. A guess counts as taken if you picked it with a digit or the prompt box ever held it exactly (Tab, or typed out); a reply that extends the high guess also counts as taken then edited. A taken guess is credited at least ½, since it was your best starting point. Edited picks go to the reflector side by side (taken vs. sent), because the edit shows exactly what the guess got wrong. | CIPHER (Gao et al. 2024): learning from user edits |
| Style prior | Prompts you've sent more than once are listed for the predictor as cheap, likely candidates. | Smart Reply (Kannan et al. 2016) |

Model calls per turn: one prediction, plus one grading call unless the reply was an exact pick. Reflection runs occasionally.

## Using it

- `/pupilla`: how often you sent a guess as-is, edited one, or wrote your own; hit rates, calibration table, Brier score, show threshold; the profile; and the rules with their match rates.
- `/pupilla off` / `/pupilla on`: stop or resume predicting (learning stops too).
- `/pupilla reflect`: run a reflection now.
- `/pupilla forget yes`: erase everything learned.
- The status line shows `pupilla <as-is %> as-is · <edited %> edited · n=<turns with guesses shown>`.

Settings (`/config`, under pupilla):

- **predictor**: `fork` (default) asks the session's own model, over the session's own transcript served from the prompt cache, so it sees the full context. `haiku`, `sonnet` and `opus` use a standalone call that sees only the memory and the last output: cheaper, but it knows less.
- **grader**: `haiku` (default) or `sonnet`.
- **reflector**: `sonnet` (default), `haiku` or `opus`.

Memory lives in the plugin's store (`$.store`, key `memory`), shared across projects and sessions, so it learns you, not one repo.

## Layout

- `hooks/register.tsx`: the hooks (turn end → predict, prompt submit → grade, the band, the command)
- `hooks/learn.ts`: memory and the update rules, with no engine calls
- `hooks/prompts.ts`: the predict, grade and reflect prompts
- `types/index.d.ts`: session state contract
- `tests/`: unit tests of the rules, and an end-to-end loop on the terminal and desktop surfaces. Run them with `claude plugin test .`.

## Running it

From a local clone: `claude --plugin-dir /path/to/pupilla`, or put the path in `CLAUDE_CODE_PLUGIN_DIRS`.

As an installed plugin, since the repo is its own marketplace: `claude plugin marketplace add /path/to/pupilla` (or the GitHub `owner/repo`), then `claude plugin install pupilla@pupilla`.

## License

MIT. See [LICENSE](LICENSE).
