# Fuzzy Matching for Text Input Questions

## Overview

Text input questions use **fuzzy matching** to automatically handle typos and small mistakes in user answers. Instead of hardcoding all possible variations (Paris, paris, Pars, Parris, etc.), we use PostgreSQL's built-in **pg_trgm** extension to calculate similarity scores.

---

## How It Works

### 1. **Trigram Similarity**

PostgreSQL breaks strings into trigrams (3-character sequences) and compares them:

```
"Paris" → ["  P", " Pa", "Par", "ari", "ris", "is "]
"Pars"  → ["  P", " Pa", "Par", "ars", "rs "]

Shared trigrams: ["  P", " Pa", "Par"] = 3/6 = 0.5 similarity
```

### 2. **Similarity Score (0 to 1)**

- **1.0** = Exact match
- **0.8-0.9** = Very close (1-2 typos)
- **0.6-0.7** = Somewhat close (3-4 typos)
- **0.0** = Completely different

### 3. **Threshold-Based Matching**

We set a **similarity threshold** (default: 0.75) to determine if an answer is "close enough":

```sql
SELECT similarity('Paris', user_answer) >= 0.75;
```

---

## Database Setup

### Enable pg_trgm Extension

```sql
-- Migration: enable_fuzzy_matching.sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Optional: GIN index for performance (only needed for large datasets)
CREATE INDEX IF NOT EXISTS idx_question_payloads_gin_trgm
ON question_payloads
USING gin ((payload->'accepted_answers') jsonb_path_ops);
```

---

## Payload Structure

### Text Input Question Payload

```typescript
{
  "type": "input_text",
  "accepted_answers": [
    { "en": "Paris" }  // Single correct answer
  ],
  "case_sensitive": false,
  "similarity_threshold": 0.75  // How strict matching is
}
```

### Similarity Threshold Options

| Threshold | Tolerance | Use Case |
|-----------|-----------|----------|
| `1.0` | Exact match only | Case-sensitive answers (codes, IDs) |
| `0.85` | Very strict (1-2 typos) | Names, technical terms |
| `0.75` | Moderate (2-3 typos) | **Recommended default** |
| `0.6` | Lenient (3-4 typos) | Long or complex answers |

---

## Validation Logic

### Answer Validation Service

```typescript
async function validateTextInputAnswer(
  userAnswer: string,
  acceptedAnswers: I18nField[],
  caseSensitive: boolean,
  similarityThreshold: number = 0.75
): Promise<{ isCorrect: boolean; matchedAnswer?: string; similarity?: number }> {

  // 1. Normalize user answer
  const normalizedUserAnswer = caseSensitive
    ? userAnswer.trim()
    : userAnswer.trim().toLowerCase();

  // 2. Try exact match first (fastest path)
  for (const accepted of acceptedAnswers) {
    const acceptedText = caseSensitive
      ? accepted.en.trim()
      : accepted.en.trim().toLowerCase();

    if (normalizedUserAnswer === acceptedText) {
      return {
        isCorrect: true,
        matchedAnswer: accepted.en,
        similarity: 1.0
      };
    }
  }

  // 3. Try fuzzy match using pg_trgm
  const result = await sql<{ answer: string; similarity: number }[]>`
    SELECT
      accepted_answer->>'en' as answer,
      similarity(
        ${normalizedUserAnswer},
        ${caseSensitive
          ? sql`accepted_answer->>'en'`
          : sql`LOWER(accepted_answer->>'en')`
        }
      ) as similarity
    FROM unnest(${sql.array(acceptedAnswers.map(a => sql.json(a)))}::jsonb[])
      AS accepted_answer
    WHERE similarity(
      ${normalizedUserAnswer},
      ${caseSensitive
        ? sql`accepted_answer->>'en'`
        : sql`LOWER(accepted_answer->>'en')`
      }
    ) >= ${similarityThreshold}
    ORDER BY similarity DESC
    LIMIT 1
  `;

  if (result.length > 0) {
    return {
      isCorrect: true,
      matchedAnswer: result[0].answer,
      similarity: result[0].similarity,
    };
  }

  // 4. No match found
  return { isCorrect: false };
}
```

---

## Example Results

### Question: "What is the capital of France?"
**Correct answer:** `Paris`
**Threshold:** `0.75` (moderate)

| User Answer | Similarity | Case Insensitive | Result |
|-------------|------------|------------------|--------|
| `Paris` | 1.0 | 1.0 | ✅ Correct (exact) |
| `paris` | 1.0 | 1.0 | ✅ Correct (lowercase) |
| `PARIS` | 1.0 | 1.0 | ✅ Correct (uppercase) |
| `Pars` | 0.8 | 0.8 | ✅ Correct (1 missing char) |
| `Parris` | 0.77 | 0.77 | ✅ Correct (1 extra char) |
| `Pariz` | 0.8 | 0.8 | ✅ Correct (1 typo) |
| `Prais` | 0.8 | 0.8 | ✅ Correct (swapped chars) |
| `Pari` | 0.67 | 0.67 | ❌ Wrong (below 0.75) |
| `Par` | 0.6 | 0.6 | ❌ Wrong (too short) |
| `London` | 0.0 | 0.0 | ❌ Wrong (different) |
| `France` | 0.18 | 0.18 | ❌ Wrong (different) |

### Question: "What is 2 + 2?"
**Correct answer:** `4`
**Threshold:** `1.0` (exact only, case-sensitive)

| User Answer | Similarity | Result |
|-------------|------------|--------|
| `4` | 1.0 | ✅ Correct |
| `four` | 0.0 | ❌ Wrong (different) |
| ` 4 ` | 1.0 | ✅ Correct (trimmed) |
| `44` | 0.67 | ❌ Wrong (extra digit) |

---

## Performance Considerations

### Query Performance

**Without fuzzy matching:**
```sql
-- Simple exact match (very fast)
SELECT * FROM questions WHERE prompt = 'exact text';
-- ~0.1ms
```

**With fuzzy matching:**
```sql
-- Trigram similarity (fast with proper indexing)
SELECT *, similarity(prompt, 'user input') as sim
FROM questions
WHERE similarity(prompt, 'user input') > 0.75
ORDER BY sim DESC;
-- ~1-5ms with GIN index
-- ~50-100ms without index (on 10k+ rows)
```

### Optimization Tips

1. **Use exact match first** - Most users type correctly
2. **Add GIN index** - If you have 1000+ questions
3. **Set reasonable thresholds** - 0.75 is a good default
4. **Avoid very low thresholds** - 0.5 or lower causes false positives

---

## When NOT to Use Fuzzy Matching

### Use Exact Matching For:

1. **Case-sensitive IDs/codes**
   - Example: "What is the API key?" → `sk-abc123xyz`
   - Threshold: `1.0`, case-sensitive: `true`

2. **Numeric answers**
   - Example: "What is 2 + 2?" → `4`
   - Threshold: `1.0`, case-sensitive: `false`

3. **Boolean/Yes-No**
   - Example: "Is Earth round?" → `Yes`
   - Threshold: `0.85` (strict, but allow "yes" vs "Yes")

### Use Fuzzy Matching For:

1. **Names of people/places**
   - Example: "Capital of France?" → `Paris`
   - Threshold: `0.75`

2. **Single words with common typos**
   - Example: "What color is the sky?" → `blue`
   - Threshold: `0.75`

3. **Technical terms**
   - Example: "What is HTTP?" → `Hypertext Transfer Protocol`
   - Threshold: `0.7` (longer strings need lower threshold)

---

## Future Enhancements

### Option 1: Levenshtein Distance

If you need exact control over allowed typos:

```sql
CREATE EXTENSION fuzzystrmatch;

SELECT levenshtein('Paris', 'Pars');  -- 1 (1 character difference)

-- Allow max 2 typos
WHERE levenshtein(LOWER(user_answer), LOWER(correct_answer)) <= 2
```

**Use case:** Very short answers where you want to allow exactly 1-2 typos.

### Option 2: Semantic Similarity (pgvector + AI)

For understanding meaning, not just spelling:

```sql
CREATE EXTENSION vector;

-- Store OpenAI embeddings
ALTER TABLE question_payloads
  ADD COLUMN answer_embeddings vector(1536)[];

-- Match semantically similar answers
-- "The capital of France" matches "Paris"
SELECT cosine_similarity(
  embedding(user_answer),
  embedding(correct_answer)
) > 0.8;
```

**Use case:** Essay-style questions, complex answers, multiple sentence responses.

**Cost:** ~$0.0001 per embedding (OpenAI API)

### Option 3: Soundex/Metaphone

For phonetic matching (sounds similar):

```sql
CREATE EXTENSION fuzzystrmatch;

SELECT soundex('Paris') = soundex('Parus');  -- true (sounds similar)
SELECT metaphone('Smith', 4) = metaphone('Smythe', 4);  -- true
```

**Use case:** Names with multiple spellings (Smith/Smythe, Catherine/Kathryn).

---

## Implementation Checklist

- [x] Document fuzzy matching approach
- [ ] Create database migration to enable pg_trgm
- [ ] Add `similarity_threshold` to payload schema
- [ ] Implement answer validation service
- [ ] Add threshold selector to frontend form
- [ ] Test with various typo scenarios
- [ ] Add performance monitoring
- [ ] Document in API docs

---

## References

- [PostgreSQL pg_trgm Documentation](https://www.postgresql.org/docs/current/pgtrgm.html)
- [Fuzzy String Matching in PostgreSQL](https://www.postgresql.org/docs/current/fuzzystrmatch.html)
- [pgvector for Semantic Search](https://github.com/pgvector/pgvector)

---

## Questions?

Contact: Backend Team
Last Updated: 2026-01-25
