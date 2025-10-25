
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
