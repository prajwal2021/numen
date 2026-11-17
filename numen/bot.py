"""The call pipeline, generic over agents.

Per call: Twilio streams audio over a websocket -> we find the agent assigned to the dialed
number -> build caller audio -> ElevenLabs STT -> OpenAI LLM -> ElevenLabs TTS -> caller from
that agent's settings. Tools: search_knowledge_base (the agent's KB) and transfer_to_live_agent.
"""

from __future__ import annotations

import asyncio
import hashlib
import os

from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    FunctionCallResultProperties,
    TTSSpeakFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.runner.types import RunnerArguments
from pipecat.runner.utils import parse_telephony_websocket
from pipecat.serializers.twilio import TwilioFrameSerializer
from pipecat.services.elevenlabs.stt import ElevenLabsRealtimeSTTService
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
from pipecat.services.llm_service import FunctionCallParams
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.transports.base_transport import BaseTransport
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams, FastAPIWebsocketTransport
from pipecat.turns.user_mute import MuteUntilFirstBotCompleteUserMuteStrategy
from pipecat.turns.user_start import MinWordsUserTurnStartStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.workers.runner import WorkerRunner

from . import kb_client, routing, store
from .capacity import limiter
from .calllog import CallLog
from .models import Agent, KnowledgeBase
from .prompt import system_prompt

UNASSIGNED_MESSAGE = "We're sorry, this number is not set up yet. Please try again later. Goodbye."


class CallSession:
    """Per-call state shared with the tool handlers (via PipelineWorker.app_resources)."""

    def __init__(self, agent: Agent, kb: KnowledgeBase | None, call_sid: str | None, log: CallLog):
        self.agent = agent
        self.kb = kb
        self.call_sid = call_sid
        self.log = log
        self.worker: PipelineWorker | None = None
        self.transferring = False
        self._started = asyncio.Event()
        self._stopped = asyncio.Event()

    def on_frame(self, frame) -> None:
        if isinstance(frame, BotStartedSpeakingFrame):
            self._stopped.clear()
            self._started.set()
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._stopped.set()

    async def say(self, text: str, source: str) -> None:
        """Speak a fixed line (not LLM-written) and log it."""
        self.log.event("bot_said", source=source, text=text)
        await self.worker.queue_frames([TTSSpeakFrame(text)])

    async def say_and_wait(self, text: str, source: str) -> None:
        """Speak `text` and return once the caller has heard it."""
        self.log.event("bot_said", source=source, text=text)
        self._started.clear()
        self._stopped.clear()
        await self.worker.queue_frames([TTSSpeakFrame(text)])
        try:
            await asyncio.wait_for(self._started.wait(), 10)
            await asyncio.wait_for(self._stopped.wait(), 60)
        except asyncio.TimeoutError:
            self.log.error("timed out waiting for speech to finish", text=text)
        await asyncio.sleep(0.5)  # let Twilio play out its audio buffer

    async def transfer(self, number: str | None, message: str, reason: str) -> bool:
        """Say `message`, then move the call to `number`. False if it couldn't."""
        if not number or not self.call_sid or self.transferring:
            why = "no transfer number configured" if not number else (
                "no call SID" if not self.call_sid else "already transferring")
            self.log.transfer(number=number, reason=reason, success=False, error=why)
            return False
        self.transferring = True
        await self.say_and_wait(message, source="transfer_message")
        ok, err = await routing.transfer_call(self.call_sid, number)
        self.log.transfer(number=number, reason=reason, office_open=routing.office_is_open(self.agent.routing),
                          success=ok, error=err)
        if ok:
            self.log.end_reason = f"transferred ({reason})"
            return True
        self.transferring = False
        return False


# ---------------------------------------------------------------------------- tools


async def search_knowledge_base(params: FunctionCallParams, question: str):
    """Answer the caller's question from the knowledge base.

    Args:
        question: The caller's question, in their own words.
    """
    s: CallSession = params.app_resources
    k = s.agent.knowledge
    s.log.event("tool_call", name="search_knowledge_base", arguments={"question": question})
    r = await kb_client.lookup(s.kb, question)
    if k.answer_mode == "verbatim":
        # Strict RAG: the caller hears the KB's text word for word; the LLM doesn't run on it.
        spoken = f"{r.text} {k.follow_up}".strip() if r.found else r.text
        s.log.kb_lookup(**r.log_fields(), answer_mode="verbatim", spoken_to_caller=spoken)
        s.log.event("bot_said", source="kb_answer" if r.found else "kb_fallback", text=spoken)
        await params.llm.push_frame(TTSSpeakFrame(spoken))
        await params.result_callback(
            {"found": r.found, "spoken_to_caller": spoken},
            properties=FunctionCallResultProperties(run_llm=False),
        )
    else:
        s.log.kb_lookup(**r.log_fields(), answer_mode="rephrase")
        await params.result_callback({"found": r.found, "text": r.text})


async def transfer_to_live_agent(params: FunctionCallParams):
    """Transfer the caller to a live agent. Use when the caller asks for a person or a live
    agent, or says yes to an offer to transfer them."""
    s: CallSession = params.app_resources
    s.log.event("tool_call", name="transfer_to_live_agent", arguments={})
    number, message = routing.transfer_target(s.agent.routing)
    await params.result_callback(
        {"status": "transferring"}, properties=FunctionCallResultProperties(run_llm=False)
    )

    async def run():
        if not await s.transfer(number, message, reason="caller asked for a live agent"):
            await s.say_and_wait(s.agent.routing.transfer_failed_message, source="transfer_failed")

    # Its own task, so a caller talking over the hold message can't cancel the transfer.
    asyncio.create_task(run())


# ---------------------------------------------------------------------------- warm-up

# Building a SileroVADAnalyzer creates an ONNX session (~2 s). Each call needs its own
# (it is stateful), so keep a few built ahead of time and top the pool up whenever a call
# takes one. Each caller pops its own future: sharing one would let two simultaneous callers
# drive the same analyzer. A burst bigger than the pool just builds extras in parallel threads.
VAD_POOL_SIZE = int(os.getenv("VAD_POOL_SIZE", "3"))
_spare_vads: list[asyncio.Future] = []


def _build_vad() -> asyncio.Future:
    return asyncio.ensure_future(asyncio.to_thread(SileroVADAnalyzer))


def _top_up_vads() -> None:
    while len(_spare_vads) < VAD_POOL_SIZE:
        _spare_vads.append(_build_vad())


async def prepare_spare_vad() -> None:
    _top_up_vads()
    await asyncio.gather(*_spare_vads)


async def _take_vad() -> SileroVADAnalyzer:
    fut = _spare_vads.pop(0) if _spare_vads else _build_vad()
    _top_up_vads()
    return await fut


def prewarm() -> None:
    """Load the VAD and smart-turn models and the services' lazy imports before the first
    call, so callers don't hear dead air. Runs in a worker thread at server startup."""
    LLMContextAggregatorPair(LLMContext(), user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()))
    ElevenLabsTTSService(api_key="prewarm", settings=ElevenLabsTTSService.Settings(voice="prewarm"))
    ElevenLabsRealtimeSTTService(api_key="prewarm")
    OpenAILLMService(api_key="prewarm")


# ---------------------------------------------------------------------------- the call


def config_snapshot(agent: Agent, kb: KnowledgeBase | None, prompt: str) -> dict:
    """Every setting that shapes this call, for the call log (no secrets)."""
    r = agent.routing
    return {
        "agent": {"id": agent.id, "name": agent.name, "updated_at": agent.updated_at},
        "rag": kb_client.config_snapshot(kb),
        "knowledge": agent.knowledge.model_dump(),
        "llm": agent.llm.model_dump(),
        "prompt": {"sha256": hashlib.sha256(prompt.encode()).hexdigest()[:16], "chars": len(prompt), "text": prompt},
        "greeting": agent.greeting,
        "voice": agent.voice.model_dump(),
        "stt": {"provider": "elevenlabs", "service": "ElevenLabsRealtimeSTTService"},
        "conversation": agent.conversation.model_dump(),
        "routing": {**r.model_dump(mode="json"), "office_open_at_call_start": routing.office_is_open(r)},
    }


async def run_bot(transport: BaseTransport, runner_args: RunnerArguments, agent: Agent, log: CallLog,
                  call_sid: str | None) -> None:
    # Blocking database reads run in threads: the event loop also carries every other live call's audio.
    settings = await asyncio.to_thread(store.get_settings)
    kb_id = agent.knowledge.knowledge_base_id
    kb = await asyncio.to_thread(store.get, KnowledgeBase, kb_id) if kb_id else None
    session = CallSession(agent, kb, call_sid, log)
    prompt = system_prompt(agent)
    log.set_config(config_snapshot(agent, kb, prompt))

    v = agent.voice
    tts = ElevenLabsTTSService(
        api_key=settings.elevenlabs_api_key,
        settings=ElevenLabsTTSService.Settings(
            voice=v.voice_id, model=v.model, speed=v.speed, stability=v.stability,
            similarity_boost=v.similarity_boost,
        ),
    )
    stt = ElevenLabsRealtimeSTTService(api_key=settings.elevenlabs_api_key)
    llm = OpenAILLMService(
        api_key=settings.openai_api_key,
        settings=OpenAILLMService.Settings(model=agent.llm.model, system_instruction=prompt),
    )
    tools = [search_knowledge_base] if kb else []
    if agent.routing.transfer_enabled:
        tools.append(transfer_to_live_agent)
    context = LLMContext(tools=tools) if tools else LLMContext()

    @llm.event_handler("on_function_calls_started")
    async def on_function_calls_started(service, function_calls):
        filler = agent.knowledge.lookup_filler
        if filler and any(c.function_name == "search_knowledge_base" for c in function_calls):
            log.event("bot_said", source="lookup_filler", text=filler)
            await service.push_frame(TTSSpeakFrame(filler))

    conv = agent.conversation
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=await _take_vad(),
            # Phone lines echo the bot's own voice back; without these the bot hears itself
            # as the caller interrupting.
            user_mute_strategies=[MuteUntilFirstBotCompleteUserMuteStrategy()] if conv.mute_during_greeting else [],
            user_turn_strategies=UserTurnStrategies(
                start=[MinWordsUserTurnStartStrategy(min_words=conv.min_words_to_interrupt)],
            ),
        ),
    )

    @user_aggregator.event_handler("on_user_turn_message_added")
    async def on_user_turn_message_added(aggregator, message):
        log.event("caller_said", text=message.content)

    @assistant_aggregator.event_handler("on_assistant_turn_stopped")
    async def on_assistant_turn_stopped(aggregator, message):
        if message.content:
            log.event("assistant_turn", text=message.content, interrupted=message.interrupted)

    worker = PipelineWorker(
        Pipeline([transport.input(), stt, user_aggregator, llm, tts, transport.output(), assistant_aggregator]),
        params=PipelineParams(
            audio_in_sample_rate=8000,  # Twilio media streams are 8 kHz mu-law
            audio_out_sample_rate=8000,
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
        app_resources=session,
    )
    session.worker = worker
    worker.set_reached_downstream_filter((BotStartedSpeakingFrame, BotStoppedSpeakingFrame))

    @worker.event_handler("on_frame_reached_downstream")
    async def on_frame_reached_downstream(worker, frame):
        session.on_frame(frame)

    runner = WorkerRunner(handle_sigint=runner_args.handle_sigint)
    await runner.add_workers(worker)

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        r = agent.routing
        open_now = routing.office_is_open(r)
        if routing.after_hours_transfer(r):
            log.event("call_connected", office_open=False, route="after_hours_transfer")
            asyncio.create_task(after_hours(session))
            return
        log.event("call_connected", office_open=open_now, route="agent")
        asyncio.create_task(kb_client.warm(kb))
        # The greeting is spoken verbatim, and added to the context so the LLM knows the
        # caller has been greeted.
        await session.say(agent.greeting, source="greeting")

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        log.event("call_disconnected", transferred=session.transferring)
        if not session.transferring:
            log.end_reason = "caller hung up"
        await runner.cancel()

    async def enforce_max_duration():
        """Hard cap on call length: a stuck or abusive call can't hold a slot (and bills) forever."""
        await asyncio.sleep(limiter.limits.max_call_s)
        if session.transferring:
            return
        log.end_reason = "maximum call length reached"
        log.event("max_call_length", seconds=limiter.limits.max_call_s)
        await session.say_and_wait("We've reached the maximum length for this call. Goodbye.", source="max_duration")
        await runner.cancel()

    limit_task = asyncio.create_task(enforce_max_duration()) if limiter.limits.max_call_s else None
    try:
        await runner.run()
    except Exception as e:
        log.error("pipeline crashed", exception=f"{type(e).__name__}: {e}")
        raise
    finally:
        if limit_task:
            limit_task.cancel()


async def after_hours(session: CallSession) -> None:
    """Outside office hours: a short message, then the after-hours line. If the transfer
    fails, the agent greets and answers the call instead."""
    r = session.agent.routing
    if await session.transfer(r.after_hours_number, r.after_hours_message, reason="called outside office hours"):
        return
    asyncio.create_task(kb_client.warm(session.kb))
    await session.say(session.agent.greeting, source="greeting")


async def bot(runner_args: RunnerArguments) -> None:
    """Entry point for one Twilio media stream."""
    _, call_data = await parse_telephony_websocket(runner_args.websocket)
    params = call_data.get("body") or {}  # <Parameter>s from the TwiML in server.py
    call_sid = call_data.call_id
    # The slot reserved at /incoming becomes live here. No slot (reservation expired, or someone
    # opened /ws directly) and the server is full: refuse rather than degrade every live call.
    if not limiter.connect(call_sid, params.get("from") or ""):
        logger.warning(f"Refused media stream for {call_sid}: at capacity or draining")
        await runner_args.websocket.close()
        return
    try:
        log = await asyncio.to_thread(CallLog, call_sid, call_data.stream_id, params.get("from"), params.get("to"))
        with logger.contextualize(call_sid=call_sid):
            try:
                agent = None
                if params.get("agent_id"):
                    agent = await asyncio.to_thread(store.get, Agent, params["agent_id"])
                if agent is None:
                    number = await asyncio.to_thread(store.number_for, params.get("to"))
                    agent = await asyncio.to_thread(store.get, Agent, number.agent_id) if number and number.agent_id else None
                log.set_agent(agent.id if agent else None, agent.name if agent else None)
                logger.info(f"Call {call_sid} from {params.get('from')} to {params.get('to')} -> "
                            f"agent {agent.name if agent else 'NONE'} "
                            f"(active {limiter.live}/{limiter.limits.max_calls})")
                transport = _transport(runner_args, call_data)
                if agent is None:
                    log.error("no agent assigned to the dialed number", to=params.get("to"))
                    log.end_reason = "no agent assigned"
                    return
                await run_bot(transport, runner_args, agent, log, call_sid)
            finally:
                await asyncio.to_thread(log.finish)
    finally:
        limiter.release(call_sid)  # frees the slot and promotes the next caller in the queue


def _transport(runner_args: RunnerArguments, call_data) -> FastAPIWebsocketTransport:
    # auto_hang_up is off: when the session ends, Twilio already ends the call unless it was
    # transferred, and hanging up by call SID would cut off a transfer.
    serializer = TwilioFrameSerializer(
        stream_sid=call_data["stream_id"],
        call_sid=call_data["call_id"],
        params=TwilioFrameSerializer.InputParams(auto_hang_up=False),
    )
    return FastAPIWebsocketTransport(
        websocket=runner_args.websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True, audio_out_enabled=True, add_wav_header=False, serializer=serializer,
        ),
    )
