import { z } from 'zod';

export const campaignQuizSlugParamsSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});

export const campaignQuizAnswerBodySchema = z.object({
  question_id: z.string().uuid(),
  selected_option_id: z.string().min(1).max(80),
});

export const campaignQuizRatingBodySchema = z.object({
  rating: z.number().int().min(1).max(5),
});

export type CampaignQuizSlugParams = z.infer<typeof campaignQuizSlugParamsSchema>;
export type CampaignQuizAnswerBody = z.infer<typeof campaignQuizAnswerBodySchema>;
export type CampaignQuizRatingBody = z.infer<typeof campaignQuizRatingBodySchema>;

export interface CampaignQuizOptionResponse {
  id: string;
  text: string;
}

export interface CampaignQuizQuestionResponse {
  id: string;
  position: number;
  difficulty: 'easy' | 'medium' | 'hard';
  type: 'mcq_single' | 'true_false' | 'clue_chain' | 'career_path';
  prompt: string;
  details: string[];
  image_url: string | null;
  options: CampaignQuizOptionResponse[];
}

export interface CampaignQuizRatingResponse {
  average: number | null;
  count: number;
}

export interface CampaignQuizResponse {
  slug: string;
  title: string;
  total_questions: number;
  questions: CampaignQuizQuestionResponse[];
  rating: CampaignQuizRatingResponse;
}

export interface CampaignQuizAnswerResponse {
  correct: boolean;
  correct_option_id: string;
  explanation: string | null;
}
