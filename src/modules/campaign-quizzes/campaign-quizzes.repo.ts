import { sql } from '../../db/index.js';

export interface CampaignQuizRow {
  slug: string;
  title: string;
}

export interface CampaignQuizQuestionRow {
  id: string;
  display_order: number;
  difficulty: 'easy' | 'medium' | 'hard';
  prompt: unknown;
  explanation: unknown;
  payload: unknown;
}

export interface CampaignQuizRatingRow {
  average: number | string | null;
  count: number;
}

export const campaignQuizzesRepo = {
  async getPublishedQuiz(slug: string): Promise<CampaignQuizRow | null> {
    const [quiz] = await sql<CampaignQuizRow[]>`
      SELECT slug, title
      FROM campaign_quizzes
      WHERE slug = ${slug}
        AND status = 'published'
      LIMIT 1
    `;
    return quiz ?? null;
  },

  async getPublishedQuestions(slug: string): Promise<CampaignQuizQuestionRow[]> {
    return sql<CampaignQuizQuestionRow[]>`
      SELECT
        q.id,
        cqq.display_order,
        cqq.difficulty,
        q.prompt,
        q.explanation,
        qp.payload
      FROM campaign_quiz_questions cqq
      JOIN campaign_quizzes cq ON cq.slug = cqq.quiz_slug
      JOIN questions q ON q.id = cqq.question_id
      JOIN question_payloads qp ON qp.question_id = q.id
      WHERE cqq.quiz_slug = ${slug}
        AND cq.status = 'published'
        AND q.status = 'published'
        AND q.ranked_eligible = false
      ORDER BY cqq.display_order ASC
    `;
  },

  async getPublishedQuestion(
    slug: string,
    questionId: string,
  ): Promise<CampaignQuizQuestionRow | null> {
    const [question] = await sql<CampaignQuizQuestionRow[]>`
      SELECT
        q.id,
        cqq.display_order,
        cqq.difficulty,
        q.prompt,
        q.explanation,
        qp.payload
      FROM campaign_quiz_questions cqq
      JOIN campaign_quizzes cq ON cq.slug = cqq.quiz_slug
      JOIN questions q ON q.id = cqq.question_id
      JOIN question_payloads qp ON qp.question_id = q.id
      WHERE cqq.quiz_slug = ${slug}
        AND cqq.question_id = ${questionId}
        AND cq.status = 'published'
        AND q.status = 'published'
        AND q.ranked_eligible = false
      LIMIT 1
    `;
    return question ?? null;
  },

  async getRating(slug: string): Promise<CampaignQuizRatingRow> {
    const [rating] = await sql<CampaignQuizRatingRow[]>`
      SELECT
        ROUND(AVG(rating)::numeric, 2) AS average,
        COUNT(*)::int AS count
      FROM campaign_quiz_ratings
      WHERE quiz_slug = ${slug}
    `;
    return rating ?? { average: null, count: 0 };
  },

  async upsertRating(slug: string, userId: string, rating: number): Promise<void> {
    await sql`
      INSERT INTO campaign_quiz_ratings (quiz_slug, user_id, rating)
      VALUES (${slug}, ${userId}, ${rating})
      ON CONFLICT (quiz_slug, user_id)
      DO UPDATE SET rating = EXCLUDED.rating, updated_at = NOW()
    `;
  },
};
