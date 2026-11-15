# Numen: voice agents for your phone lines

A self-serve platform for phone bots, in the style of the ElevenLabs Agents platform.
Create an agent, attach a knowledge base, assign a Twilio number, and it answers calls, all
from the web app with no code changes per agent.

```
caller ─► Twilio ─POST /incoming─► server.py ── finds the agent for the dialed number,
                                                 rings, then streams audio over /ws
        ◄────── wss /ws ─────────► numen/bot.py: ElevenLabs STT → OpenAI → ElevenLabs TTS
                                       │  tools: search_knowledge_base · transfer_to_live_agent
                                       ▼
                                   RAG service (POST {url}/answer)

web app (Next.js, :3000) ── /api ──► server.py admin API ──► PostgreSQL
```

## What you can do in the web app

| Page | |
|---|---|
| **Home** | Calls, average duration, knowledge-base answer rate, transfers, calls per day, setup checklist |
| **Agents** | Create (blank or copy), edit, duplicate, delete. Tabs: **Agent** (first message, system prompt, LLM, full-prompt preview) · **Workflow** (the call flow as a graph; click a step to edit it) · **Voice** (ElevenLabs voice library with previews, model, speed/stability/similarity, preview with settings) · **Knowledge** (knowledge base, word-for-word vs. rephrase, send-every-question, filler/follow-up lines, test question) · **Call routing** (time zone, weekly hours, holidays, live-agent transfer, after-hours behavior and messages) · **Advanced** (ring time, greeting can't be interrupted, words needed to interrupt) · **Conversations**. **Test agent** chats with the agent using its real prompt, model and knowledge base (transfers simulated). Save with the save bar or ⌘S. |
| **Knowledge Base** | Add RAG services (URL, key, timeout, fallback message), test the connection, run test queries, see which agents use each. One in use can't be deleted. |
| **Phone Numbers** | Import from Twilio or add manually, assign to an agent, live status (connected / points elsewhere / not in account), one-click Connect (sets the Twilio voice webhook). |
| **Conversations** | Every call: transcript with tool calls and lookups inline, knowledge-base lookups (question, result, latency, answer), the exact configuration and system prompt used, and all events. |
| **Settings** | Workspace name, public URL (with ngrok detection), Twilio / ElevenLabs / OpenAI keys with connection tests. |

## Run it

Requirements: PostgreSQL with a `numen` database, Python via `uv`, Node 22, ngrok.

```bash
createdb numen
```

```bash
cp .env.example .env
```

Fill in `.env` (keys can also be entered later in Settings). Keep the Python environment on
the internal disk; from the USB SSD this project lives on, startup takes minutes instead of seconds:

```bash
export UV_PROJECT_ENVIRONMENT=$HOME/.venvs/numen
```

```bash
uv sync
```

Start the server. The first start creates the tables and, on an empty database, imports the
original CLA agent from `.env`:

```bash
uv run server.py
```

Start the web app in a second terminal, then open http://localhost:3000:

```bash
cd web && npm install && npm run dev
```

Expose the server to Twilio in a third terminal. Then in the app: Settings → Detect ngrok →
Save, and Phone Numbers → Connect.

```bash
ngrok http 7860
```

For production, run `npm run build && npm start` in `web/`. Set `NUMEN_API_URL` if the API
isn't at http://127.0.0.1:7860.

## Users, roles and security

- **First visit** creates the first admin (there are no default accounts). Everyone signs in with
  their own email and password; sessions last 7 days in an httpOnly cookie.
- **Roles.** *Admin*: everything, including Users, Audit logs, Settings (API keys, email), deleting
  agents and knowledge bases, and adding/connecting/removing phone numbers. *User*: build and test
  agents and knowledge bases, assign numbers to agents, view the dashboard and conversations.
- **Admins manage users** (Admin > Users): invite by link or create with a temporary password
  (changed at first sign-in), change role, disable/enable, send a reset link, sign out everywhere,
  unlock, delete. You can't demote, disable or delete yourself, and the last admin can't be removed.
- **Passwords**: scrypt-hashed; at least 10 characters mixing letters with numbers or symbols.
  5 failed sign-ins lock the account for 15 minutes. Forgot password emails a single-use link valid
  for 1 hour (invites: 72 hours); resetting signs out every other session. Sign-in and forgot-password
  answers never reveal whether an email has an account. Users manage their own profile, password and
  sessions under Account.
- **Email** (Settings > Email, SMTP) sends resets and invites. Until it's set up, admins copy the links
  from the Users page.
- **Cross-site requests** that change data are rejected; provider keys, the SMTP password and
  knowledge-base keys are never returned by the API after saving.

## Audit logs

Admin > Audit logs shows, per user, with time, page, IP and device: every **click** and **page view**
in the web app (what was clicked, never what was typed), every **change** made through the API (with
which agent sections or settings fields changed; secrets never), **sign-ins** and failures, password
resets, **user management**, finished **calls**, **system** events and **errors**. Filter by type,
user, text and date range; open any entry for details; live auto-refresh; export CSV. Kept 90 days.

## Call behavior (per agent)

- **Strict RAG.** With "word for word", the knowledge base's answer is spoken verbatim and the LLM
  never rewords it. With "send every question", off-topic questions go to the knowledge base too,
  so the LLM never answers from its own knowledge. No answer, a timeout or an error speaks the
  knowledge base's fallback, which offers a transfer.
- **Routing.** During office hours the agent answers. Outside them it either answers, or says a
  short message and transfers to the after-hours number. Live-agent transfers go to the transfer
  number during office hours, else the after-hours number, else voicemail. The hold message plays
  in full before the transfer. Pipecat's automatic hang-up is off, because it would end a call that
  was just transferred.
- **Echo handling.** The caller can't interrupt the first message, and must say a few words to
  interrupt the agent mid-sentence, so line echo doesn't cut it off.

## Logging

Each call is stored in the `calls` table (summary columns plus the full record as JSONB, shown in
Conversations) and in `logs/calls/<date>/<time>_<CallSid>.json` and `.log` (the full debug log
for that call). The record has the caller and dialed numbers, the agent, a configuration snapshot
(RAG settings with the key masked, LLM, voice, routing, the exact system prompt), a timeline
(what the caller said, what the agent said and why, tool calls, every lookup with question,
answer, result, HTTP status and latency, transfers, errors) and a summary. Server-wide log:
`logs/server.log` (rotated daily, kept 30 days).

## Code

| Path | |
|---|---|
| `server.py` | Twilio webhook, media stream, admin API, startup |
| `numen/models.py` | Every setting an agent, knowledge base, number or the workspace supports |
| `numen/store.py` | PostgreSQL persistence |
| `numen/bot.py` | The call pipeline, generic over agents |
| `numen/prompt.py` | Builds the system prompt from the persona plus generated rule sections |
| `numen/routing.py` | Office hours, holidays, transfers |
| `numen/kb_client.py` | RAG service client (timeout, 429 back-off, fallback) |
| `numen/calllog.py` | Per-call logging |
| `numen/api.py`, `integrations.py`, `testchat.py` | API for agents, knowledge bases, numbers, calls, settings; Twilio/ElevenLabs/OpenAI/ngrok; test chat |
| `numen/accounts.py`, `auth.py`, `api_users.py`, `mailer.py` | Users, sessions, password tokens; request auth and roles; auth/account/users/audit API; email |
| `numen/audit.py` | Audit log storage, search, export, retention |
| `numen/seed.py`, `numen/seed_data/` | First-run import of the original CLA agent |
| `web/` | Next.js 16 app (shadcn/ui, TanStack Query, React Flow) |
| `docs/elevenlabs-agents-reference.md` | Research notes on the ElevenLabs Agents UI |
