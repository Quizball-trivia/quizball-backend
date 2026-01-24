# Plan: Question Payload Schema Update

## Overview
Update the question payload format to match what the CMS frontend expects, and add Zod validation schemas for type safety.

## Problem
Current seed data uses wrong payload format:
- MCQ: `{"options": [{en, ka}, ...], "correct_index": 1}` 
- Text: `{"accepted_answers": ["1930"]}`

CMS expects:
- MCQ: `{"type": "mcq_single", "options": [{id, text: {en, ka}, is_correct}, ...]}`
- Text: `{"type": "input_text", "accepted_answers": [{en, ka}], "case_sensitive": bool}`

## Design Decisions (from user feedback)

1. **Payload is REQUIRED** for all question types (mcq_single must have options, input_text must have accepted_answers)
2. **MCQ has exactly 4 options** - `min(4).max(4)`
3. **No migration needed** - only seed data exists, we can re-run seeds
4. **Payload type must match question type** - enforced via refine on both create and update
5. **Option IDs must be unique** - add refine to check uniqueness
6. **Use helper function in seed script** - avoid quoting issues with inline uuidgen

---

## Files to Modify

### 1. `src/modules/questions/questions.schemas.ts`

#### Add after line 25 (after statusEnum):

```typescript
// =============================================================================
// Payload Schemas
// =============================================================================

/**
 * MCQ Option schema - single answer option with i18n text
 */
export const mcqOptionSchema = z.object({
  id: z.string().uuid(),
  text: i18nFieldSchema,
  is_correct: z.boolean(),
});

export type McqOption = z.infer<typeof mcqOptionSchema>;

/**
 * MCQ Payload schema - multiple choice with single correct answer
 * Requires exactly 4 options, exactly 1 correct, all unique IDs
 */
export const mcqPayloadSchema = z
  .object({
    type: z.literal('mcq_single'),
    options: z.array(mcqOptionSchema).length(4),
  })
  .refine((data) => data.options.filter((o) => o.is_correct).length === 1, {
    message: 'Exactly one option must be marked as correct',
  })
  .refine(
    (data) => {
      const ids = data.options.map((o) => o.id);
      return new Set(ids).size === ids.length;
    },
    { message: 'Option IDs must be unique' }
  );

export type McqPayload = z.infer<typeof mcqPayloadSchema>;

/**
 * Text Input Payload schema - user types answer
 */
export const textInputPayloadSchema = z.object({
  type: z.literal('input_text'),
  accepted_answers: z.array(i18nFieldSchema).min(1),
  case_sensitive: z.boolean(),
});

export type TextInputPayload = z.infer<typeof textInputPayloadSchema>;

/**
 * Union of all payload types - discriminated by 'type' field
 */
export const questionPayloadSchema = z.discriminatedUnion('type', [
  mcqPayloadSchema,
  textInputPayloadSchema,
]);

export type QuestionPayload = z.infer<typeof questionPayloadSchema>;
```

#### Update createQuestionSchema (line 93-101):

Replace entire schema with:

```typescript
/**
 * Base create question schema (before payload injection)
 */
const createQuestionBaseSchema = z.object({
  category_id: z.string().uuid(),
  type: questionTypeEnum,
  difficulty: difficultyEnum,
  status: statusEnum.optional().default('draft'),
  prompt: i18nFieldSchema,
  explanation: i18nFieldSchema.nullable().optional(),
  payload: questionPayloadSchema,
});

/**
 * Create question request schema.
 * - Payload is required
 * - Payload type must match question type
 */
export const createQuestionSchema = createQuestionBaseSchema.refine(
  (data) => data.payload.type === data.type,
  { message: 'Payload type must match question type', path: ['payload', 'type'] }
);

export type CreateQuestionRequest = z.infer<typeof createQuestionSchema>;
```

#### Update updateQuestionSchema (line 108-116):

Replace entire schema with:

```typescript
/**
 * Update question request schema.
 * - All fields optional
 * - If both type and payload provided, they must match
 */
export const updateQuestionSchema = z
  .object({
    category_id: z.string().uuid().optional(),
    type: questionTypeEnum.optional(),
    difficulty: difficultyEnum.optional(),
    status: statusEnum.optional(),
    prompt: i18nFieldSchema.optional(),
    explanation: i18nFieldSchema.nullable().optional(),
    payload: questionPayloadSchema.optional(),
  })
  .refine(
    (data) => {
      // If both type and payload are provided, they must match
      if (data.type && data.payload) {
        return data.payload.type === data.type;
      }
      return true;
    },
    { message: 'Payload type must match question type', path: ['payload', 'type'] }
  );

export type UpdateQuestionRequest = z.infer<typeof updateQuestionSchema>;
```

---

### 2. `scripts/seed-cms-data.sh`

#### Add helper function after line 163 (after create_question function):

```bash
# Helper to generate UUID (lowercase)
gen_uuid() {
  uuidgen | tr '[:upper:]' '[:lower:]'
}

# Build MCQ payload JSON safely
# Args: option1_en option1_ka option2_en option2_ka option3_en option3_ka option4_en option4_ka correct_index(0-3)
build_mcq_payload() {
  local opt1_en="$1" opt1_ka="$2"
  local opt2_en="$3" opt2_ka="$4"
  local opt3_en="$5" opt3_ka="$6"
  local opt4_en="$7" opt4_ka="$8"
  local correct="$9"

  local id1=$(gen_uuid)
  local id2=$(gen_uuid)
  local id3=$(gen_uuid)
  local id4=$(gen_uuid)

  # Set is_correct based on correct index
  local c1="false" c2="false" c3="false" c4="false"
  case "$correct" in
    0) c1="true" ;;
    1) c2="true" ;;
    2) c3="true" ;;
    3) c4="true" ;;
  esac

  cat <<EOF
{"type": "mcq_single", "options": [{"id": "$id1", "text": {"en": "$opt1_en", "ka": "$opt1_ka"}, "is_correct": $c1}, {"id": "$id2", "text": {"en": "$opt2_en", "ka": "$opt2_ka"}, "is_correct": $c2}, {"id": "$id3", "text": {"en": "$opt3_en", "ka": "$opt3_ka"}, "is_correct": $c3}, {"id": "$id4", "text": {"en": "$opt4_en", "ka": "$opt4_ka"}, "is_correct": $c4}]}
EOF
}

# Build text input payload JSON safely
# Args: answer_en answer_ka [case_sensitive: true/false]
build_text_payload() {
  local answer_en="$1"
  local answer_ka="$2"
  local case_sensitive="${3:-false}"

  cat <<EOF
{"type": "input_text", "accepted_answers": [{"en": "$answer_en", "ka": "$answer_ka"}], "case_sensitive": $case_sensitive}
EOF
}
```

#### Update all 10 questions in seed_data() function:

**Q1 (line 206-211):**
```bash
Q1=$(create_question "$WORLD_CUP_ID" "mcq_single" "easy" \
  "Which country won the 2022 FIFA World Cup?" \
  "რომელმა ქვეყანამ მოიგო 2022 FIFA მსოფლიო ჩემპიონატი?" \
  "$(build_mcq_payload "France" "საფრანგეთი" "Argentina" "არგენტინა" "Brazil" "ბრაზილია" "Croatia" "ხორვატია" 1)" \
  "published")
```

**Q2 (line 213-218):**
```bash
Q2=$(create_question "$WORLD_CUP_ID" "mcq_single" "medium" \
  "Who is the all-time top scorer in FIFA World Cup history?" \
  "ვინ არის FIFA მსოფლიო ჩემპიონატის ისტორიაში საუკეთესო ბომბარდირი?" \
  "$(build_mcq_payload "Ronaldo (Brazil)" "რონალდო (ბრაზილია)" "Miroslav Klose" "მიროსლავ კლოზე" "Gerd Muller" "გერდ მიულერი" "Pele" "პელე" 1)" \
  "published")
```

**Q3 (line 220-225):**
```bash
Q3=$(create_question "$WORLD_CUP_ID" "input_text" "hard" \
  "In what year was the first FIFA World Cup held?" \
  "რომელ წელს გაიმართა პირველი FIFA მსოფლიო ჩემპიონატი?" \
  "$(build_text_payload "1930" "1930")" \
  "published")
```

**Q4 (line 227-232):**
```bash
Q4=$(create_question "$WORLD_CUP_ID" "mcq_single" "medium" \
  "Which country has won the most FIFA World Cups?" \
  "რომელ ქვეყანას აქვს ყველაზე მეტი მსოფლიო ჩემპიონატის მოგება?" \
  "$(build_mcq_payload "Germany" "გერმანია" "Italy" "იტალია" "Brazil" "ბრაზილია" "Argentina" "არგენტინა" 2)" \
  "published")
```

**Q5 (line 235-240):**
```bash
Q5=$(create_question "$CHAMPIONS_LEAGUE_ID" "mcq_single" "easy" \
  "Which club has won the most UEFA Champions League titles?" \
  "რომელ კლუბს აქვს ყველაზე მეტი ჩემპიონთა ლიგის მოგება?" \
  "$(build_mcq_payload "Barcelona" "ბარსელონა" "AC Milan" "მილანი" "Real Madrid" "რეალ მადრიდი" "Bayern Munich" "ბაიერნ მიუნხენი" 2)" \
  "published")
```

**Q6 (line 242-247):**
```bash
Q6=$(create_question "$CHAMPIONS_LEAGUE_ID" "mcq_single" "hard" \
  "Who is the all-time top scorer in Champions League history?" \
  "ვინ არის ჩემპიონთა ლიგის ისტორიაში საუკეთესო ბომბარდირი?" \
  "$(build_mcq_payload "Lionel Messi" "ლიონელ მესი" "Cristiano Ronaldo" "კრიშტიანუ რონალდუ" "Robert Lewandowski" "რობერტ ლევანდოვსკი" "Karim Benzema" "კარიმ ბენზემა" 1)" \
  "published")
```

**Q7 (line 250-255):**
```bash
Q7=$(create_question "$PREMIER_LEAGUE_ID" "mcq_single" "easy" \
  "Which club has won the most Premier League titles?" \
  "რომელ კლუბს აქვს ყველაზე მეტი პრემიერ ლიგის მოგება?" \
  "$(build_mcq_payload "Liverpool" "ლივერპული" "Chelsea" "ჩელსი" "Manchester United" "მანჩესტერ იუნაიტედი" "Manchester City" "მანჩესტერ სიტი" 2)" \
  "published")
```

**Q8 (line 257-262):**
```bash
Q8=$(create_question "$PREMIER_LEAGUE_ID" "input_text" "medium" \
  "In what year did the Premier League start?" \
  "რომელ წელს დაიწყო პრემიერ ლიგა?" \
  "$(build_text_payload "1992" "1992")" \
  "published")
```

**Q9 (line 265-270):**
```bash
Q9=$(create_question "$LEGENDS_ID" "mcq_single" "easy" \
  "Which player is known as 'The King of Football'?" \
  "რომელ მოთამაშეს ეძახიან 'ფეხბურთის მეფეს'?" \
  "$(build_mcq_payload "Diego Maradona" "დიეგო მარადონა" "Pele" "პელე" "Johan Cruyff" "იოჰან კრუიფი" "Franz Beckenbauer" "ფრანც ბეკენბაუერი" 1)" \
  "published")
```

**Q10 (line 272-277):**
```bash
Q10=$(create_question "$LEGENDS_ID" "mcq_single" "medium" \
  "How many Ballon d'Or awards has Lionel Messi won?" \
  "რამდენი ოქროს ბურთი აქვს მოგებული ლიონელ მესის?" \
  "$(build_mcq_payload "6" "6" "7" "7" "8" "8" "5" "5" 2)" \
  "published")
```

---

## Testing

After implementation:
1. `npm run lint` - Type-check
2. `npm test` - Run test suite (may need test updates for new payload validation)
3. `./scripts/cleanup-cms-data.sh` - Clear existing data
4. `./scripts/seed-cms-data.sh` - Re-seed with correct format
5. Verify in CMS that questions load/edit correctly

---

## Checklist

- [ ] Add payload Zod schemas (McqOption, McqPayload, TextInputPayload, QuestionPayload)
- [ ] Add uniqueness refine for option IDs
- [ ] Update createQuestionSchema - payload required, type must match
- [ ] Update updateQuestionSchema - type/payload must match when both present
- [ ] Add helper functions to seed script (gen_uuid, build_mcq_payload, build_text_payload)
- [ ] Update 8 MCQ questions using build_mcq_payload
- [ ] Update 2 Text Input questions using build_text_payload
- [ ] Run lint and tests
- [ ] Test seed script execution

---

## Summary of Changes

| File | Changes |
|------|---------|
| `src/modules/questions/questions.schemas.ts` | Add 5 Zod schemas, 4 types, update create/update with refines |
| `scripts/seed-cms-data.sh` | Add 3 helper functions, update 10 question payloads |

## Breaking Changes

- **Payload is now required** when creating questions
- **Payload type must match question type**
- **MCQ must have exactly 4 options**
- **MCQ must have exactly 1 correct option**
- **MCQ option IDs must be unique**

These are intentional constraints based on business requirements.
