// Versioned eval set for the nightly real-LLM agent-realism suite.
// Changes require explanation in commit message. See spec §6.2.

export type Persona = 'maya' | 'alex' | 'jordan';

export interface CanonicalUtterance {
  id: string;          // stable: cu-maya-001
  persona: Persona;
  text: string;
  category: 'bookkeeping' | 'invoicing' | 'tax' | 'budget' | 'consultation' | 'onboarding';
  expectedSkill?: string;       // which skill SHOULD be invoked
  forbidden?: string[];          // strings the agent must NOT say
  required?: string[];           // strings the agent MUST include
  isMultiTurn?: boolean;         // if true, this is part of a thread
  threadId?: string;             // groups multi-turn utterances
}

// Populated in Task B.8.
export const CANONICAL: CanonicalUtterance[] = [];
