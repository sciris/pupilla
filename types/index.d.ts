export type Confidence = 'high' | 'medium' | 'low'

/** One guess at the user's next prompt. */
export type Candidate = {
  text: string
  /** Probability as the predictor stated it. */
  raw: number
  /** Probability after recalibration against this user's history. */
  p: number
  confidence: Confidence
  /** Ids of the rules the predictor said it used. */
  rules: string[]
}

/** A prediction waiting for the user's actual reply. */
export type Pending = {
  turnId: string
  at: number
  project: string
  /** The agent output the prediction was made from (head and tail). */
  output: string
  /** The predictor's one-line read of the user's state. */
  state: string
  /** Every candidate, shown or not: hidden ones are still graded. */
  candidates: Candidate[]
  /** Calibrated probability mass of the candidates. */
  mass: number
  isShown: boolean
  /** Index of the candidate the user picked from the band, if any. */
  picked: number | null
}

export type Phase = 'idle' | 'predicting' | 'shown' | 'abstained' | 'off'

declare module 'claude-code' {
  interface PluginState {
    pupilla: { phase: Phase; pending: Pending | null }
  }
}
