// COPY of the fields the zone match engine reads from the web's src/lib/domain/gameQuestion.ts.
export interface GameQuestion {
  id: string;
  prompt: string;
  options: string[];
  correctIndex: number;
  categoryId?: string;
  categoryName?: string;
  difficulty?: string;
}
