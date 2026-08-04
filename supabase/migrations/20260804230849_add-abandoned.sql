ALTER TABLE game_profiles ADD COLUMN IF NOT EXISTS abandoned boolean NOT NULL DEFAULT false;
