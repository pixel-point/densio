-- The trim workflow widens the application discriminator. Existing SQLite TEXT
-- columns already accept it; source/plan/job/artifact tables need no rewrite.
SELECT 1;
