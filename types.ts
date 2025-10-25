
export enum AIPersona {
  Logos = 'Logos',
  Pathos = 'Pathos',
}

export enum DebatePhase {
  IDLE = 'IDLE',
  ANALYZING = 'ANALYZING',
  DEBATING = 'DEBATING',
  VOTING = 'VOTING',
  FINISHED = 'FINISHED',
}

export interface DebateMessage {
  persona: AIPersona | 'SYSTEM';
  text: string;
  isStreaming?: boolean;
}

export interface Votes {
  [AIPersona.Logos]: number;
  [AIPersona.Pathos]: number;
}
