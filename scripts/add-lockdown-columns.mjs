import pg from "pg";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const sql = `
  ALTER TABLE raid_state
    ADD COLUMN IF NOT EXISTS lockdown_active     BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS lockdown_reason     TEXT,
    ADD COLUMN IF NOT EXISTS lockdown_until      TEXT,
    ADD COLUMN IF NOT EXISTS lockdown_snapshot   TEXT,
    ADD COLUMN IF NOT EXISTS lockdown_updated_at TEXT;
`;

try {
  await pool.query(sql);
  console.log("✅ lockdown columns added to raid_state.");

  const result = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'raid_state' ORDER BY ordinal_position"
  );
  console.log("Current raid_state columns:", result.rows.map((r) => r.column_name));
} catch (err) {
  console.error("❌ Migration failed:", err.message);
} finally {
  await pool.end();
}
