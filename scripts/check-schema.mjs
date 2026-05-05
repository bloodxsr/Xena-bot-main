import pg from "pg";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Schema: expected columns per table (from schema.prisma)
const expectedSchema = {
  warnings:           ["guild_id","user_id","warning_count","updated_at"],
  warning_events:     ["id","guild_id","user_id","actor_user_id","reason","created_at"],
  moderation_logs:    ["id","guild_id","actor_user_id","target_user_id","action","reason","channel_id","message_id","metadata","created_at"],
  guild_config:       ["guild_id","log_channel_id","welcome_channel_id","rules_channel_id","chat_channel_id","help_channel_id","about_channel_id","perks_channel_id","leveling_channel_id","welcome_message_template","levelup_message_template","kick_message_template","ban_message_template","mute_message_template","level_card_font","level_card_primary_color","level_card_accent_color","level_card_background_url","level_card_overlay_opacity","welcome_card_enabled","welcome_card_title_template","welcome_card_subtitle_template","welcome_card_font","welcome_card_primary_color","welcome_card_accent_color","welcome_card_background_url","welcome_card_overlay_opacity","ticket_enabled","ticket_trigger_channel_id","ticket_trigger_message_id","ticket_trigger_emoji","ticket_category_channel_id","ticket_support_role_id","ticket_welcome_template","admin_role_name","mod_role_name","sync_mode","sync_guild_id","verification_url","leveling_enabled","raid_detection_enabled","raid_gate_threshold","raid_monitor_window_seconds","raid_join_rate_threshold","gate_duration_seconds","join_gate_mode"],
  raid_state:         ["guild_id","gate_active","gate_reason","gate_until","updated_at","lockdown_active","lockdown_reason","lockdown_until","lockdown_snapshot","lockdown_updated_at"],
  verification_queue: ["guild_id","user_id","status","risk_score","verification_url","reason","created_at","updated_at","verified_by_user_id"],
  join_events:        ["id","guild_id","user_id","account_age_days","has_avatar","profile_score","join_rate","young_account_ratio","risk_score","risk_level","action","metadata","created_at"],
  reaction_roles:     ["id","guild_id","channel_id","message_id","emoji_key","emoji_display","role_id","created_by_user_id","created_at"],
  member_levels:      ["guild_id","user_id","xp","level","message_count","voice_seconds","last_xp_at","updated_at"],
  command_toggles:    ["guild_id","command_name","enabled","updated_at"],
  ticket_threads:     ["guild_id","user_id","channel_id","trigger_channel_id","trigger_message_id","created_at","updated_at"],
  reaction_role_panels: ["guild_id","channel_id","message_id","content","created_at","updated_at"],
};

const result = await pool.query(
  "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position"
);

const actual = {};
for (const { table_name, column_name } of result.rows) {
  if (!actual[table_name]) actual[table_name] = [];
  actual[table_name].push(column_name);
}

let hasIssues = false;
for (const [table, expectedCols] of Object.entries(expectedSchema)) {
  const actualCols = actual[table] || [];
  const missing = expectedCols.filter(c => !actualCols.includes(c));
  if (!actual[table]) {
    console.log(`❌ MISSING TABLE: ${table}`);
    hasIssues = true;
  } else if (missing.length > 0) {
    console.log(`⚠️  ${table}: missing columns: ${missing.join(", ")}`);
    hasIssues = true;
  } else {
    console.log(`✅ ${table}: OK`);
  }
}

if (!hasIssues) console.log("\n✅ All tables and columns match the schema!");
await pool.end();
