
export enum AIPersona {
  Logos = 'Logos',
  Pathos = 'Pathos',
}

export enum DebatePhase {
  IDLE = 'IDLE',
  ANALYZING = 'ANALYZING',
  DEBATING = 'DEBATING',
  VOTING = 'VOTING',
  SCORING = 'SCORING',
  FINISHED = 'FINISHED',
}

export interface Source {
  uri: string;
  title: string;
}

export interface DebateMessage {
  persona: AIPersona | 'SYSTEM';
  text: string;
  isStreaming?: boolean;
  sources?: Source[];
}

export interface Votes {
  [AIPersona.Logos]: number;
  [AIPersona.Pathos]: number;
}

export interface ArgumentComparison {
  topic: string;
  logosStance: string;
  pathosStance: string;
}

export interface Score {
  criteria: string;
  score: number;
  notes: string;
}

export interface DebateScore {
  [AIPersona.Logos]: Score[];
  [AIPersona.Pathos]: Score[];
  finalScores: {
    [AIPersona.Logos]: number;
    [AIPersona.Pathos]: number;
  };
  winner: AIPersona | 'TIE';
}
