# Spec: Agent-managed scheduled tasks (CRONs)

## Goal

Let the agent create, list, and cancel **per-user scheduled tasks** from chat. A task is a natural-language prompt + a cron expression. When a task is due, our backend re-runs the agent (with that user's Composio tools) using the saved prompt — no human in the chat.

## Use case (demo script for the video)

User in chat: *"Send me a Gmail summary of my unread emails every weekday at 9am."*

Agent calls `scheduleTask({ cronExpression: "0 9 * * 1-5", prompt: "Fetch unread Gmail from the last 24h, summarize the top 5, and email me the summary." })` → row inserted in `cron_jobs`.

To demo without waiting overnight, run `scripts/test-cron.sh make-due <id>` and curl the tick endpoint. Viewers see the agent re-run the same prompt autonomously, hitting the user's real Gmail through Composio.

User then in chat: *"Show my schedules"* → agent calls `listMySchedules()` → list rendered.
User: *"Cancel the morning briefing"* → agent calls `cancelSchedule({ id })` → row deleted.

## In scope (v1)

1. **`cron_jobs` table** in Postgres (Drizzle): id, userId, cronExpression, timezone, prompt, enabled, nextRunAt, lastRunAt, lastError, createdAt.
2. **One Vercel cron** in `vercel.json` ticking every minute → `/api/cron/tick`.
3. **`/api/cron/tick`** (GET): authenticates with `CRON_SECRET`, selects due rows, runs each agent inline (Composio tools loaded with `row.userId`), updates `nextRunAt` / `lastRunAt` / `lastError`.
4. **Three agent tools** added to chat:
   - `scheduleTask({ cronExpression, prompt, timezone? })`
   - `listMySchedules()`
   - `cancelSchedule({ id })`

   Each tool captures `session.user.id` from the chat route closure (same pattern as `createDocument`). No hardcoded userIds.
5. **`/admin/schedules` page** — list all schedules for the logged-in user with a delete button (calls `DELETE /api/schedules/:id`).
6. **`scripts/test-cron.sh`** — repurpose existing `test-cron-demo.sh` with subcommands: `list`, `make-due <id>`, `trigger`, `unlock <id>`.

## Explicitly NOT in scope (v1)

These are deliberate cuts from the trustclaw pattern. They matter at scale but not for the tutorial demo. Mentioned at the end of the video as homework.

- **DB-level locking** (`lockedAt`, `lockedBy`, fencing tokens, atomic claim). v1 runs jobs serially in one tick handler — fine for a few users, dangerous if many concurrent crons fire and two ticks overlap.
- **Stale-lock recovery.** Without locking, not needed in v1.
- **Split claim/execute routes.** v1 runs everything inline in `/api/cron/tick`; risks the 60s function timeout if jobs are long.
- **Per-instance batching.** We're per-user, not per-instance.
- **Backfill on missed ticks.** If Vercel skips a tick, the job runs once on the next tick — not multiple catch-up runs.
- **Telegram delivery.** Output is whatever the agent does with its tools (e.g. it sends an email via Gmail). No separate channel yet.
- **Approval flow on schedule creation.** Agent creates schedules immediately; user can cancel.

## Plan (build order)

1. **Add `cron-parser` dep** for cron expression parsing + `computeNextRunAt`.
2. **Schema**: add `cron_jobs` to `lib/db/schema.ts`, generate migration with `pnpm db:generate`, push with `pnpm db:migrate`.
3. **Queries**: add `lib/db/queries.ts` helpers — `createCronJob`, `getDueCronJobs`, `updateCronJobAfterRun`, `getCronJobsByUserId`, `deleteCronJob`.
4. **Tick route**: `app/api/cron/tick/route.ts` — auth → select due → for each, build Composio session for `row.userId`, run `generateText` with `row.prompt` + tools, update row.
5. **Tools**: `lib/ai/tools/schedule-task.ts`, `list-my-schedules.ts`, `cancel-schedule.ts`. Wire into chat route's `localTools`.
6. **Schedules API**: `app/api/schedules/route.ts` (GET list) + `app/api/schedules/[id]/route.ts` (DELETE).
7. **Admin page**: `app/admin/schedules/page.tsx` — server component, lists user's schedules, client subcomponent for delete button.
8. **vercel.json**: change `/api/cron/demo` → `/api/cron/tick`.
9. **Test script**: rewrite `scripts/test-cron-demo.sh` → `scripts/test-cron.sh` with subcommands.

## Production correctness (v1)

- **Per-user isolation**: every row stores `userId`. The tick route loads Composio tools as `composio.create(row.userId).tools()`. No cross-user leakage.
- **Auth**:
  - Tick route requires `Authorization: Bearer ${CRON_SECRET}` (Vercel auto-injects this for crons configured in `vercel.json`). Unauthenticated in dev for the test script.
  - Schedules API + admin page require `auth()` session. Delete endpoint validates `WHERE id = $1 AND userId = $2`.
- **Guest users**: blocked from creating schedules (same gate as Composio in chat route).
- **Cron expression validation**: tools call `cronParser.parseExpression()` and reject invalid input before insert.
- **Idempotency**: tick uses `nextRunAt <= NOW()` to claim rows; after run, recomputes `nextRunAt` from the cron expression. A duplicate tick within the same minute is safe (row already advanced).

## Files added/changed

| File | Action |
|---|---|
| `lib/db/schema.ts` | add `cronJob` table |
| `lib/db/queries.ts` | add 5 helpers |
| `lib/db/migrations/000X_*.sql` | generated |
| `lib/ai/tools/schedule-task.ts` | new |
| `lib/ai/tools/list-my-schedules.ts` | new |
| `lib/ai/tools/cancel-schedule.ts` | new |
| `app/(chat)/api/chat/route.ts` | wire 3 tools into `localTools` |
| `app/api/cron/tick/route.ts` | new |
| `app/api/schedules/route.ts` | new (GET) |
| `app/api/schedules/[id]/route.ts` | new (DELETE) |
| `app/admin/schedules/page.tsx` | new |
| `vercel.json` | retarget cron to `/api/cron/tick` |
| `scripts/test-cron.sh` | replace `test-cron-demo.sh` |
| `package.json` | add `cron-parser` |
