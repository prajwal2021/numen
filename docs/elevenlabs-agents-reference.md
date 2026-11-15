# ElevenLabs Agents platform: reference for our agent builder

Goal: a self-serve app where a user sets up a phone bot (persona, voice, knowledge base,
transfers, hours, flows) in a UI, with no code changes per agent. ElevenLabs' Agents platform
is the model for the UI. Sources: ElevenLabs docs (Nov 2026) and the real "CLA" / "TTU Online"
agents in our ElevenLabs account. Items marked *(from memory)* are UI details I recall but
could not confirm in the docs; check them against the live dashboard before copying.

## 1. App layout

**Left sidebar (workspace level)** *(from memory)*: Agents · Knowledge Base · Tools ·
Phone Numbers · Conversations (call history) · Analytics · Batch calling · Settings (secrets,
webhooks).

Workspace-level libraries are shared across agents:
- **Knowledge Base**: documents are managed once and attached to many agents. Each document
  has an **Agents** tab showing which agents use it, and can't be deleted while one depends on it.
- **Tools**: webhook tools, client tools, built-in system tools.
- **Analysis library**: evaluation criteria and data-collection fields are workspace items
  attached to many agents; editing one updates every agent using it.
- **Phone numbers**: each number has a label and an assigned agent (ours: "Online+" → TTU Online,
  "CLA" → CLA, "Dev Number" → none).

**Agent page**: header with the agent name, a **Test / Preview** button (talk to it in the
browser) and save/publish. Settings are split into tabs *(names partly from memory)*:

| Tab | What's in it |
|---|---|
| **Agent** | Language (+ additional languages), **First message**, **System prompt**, dynamic variables, **LLM** + temperature, **Knowledge base** (attach docs, RAG toggle), **Tools** (incl. system tools), MCP servers |
| **Workflow** | Visual graph editor (section 2) |
| **Voice** | Voice picker, TTS model, sliders for **stability / speed / similarity**, latency optimization, multi-voice |
| **Analysis** | **Evaluation criteria** (did the call succeed?) and **Data collection** fields extracted from each call |
| **Security** | Authentication, guardrails, allowed overrides |
| **Advanced** | Turn-taking / interruptions, timeouts, max call duration, audio formats, privacy *(from memory)* |
| **Widget** | Embeddable web widget appearance *(from memory)* |
| **Tests** | Scripted test conversations *(from memory)* |

## 2. Workflows: the visual flow builder

A canvas of **nodes** connected by **edges**, edited in the agent's **Workflow** tab. Stored as
JSON under the agent's `workflow` key: `nodes` and `edges` keyed by ID; each node lists its
outgoing `edge_order`; each edge has `source`, `target`, `forward_condition`.

**Node types**
| Node | Purpose | Settings |
|---|---|---|
| **Subagent** | Change behavior for one phase of the call | System prompt (append or override), LLM, voice; **Include global knowledge base** toggle + additional docs; **Include global tools** toggle + additional tools |
| **Say** | Speak one message, then continue | **Literal** (exact text, per-language translations) or **Prompt** (LLM writes it from a description) |
| **Dispatch tool** | Run a tool call that is guaranteed to execute | Has **success** and **failure** outgoing edges |
| **Update state** | Set dynamic variables every time the flow passes | Expressions; the LLM doesn't decide |
| **Agent transfer** | Hand the call to another AI agent | Target agent |
| **Transfer to number** | Hand the call to a human by phone | Phone number |
| **End** | End the conversation gracefully | |

**Edge conditions**
- **LLM condition**: natural language the LLM evaluates live ("caller asks about billing"), plus a display-only **Label**.
- **Expression**: deterministic, on variables and structured data ("is_business_hours == false").
- **None**: unconditional; for fixed sequences and default fallbacks.
- Edges are **forward** (main path) or **backward** (loop back to retry or re-ask).

**Workflow analytics**: once live, the Workflow tab can overlay call data on the graph: entries per
node, average time in each node, where calls ended, and how traffic split across edges. A node
inspector links to the matching calls in history.

## 3. How our current bot maps onto that model

| What our Pipecat bot does today (code) | Equivalent in the builder (config) |
|---|---|
| `GREETING` | Agent tab → First message |
| `cla_prompt.md` | Agent tab → System prompt |
| `OPENAI_MODEL` | Agent tab → LLM |
| ElevenLabs voice ID / speed / stability / similarity | Voice tab |
| `kb.py` → CLA RAG service | Knowledge base (ours is an external RAG service per agent: URL + key) |
| Strict RAG: answers spoken word for word, no own knowledge | Agent-level "strict knowledge base" toggle (ElevenLabs has no direct equivalent) |
| `transfer_to_live_agent` → `TRANSFER_NUMBER` | Transfer to number node / system tool |
| Office hours + holidays → `AFTER_HOURS_TRANSFER_NUMBER` | Expression edge on a business-hours variable → transfer-to-number node |
| Echo/interruption settings (`min_words=3`, mute during greeting) | Advanced tab → turn-taking |
| `RING_SECONDS` | Phone number settings |
| Twilio number → webhook | Phone Numbers page: number → assigned agent |

The call flow we built in code, drawn as a workflow:

```
[Start] ──expr: closed──► [Say: "Our office is currently closed..."] ──► [Transfer to number: after-hours]
   │
   └─expr: open──► [Say: greeting] ──► [Subagent: Ava + KB] ──llm: wants a person──► [Transfer to number: support]
                                            │  ▲
                                            └──┘ (each question: KB lookup; no answer → offer transfer)
```

## 4. Things worth copying for our app

1. Two levels: **workspace libraries** (KB docs, tools, numbers, analysis items) and **agents** that reference them.
2. **Tabbed agent editor** with a live **Test** button, so non-developers can change and try a bot in minutes.
3. **Workflow canvas** with a small set of node types and three kinds of edge conditions (LLM, expression, unconditional).
4. **Phone numbers as first-class objects** assigned to agents. Moving a number between agents is a dropdown, not a webhook edit.
5. **Conversation history + analytics** per agent (transcripts, success evaluation, extracted fields), overlaid on the workflow graph.
6. Everything stored as **one JSON config per agent**, so the runtime (our Pipecat server) loads config per call instead of code per agent.

## Sources

- [Agent workflows](https://elevenlabs.io/docs/eleven-agents/customization/agent-workflows)
- [Introducing Agent Workflows (blog)](https://elevenlabs.io/blog/introducing-agent-workflows)
- [Agents platform: build overview](https://elevenlabs.io/docs/agents-platform/build/overview)
- [Knowledge base: dashboard](https://elevenlabs.io/docs/agents-platform/customization/knowledge-base/dashboard)
- [Agent analysis](https://elevenlabs.io/docs/eleven-agents/customization/agent-analysis)
- [Data collection](https://elevenlabs.io/docs/eleven-agents/customization/agent-analysis/data-collection.md)
- [Guardrails (blog, Security tab)](https://elevenlabs.io/blog/guardrails)
