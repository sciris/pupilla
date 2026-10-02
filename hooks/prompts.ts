// The three model prompts: predict, grade, reflect.

import type { Candidate, Pending } from '../types'
import type { Episode, Memory } from './learn'
import { describeRule, excerpt, frequentPrompts, selectExamples, selectRules } from './learn'

function quote(text: string): string {
  return JSON.stringify(text)
}

function examplesBlock(episodes: Episode[]): string {
  if (episodes.length === 0) {
    return '(none yet)'
  }
  return episodes.map(ep => `- agent ended with: ${quote(excerpt(ep.output, 300))}\n  user replied: ${quote(ep.actual.slice(0, 400))}`).join('\n')
}

export function predictPrompt(mem: Memory, output: string, isFork: boolean): string {
  const rules = selectRules(mem)
  const frequent = frequentPrompts(mem)
  return `You are pupilla, a side process that predicts what the user will type next. Do not continue the task, call tools or address the user. Only predict.

The agent (you, in the transcript${isFork ? ' above' : ''}) just finished its turn with this output:
<agent_output>
${excerpt(output, 4000)}
</agent_output>

What has been learned about this user so far:
<profile>
${mem.profile || '(nothing yet)'}
</profile>
<rules>
${rules.length > 0 ? rules.map(describeRule).join('\n') : '(none yet)'}
</rules>
The percentage on each rule is how often predictions built on it have matched.
<frequent_prompts>
${frequent.length > 0 ? frequent.map(f => `${f.count}x ${quote(f.text)}`).join('\n') : '(none yet)'}
</frequent_prompts>
<examples>
${examplesBlock(selectExamples(mem, output))}
</examples>

First infer the user's likely state in one line: satisfied, blocked, wants the next step, about to correct something, about to wrap up, and why. Then list up to 5 distinct candidates for the user's very next message.

- Write each candidate exactly as this user would type it: their length, casing, punctuation and terseness, taken from the examples, not your own style. Users write short, plain messages.
- Make the candidates genuinely different from each other (different intents), not rephrasings.
- p is the probability that the user's actual next message would be equivalent to the candidate (they could have sent it instead and gotten the same result). The candidates are mutually exclusive, so the p values sum to at most 1; the remainder is "something else".
- Be honest about uncertainty. If you have little basis, give fewer candidates with low p, or none. An empty list is a fine answer.
- In rules, cite the ids of any rules that informed a candidate.

Reply with only JSON, no prose:
{"state": "...", "candidates": [{"text": "...", "p": 0.3, "rules": ["r4"]}]}`
}

export function gradePrompt(pending: Pending, actual: string): string {
  const list = pending.candidates.map((c: Candidate, i: number) => `${i + 1}. ${quote(c.text)}${i === pending.picked ? ' (the user took this one and edited it before sending)' : ''}`).join('\n')
  return `An assistant predicted the user's next message. Grade each prediction against what the user actually sent.

Agent's last output (excerpt):
<agent_output>
${excerpt(pending.output, 1500)}
</agent_output>

Predictions:
${list}

Actual message:
${quote(actual.slice(0, 3000))}

Score each prediction:
- 1: the user could have sent the prediction instead and gotten essentially the same result.
- 0.5: same intent or direction, but materially different specifics.
- 0: a different request.

Also write one line on what the predictions failed to anticipate about the actual message (empty string if one scored 1).

Reply with only JSON: {"scores": [1, 0, 0.5], "note": "..."}`
}

export function reflectPrompt(mem: Memory): string {
  const missed = new Set(mem.misses)
  const misses = mem.episodes.filter(ep => missed.has(ep.at))
  const hits = mem.episodes.filter(ep => ep.bestScore >= 1).slice(-8)
  const recent = mem.episodes.slice(-30)
  const edited = mem.episodes.filter(ep => ep.outcome === 'edited').slice(-8)
  const show = (ep: Episode) =>
    `- agent ended with: ${quote(excerpt(ep.output, 350))}\n  user replied: ${quote(ep.actual.slice(0, 300))}\n  best guess: ${quote(ep.best)} (score ${ep.bestScore})${ep.note ? `\n  missed: ${ep.note}` : ''}`
  const showEdit = (ep: Episode) => `- took: ${quote(ep.taken)}\n  sent: ${quote(ep.actual.slice(0, 300))}`
  return `You maintain the memory of a system that predicts a user's next message to a coding agent, given the agent's last output. Improve the memory from the evidence below.

Current profile:
<profile>
${mem.profile || '(empty)'}
</profile>

Current rules (id, match rate when used, uses, text):
<rules>
${mem.rules.length > 0 ? mem.rules.map(describeRule).join('\n') : '(none)'}
</rules>

Recent misses:
<misses>
${misses.length > 0 ? misses.map(show).join('\n') : '(none)'}
</misses>

Recent hits:
<hits>
${hits.length > 0 ? hits.map(show).join('\n') : '(none)'}
</hits>

Guesses the user took and then edited before sending (the edit shows exactly what the guess got wrong):
<edits>
${edited.length > 0 ? edited.map(showEdit).join('\n') : '(none)'}
</edits>

All recent replies, oldest first (for style and frequency):
<recent>
${recent.map(ep => `- ${quote(ep.actual.slice(0, 200))}`).join('\n')}
</recent>

Propose edits to the rules:
- A rule is a specific, testable regularity of the form "when the agent's output <situation>, the user tends to reply <kind of message, with wording if it recurs>". Rules must generalize across tasks, so no one-off details.
- add: a new rule that would have predicted one or more misses, or would have avoided a recurring edit. Check it against the recent replies before adding it, and do not add it if it contradicts them.
- edit: sharpen a rule whose wording is close but wrong.
- delete: a rule that is redundant, or that the evidence contradicts.
- Make at most 4 edits. Making none is fine.

Then rewrite the profile: at most 120 words on how this user writes (length, casing, tone) and what they usually want next. Use only facts in the evidence.

Reply with only JSON:
{"edits": [{"op": "add", "text": "..."}, {"op": "edit", "id": "r3", "text": "..."}, {"op": "delete", "id": "r7"}], "profile": "..."}`
}
