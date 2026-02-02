export type MatchMode = 'friendly' | 'ranked';
export type LobbyStatus = 'waiting' | 'active' | 'closed';

export type GameStage =
  | 'idle'
  | 'matchmaking'
  | 'categoryBlocking'
  | 'showdown'
  | 'roundIntro'
  | 'playing'
  | 'roundResult'
  | 'roundTransition'
  | 'finalResults';

export interface LobbyMember {
  userId: string;
  username: string;
  avatarUrl: string | null;
  isReady: boolean;
  isHost: boolean;
}

export interface LobbyState {
  lobbyId: string;
  mode: MatchMode;
  status: LobbyStatus;
  inviteCode: string | null;
  hostUserId: string;
  members: LobbyMember[];
}

export interface DraftCategory {
  id: string;
  name: string;
  icon: string | null;
}

export interface DraftState {
  lobbyId: string;
  categories: DraftCategory[];
  turnUserId: string;
}

export interface OpponentInfo {
  id: string;
  username: string;
  avatarUrl: string | null;
}

export interface GameQuestionDTO {
  id: string;
  prompt: string;
  options: string[];
  categoryId?: string;
  categoryName?: string;
  difficulty?: string;
  explanation?: string | null;
}

export interface MatchStartPayload {
  matchId: string;
  opponent: OpponentInfo;
}

export interface MatchQuestionPayload {
  matchId: string;
  qIndex: number;
  total: number;
  question: GameQuestionDTO;
  deadlineAt: string;
}

export interface MatchOpponentAnsweredPayload {
  matchId: string;
  qIndex: number;
}

export interface MatchAnswerAckPayload {
  matchId: string;
  qIndex: number;
  selectedIndex: number | null;
  isCorrect: boolean;
  correctIndex: number;
  myTotalPoints: number;
  oppTotalPoints: number;
  oppAnswered: boolean;
}

export interface MatchRoundResultPlayer {
  selectedIndex: number | null;
  isCorrect: boolean;
  timeMs: number;
  pointsEarned: number;
  totalPoints: number;
}

export interface MatchRoundResultPayload {
  matchId: string;
  qIndex: number;
  correctIndex: number;
  players: Record<string, MatchRoundResultPlayer>;
}

export interface MatchFinalResultPlayer {
  totalPoints: number;
  correctAnswers: number;
  avgTimeMs: number | null;
}

export interface MatchFinalResultsPayload {
  matchId: string;
  winnerId: string | null;
  players: Record<string, MatchFinalResultPlayer>;
  durationMs: number;
}

export interface ClientToServerEvents {
  'lobby:create': (data: { mode: MatchMode }) => void;
  'lobby:join_by_code': (data: { inviteCode: string }) => void;
  'lobby:leave': () => void;
  'lobby:ready': (data: { ready: boolean }) => void;
  'draft:ban': (data: { categoryId: string }) => void;
  'match:answer': (data: { matchId: string; qIndex: number; selectedIndex: number | null; timeMs: number }) => void;
}

export interface ServerToClientEvents {
  'lobby:state': (data: LobbyState) => void;
  'draft:start': (data: DraftState) => void;
  'draft:banned': (data: { actorId: string; categoryId: string }) => void;
  'draft:complete': (data: { allowedCategoryIds: [string, string] }) => void;
  'match:start': (data: MatchStartPayload) => void;
  'match:question': (data: MatchQuestionPayload) => void;
  'match:opponent_answered': (data: MatchOpponentAnsweredPayload) => void;
  'match:answer_ack': (data: MatchAnswerAckPayload) => void;
  'match:round_result': (data: MatchRoundResultPayload) => void;
  'match:final_results': (data: MatchFinalResultsPayload) => void;
}
