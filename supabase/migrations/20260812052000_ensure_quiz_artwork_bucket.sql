-- Quiz page artwork is written by the backend with the service role and read
-- publicly by the Next.js image optimiser. Existing environments already use
-- this bucket; the insert makes clean/local environments behave the same way.
INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) VALUES (
  'imgs',
  'imgs',
  true,
  10485760,
  ARRAY['image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;
