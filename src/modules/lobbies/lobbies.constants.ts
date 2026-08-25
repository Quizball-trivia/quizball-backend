export const MIN_QUESTIONS_PER_CATEGORY = 5;

/**
 * Minimum plain-MCQ pool for a category offered in the penalty-ban interlude.
 * A shootout consumes one unused MCQ per kick and a question can never repeat
 * within a match, so a regulation best-of-5 alone needs up to 10; categories
 * below this depth exhaust mid-shootout (prod: 18 frozen matches in 60 days
 * from 7–9-question categories). Exhaustion still completes gracefully via
 * the penalty-goals fallback — this guard is what keeps it rare.
 */
export const MIN_PENALTY_CATEGORY_MCQS = 12;

/**
 * Candidate count fetched for the penalty-ban interlude before depth
 * filtering, so at least 3 deep-enough options usually survive.
 */
export const PENALTY_OPTION_CANDIDATE_COUNT = 9;
