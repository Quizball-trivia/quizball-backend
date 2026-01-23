-- Add background_img_url to categories table
ALTER TABLE categories ADD COLUMN IF NOT EXISTS background_img_url TEXT;
