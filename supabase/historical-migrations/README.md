# Historical data migrations

These original SQL files are retained byte-for-byte for audit and restore analysis. They are intentionally outside the automatic migration directory. Four were already applied to production but not staging. Replaying them now would replace current campaign selections, edit published question payloads or rewrite historical retention state. The staging-only `20260817170121_keep_seo_quiz_categories_inactive.sql` is also archived: its replay deactivates five currently active production categories. The forward category-comment migration preserves the schema documentation without overwriting editorial settings.

Do not execute them to equalize ledger counts, and do not mark them applied in an environment where they did not run. Existing ledger entries remain unchanged. Current content is promoted through the reviewed additive content release. Both environments ship this same archive and the same executable forward migrations.

See `scripts/release` and the September promotion evidence for provenance and acceptance criteria.
