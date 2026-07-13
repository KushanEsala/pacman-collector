export type Difficulty = "Easy" | "Medium" | "Hard";
export type Feedback = "too_difficult" | "balanced" | "too_easy" | "skipped";

export interface SessionRecord {
  id: string;
  participant_id: string;
  initial_difficulty: Difficulty;
  rounds_planned: number;
  consent_version: string;
  client_version: string;
  source_dataset: "web_pacman";
}

export interface RoundRecord {
  id: string;
  session_id: string;
  participant_id: string;
  level: number;
  difficulty: Difficulty;
  difficulty_factor: number;
  outcome: "completed" | "failed" | "abandoned";
  reaction_time: number;
  completion_time: number;
  score: number;
  retries: number;
  accuracy: number;
  errors: number;
  actions_taken: number;
  elapsed_time_ratio: number;
  progress_rate: number;
  score_rate: number;
  action_rate: number;
  idle_ratio: number;
  direction_change_rate: number;
  target_adjustment: -1 | 0 | 1;
  player_feedback: Feedback;
  label_source: "player_feedback" | "implicit_real_outcome";
  label_confidence: number;
  validation_status: "pending_validation";
  source_dataset: "web_pacman";
  client_version: string;
}

export interface SessionFeedbackRecord {
  id: string;
  session_id: string;
  participant_id: string;
  message: string;
  client_version: string;
  source_dataset: "web_pacman";
}

export type QueuedRecord =
  | { kind: "session"; payload: SessionRecord }
  | { kind: "round"; payload: RoundRecord }
  | { kind: "feedback"; payload: SessionFeedbackRecord };
