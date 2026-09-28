-- Weekend League import photos (storage question-images/wl-import/<batch>/<row>-<hash>.png)
-- belong to exactly one question: the one its import row created. Undoing that
-- batch deletes the photo, so no other question may point at it — whatever
-- writes the payload (CMS editor, agent review editor, scripts). Once the
-- owning question is deleted its batch row's question_id is NULL and the photo
-- can no longer be attached anywhere.
--
-- Only batches recorded in THIS database are enforced: staging copies of prod
-- questions carry prod URLs whose batches live in prod.

CREATE OR REPLACE FUNCTION public.wl_import_photo_owner_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  m text[];
BEGIN
  IF strpos(NEW.payload::text, '/question-images/wl-import/') = 0 THEN
    RETURN NEW;
  END IF;
  FOR m IN
    SELECT regexp_matches(NEW.payload::text, '/question-images/wl-import/([0-9a-f-]{36})/([0-9]+)-', 'g')
  LOOP
    IF EXISTS (SELECT 1 FROM public.wl_content_batches b WHERE b.id = m[1]::uuid)
       AND NOT EXISTS (
         SELECT 1 FROM public.wl_content_batch_rows r
         WHERE r.batch_id = m[1]::uuid AND r.row_index = m[2]::int AND r.question_id = NEW.question_id
       ) THEN
      RAISE EXCEPTION 'This photo belongs to a Weekend League import (batch %, row %) — upload the photo again for this question', m[1], m[2]::int + 1
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS question_payloads_wl_import_photo_owner ON public.question_payloads;
CREATE TRIGGER question_payloads_wl_import_photo_owner
  BEFORE INSERT OR UPDATE OF payload ON public.question_payloads
  FOR EACH ROW EXECUTE FUNCTION public.wl_import_photo_owner_guard();
