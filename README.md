# Xena Bot

A Discord moderation and utility bot built with Discord.js, PostgreSQL (via Prisma ORM), and an optional Rust ML sidecar for advanced raid detection.

---

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | **v20 or later** |
| npm | **v9 or later** |
| PostgreSQL | Any hosted instance (e.g. [Neon](https://neon.tech)) |
| Rust + Cargo | Only needed for Rust ML sidecar mode |

---

## First-Time Setup

### 1. Clone and install dependencies

```bash
git clone <repo-url>
cd Xena-bot-main
npm install
```

### 2. Configure environment variables

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

Open `.env` and set the following required values:

```env
# ── Required ──────────────────────────────────────────────────────────────────
DISCORD_BOT_TOKEN=your_discord_bot_token_here

# ── Database (PostgreSQL — required) ──────────────────────────────────────────
DB_DRIVER=postgres
POSTGRES_HOST=your-db-host.neon.tech
POSTGRES_PORT=5432
POSTGRES_USER=your_db_user
POSTGRES_PASSWORD=your_db_password
POSTGRES_DATABASE=your_db_name
POSTGRES_SSL_MODE=required

# Full connection URL (used by Prisma CLI and the pg pool)
DATABASE_URL="postgres://user:password@host:5432/dbname?sslmode=require"

# ── Optional: SQLite fallback ──────────────────────────────────────────────────
# DB_DRIVER=sqlite
# DB_PATH=./data/warnings.db

# ── Optional: AI features (Gemini) ────────────────────────────────────────────
GOOGLE_API_KEY=your_google_gemini_api_key

# ── Optional: slash command guild sync target ──────────────────────────────────
# SLASH_SYNC_GUILD_ID=your_guild_id
```

> **Full list of all env options** (automod thresholds, leveling XP, raid ML, uptime server, etc.) is documented below in the [Environment Variables Reference](#environment-variables-reference).

---

## Database Setup (PostgreSQL / Prisma)

Run these commands **once before the first startup** (and again after any schema changes):

### Step 1 — Generate the Prisma client

```bash
npx prisma generate
```

This reads `prisma/schema.prisma` and generates the typed database client into `node_modules/@prisma/client`.

### Step 2 — Push the schema to your database

```bash
npx prisma db push
```

This creates all required tables and columns in your PostgreSQL database. It is **safe to re-run** — it only adds what is missing.

> **Neon / pooler note:** If `prisma db push` cannot connect (Neon pooler endpoints sometimes block migration commands), run the schema validation script instead to check what's missing, then apply changes manually:
>
> ```bash
> node scripts/check-schema.mjs
> ```

### Step 3 — Verify the schema (optional)

```bash
node scripts/check-schema.mjs
```

Prints a table confirming every column in every table matches the schema. All rows should show `✅ OK`.

---

## Starting the Bot

### Standard mode (JavaScript only)

```bash
npm start
```

### Development mode (auto-restarts on file changes)

```bash
npm run dev
```

### Rust ML sidecar mode (enhanced raid detection)

The Rust sidecar provides faster, more accurate raid risk scoring. Requires Rust and Cargo installed.

**Start both sidecar and bot together (recommended):**

```bash
npm run start:rust:all
```

**Or start them separately:**

```bash
# Terminal 1 — build and run the sidecar
npm run ml:sidecar

# Terminal 2 — start the bot in Rust mode
npm run start:rust
```

**Development watch mode with Rust:**

```bash
npm run dev:rust
```

> When the sidecar is unavailable, the bot **automatically falls back** to the built-in JavaScript raid model — no manual intervention needed.

---

## In-Discord Server Setup

After the bot is online, run the following command once in your server as an **Administrator**:

```
/autosetup
```

This single command automatically:
- Creates a **🌐 Server Hub** category with channels: `#rules`, `#general`, `#help`, `#about`, `#perks`, `#welcome`, `#level-ups`
- Creates a **🔒 Staff** category with channel: `#mod-logs`
- Maps all channel IDs to the server configuration in the database (logging, welcome, leveling, resources)

After running it, verify with:

```
/serverconfig
```

---

## All npm Scripts

| Command | Description |
|---|---|
| `npm start` | Start the bot (JS only) |
| `npm run dev` | Start with file-watch auto-restart |
| `npm run start:rust` | Start bot in Rust ML mode (sidecar must already be running) |
| `npm run start:rust:all` | Build sidecar + start sidecar + start bot (all in one) |
| `npm run dev:rust` | Watch mode for bot in Rust ML mode |
| `npm run ml:sidecar` | Build and run the Rust ML sidecar only |
| `npm run ml:sidecar:build` | Build the Rust ML sidecar binary only |

---

## All Admin Commands

| Command | Permission | Description |
|---|---|---|
| `/autosetup` | Administrator | Auto-create channels, categories, and map all config |
| `/serverconfig` | Administrator | Show current server configuration |
| `/setresourcechannels <rules> <chat> <help> <about> <perks>` | Administrator | Manually set resource channel IDs |
| `/setroles <AdminRole> \| <ModRole>` | Administrator | Set staff role name mappings |
| `/setverificationurl <url\|off>` | Administrator | Set or clear the join verification URL |
| `/raid` | Administrator | Open the raid control center (status, configure, enable/disable gate) |
| `/setraidsettings <threshold> <join_rate> <window_s> <duration_s> <timeout\|kick>` | Administrator | Bulk-update raid detection thresholds |

## All Moderation Commands

| Command | Permission | Description |
|---|---|---|
| `/warn <user> <reason>` | Moderate Members | Issue a warning |
| `/warnings [user]` | Moderate Members | View warning count |
| `/mute <user> [minutes] [reason]` | Moderate Members | Timeout a member |
| `/unmute <user>` | Moderate Members | Remove timeout |
| `/purge <count> [channel]` | Manage Messages | Bulk delete messages (max 100) |
| `/kick <user> [reason]` | Kick Members | Remove a member |
| `/ban <user> [reason]` | Ban Members | Ban a member |
| `/unban <user>` | Ban Members | Remove a ban |
| `/raidgate <on\|off\|status>` | Moderate Members | Manually control raid gate |
| `/pendingverifications [limit]` | Moderate Members | View pending join verifications |
| `/raidsnapshot [limit]` | Moderate Members | View recent join risk scores |
| `/blacklisted` | Manage Guild | Manage blacklisted words via dropdown |
| `/reloadwords` | Manage Guild | Reload blacklist from disk |

## All Utility Commands

| Command | Description |
|---|---|
| `/help [section]` | Interactive command guide (sections: general, admin, moderation, leveling, reactionroles) |
| `/stats` | Server overview stats |
| `/rank [user]` | XP rank card |
| `/leaderboard [page]` | XP leaderboard |
| `/activityboard [page]` | Voice + message activity leaderboard |
| `/ask <question>` | Ask the Gemini AI assistant |
| `/joke` | AI-generated joke |
| `/role` | Manage member roles via dropdown |
| `/addrole <user> <role>` | Add a role to a member |
| `/removerole <user> <role>` | Remove a role from a member |
| `/reactionroles` | Manage reaction role panels |

---

## Environment Variables Reference

### Core

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_BOT_TOKEN` | ✅ | — | Discord bot token |
| `BOT_PREFIXES` | | `/,!` | Comma-separated command prefixes |
| `WEB_BASE_URL` | | `https://xena.app` | Base URL for message jump links |
| `NODE_ENV` | | `development` | Set to `production` in prod |

### Database

| Variable | Required | Default | Description |
|---|---|---|---|
| `DB_DRIVER` | | `postgres` | `postgres` or `sqlite` |
| `DATABASE_URL` | ✅ (postgres) | — | Full PostgreSQL connection string |
| `POSTGRES_HOST` | ✅ (postgres) | — | DB host |
| `POSTGRES_PORT` | | `5432` | DB port |
| `POSTGRES_USER` | ✅ (postgres) | — | DB user |
| `POSTGRES_PASSWORD` | ✅ (postgres) | — | DB password |
| `POSTGRES_DATABASE` | ✅ (postgres) | — | DB name |
| `POSTGRES_SSL_MODE` | | `disabled` | `required` for hosted DBs |
| `DB_PATH` | | `./data/warnings.db` | SQLite file path (sqlite mode only) |

### Discord Intents

| Variable | Default | Description |
|---|---|---|
| `DISCORD_INTENT_GUILD_MEMBERS` | `false` | Enable `GuildMembers` intent (required for join events) |
| `DISCORD_INTENT_MESSAGE_CONTENT` | `false` | Enable `MessageContent` intent (required for prefix commands) |

### Moderation & Automod

| Variable | Default | Description |
|---|---|---|
| `MAX_WARNINGS` | `4` | Warnings before kick |
| `SPAM_DETECTION_ENABLED` | `true` | Enable spam automod |
| `SPAM_WINDOW_SECONDS` | `8` | Message rate window |
| `SPAM_MESSAGE_THRESHOLD` | `6` | Messages in window before flag |
| `SPAM_DUPLICATE_WINDOW_SECONDS` | `20` | Duplicate message window |
| `SPAM_DUPLICATE_THRESHOLD` | `3` | Duplicate messages before flag |
| `SPAM_MENTION_THRESHOLD` | `6` | Max mentions per message |
| `SPAM_LINK_THRESHOLD` | `4` | Max links per message |
| `SPAM_WARNING_THRESHOLD` | `0.45` | Score for warning-only |
| `SPAM_MUTE_THRESHOLD` | `0.75` | Score triggering timeout |
| `AUTOMOD_TIMEOUT_SECONDS` | `600` | Normal timeout duration |
| `AUTOMOD_SEVERE_TIMEOUT_SECONDS` | `1800` | Severe spam timeout duration |

### Raid Detection

| Variable | Default | Description |
|---|---|---|
| `RAID_ESCALATION_WINDOW_SECONDS` | `45` | Suspicious activity tracking window |
| `RAID_ESCALATION_EVENT_THRESHOLD` | `6` | Events before raid escalation |
| `RAID_ESCALATION_USER_THRESHOLD` | `3` | Unique users before escalation |

### Raid ML Sidecar

| Variable | Default | Description |
|---|---|---|
| `RAID_ML_BACKEND` | `js` | `js` or `rust` |
| `RAID_ML_HOST` | `127.0.0.1` | Sidecar host |
| `RAID_ML_PORT` | `8787` | Sidecar port |
| `RAID_ML_TIMEOUT_MS` | `350` | Sidecar request timeout |

### Leveling

| Variable | Default | Description |
|---|---|---|
| `LEVELING_XP_MIN` | `8` | Min XP per message |
| `LEVELING_XP_MAX` | `16` | Max XP per message |
| `LEVELING_XP_COOLDOWN_SECONDS` | `45` | XP gain cooldown |
| `LEVELING_MIN_MESSAGE_LENGTH` | `4` | Minimum message length for XP |
| `LEVELING_IGNORE_COMMAND_MESSAGES` | `true` | Don't award XP for commands |
| `LEVELING_ANNOUNCE_LEVEL_UP` | `true` | Announce level-ups |

### AI (Gemini)

| Variable | Default | Description |
|---|---|---|
| `GOOGLE_API_KEY` | — | Gemini API key (enables `/ask` and `/joke`) |
| `AI_MODEL_NAME` | `gemini-2.5-flash` | Gemini model to use |
| `AI_RATE_LIMIT_SECONDS` | `5` | Per-user AI cooldown |
| `AI_MAX_RESPONSE_LENGTH` | `1500` | Max AI response characters |
| `AI_MAX_QUESTION_LENGTH` | `600` | Max question length |

### Uptime Server

| Variable | Default | Description |
|---|---|---|
| `ENABLE_UPTIME_SERVER` | `false` | Enable HTTP uptime ping endpoint |
| `UPTIME_HOST` | `0.0.0.0` | Uptime server host |
| `UPTIME_PORT` | `8080` | Uptime server port |

---

## Project Structure

```
Xena-bot-main/
├── src/
│   ├── index.js                  # Main entry point
│   ├── start-rust.js             # Entry point for Rust ML mode
│   ├── admin/
│   │   ├── commands.js           # Admin command handlers
│   │   ├── database.js           # SQLite database layer
│   │   └── database-prisma.js    # PostgreSQL / Prisma database layer
│   ├── moderation/
│   │   ├── commands.js           # Moderation command handlers
│   │   ├── raidMlClient.js       # Rust ML sidecar client
│   │   ├── riskSignals.js        # JS raid/spam risk engines
│   │   └── words.js              # Blacklist word store
│   └── utilities/
│       ├── commands.js           # Utility command handlers + help
│       ├── config.js             # Environment config loader
│       ├── emoji.js              # Emoji normalization utilities
│       └── welcome-card-image.js # Welcome card image renderer
├── prisma/
│   ├── schema.prisma             # Prisma schema (all DB models)
│   └── migrations/               # Migration history
├── prisma.config.ts              # Prisma CLI configuration
├── scripts/
│   ├── run-rust-stack.js         # Combined sidecar + bot launcher
│   ├── run-ml-sidecar.js         # Sidecar process manager
│   ├── check-schema.mjs          # DB schema validation utility
│   └── add-lockdown-columns.mjs  # One-time migration helper
├── raid_ml_sidecar/              # Rust ML sidecar source
│   └── Cargo.toml
├── data/
│   ├── words.json                # Blacklisted words
│   └── warnings.db               # SQLite DB (sqlite mode only)
├── .env                          # Environment variables (not committed)
├── package.json
└── Dockerfile
```

---

## Notes

- Bot token and secrets should **always** be in `.env` — never hardcoded.
- In development only, the bot falls back to reading `token.txt` and `google.txt` if env vars are missing.
- When using Neon or other serverless PostgreSQL providers, the **pooler endpoint** is used for runtime queries. For `prisma db push` / CLI migrations, you may need the **direct (non-pooler) connection URL**.
- The blacklist word file lives at `data/words.json`. Use `/blacklisted` in Discord to manage words, or `/reloadwords` after editing the file manually.
- The Rust ML sidecar is **optional**. The JS fallback is always active and provides the same functionality at slightly lower throughput.
