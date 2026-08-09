UPDATE `jobs`
SET `plan` = 'scale'
WHERE `queue_priority` = 30
  AND `plan` NOT IN ('free', 'basic', 'pro', 'scale');
