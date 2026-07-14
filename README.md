# Pac-Man DDA Web Data Collector

A five-round browser game for collecting anonymous, project-specific player
performance data and trusted difficulty feedback. The collector works on desktop
and mobile, stores failed submissions in a browser queue, and submits records to
Supabase when cloud configuration is available.

Current production build: `web-collector-v17` at
`https://pac-man.kushanesala.me`.

## Current Gameplay Rules

- Pac-Man accepts buffered turns before a junction and continues forward until the requested route opens.
- Mobile swipes register during the gesture, while keyboard, D-pad, pause, and fullscreen controls remain available.
- Easy uses 2 slower, less-persistent ghosts, 4 freeze pellets, and a 6.5-second freeze.
- Medium uses 3 faster, more-persistent ghosts, 3 freeze pellets, and a 5-second freeze.
- Hard uses 4 significantly faster, strongly pursuing ghosts, 2 freeze pellets, and a 3.8-second freeze.
- Multi-ghost pressure relief remains active to reduce unfair sandwich situations.
- Freeze pellets are placed across distant playable maze regions instead of fixed in one area.

## Local Setup

Requirements: Node.js `>=22.13.0`.

1. Copy `.env.example` to `.env.local`.
2. In Supabase SQL Editor, run both files in `supabase/migrations/` in numeric order.
3. Put the project's public anonymous key in
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Never use the service-role key in this app.
4. Run `npm install` and `npm run dev`.
5. Open `http://localhost:3000`.

Without the anonymous key, gameplay still works and records remain in the local
browser queue until cloud configuration becomes available. The collector retries
pending records automatically while the page is open.

## Participant Flow

1. Enter a participant code and accept the anonymous-data notice.
2. Complete five progressively larger rounds using arrow keys, WASD, or touch.
3. Provide `Too difficult`, `Balanced`, or `Too easy` feedback when prompted.
4. Optionally leave a short written note after the session.
5. Play another session if requested by the researcher.

Difficulty starting conditions rotate deterministically across participants so
Easy, Medium, and Hard receive comparable coverage. Feedback is requested after
rounds 2 and 4. Player names are converted to persistent anonymous UUIDs and are
not sent to the database.

Run both SQL files in order for a new Supabase project:

1. `supabase/migrations/001_web_collection.sql`
2. `supabase/migrations/002_session_feedback.sql`

## Verification

```bash
npm run build
npm test
```

The database policies allow public inserts only. Anonymous clients cannot read,
update, or delete participant records.
