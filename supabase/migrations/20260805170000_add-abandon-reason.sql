ALTER TABLE game_profiles ADD COLUMN IF NOT EXISTS abandon_reason text NOT NULL DEFAULT '';
