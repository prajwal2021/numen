"""Typing sound mixer and the background-voice turn-start gate (numen/audio.py)."""

import asyncio
import time

import numpy as np
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    InputAudioRawFrame,
    InterimTranscriptionFrame,
    MixerEnableFrame,
    MixerUpdateSettingsFrame,
    TranscriptionFrame,
)

from numen import audio
from numen.audio import TYPING_PEAK, CallerSpeechTurnStartStrategy, TypingMixer, typing_loop

SR = 8000
CHUNK = b"\x00" * 640  # 40 ms of 16-bit silence at 8 kHz


def run(coro):
    return asyncio.run(coro)


def tx(text: str) -> TranscriptionFrame:
    return TranscriptionFrame(text=text, user_id="caller", timestamp="")


# ---------------------------------------------------------------------------- typing sound


def test_typing_loop_is_faint_and_not_silent():
    loop = typing_loop(SR)
    assert loop.dtype == np.int16
    assert len(loop) == int(SR * audio.TYPING_LOOP_SECONDS)
    peak = np.abs(loop).max() / 32767
    assert 0.5 * TYPING_PEAK < peak <= TYPING_PEAK + 1e-3
    # Keystrokes, not a hiss: most of the loop is silence between keys.
    assert (np.abs(loop) < 30).mean() > 0.5


def test_mixer_starts_disabled_and_passes_audio_through():
    m = TypingMixer()
    run(m.start(SR))
    speech = (np.ones(320, dtype=np.int16) * 1000).tobytes()
    assert run(m.mix(speech)) == speech
    assert run(m.mix(CHUNK)) == CHUNK


def test_mixer_types_while_enabled_and_stops_when_disabled():
    async def go():
        m = TypingMixer()
        await m.start(SR)
        await m.process_frame(MixerEnableFrame(True))
        out = b"".join([await m.mix(CHUNK) for _ in range(100)])  # 4 s
        assert np.abs(np.frombuffer(out, dtype=np.int16)).max() > 0
        await m.process_frame(MixerEnableFrame(False))
        assert await m.mix(CHUNK) == CHUNK
    run(go())


def test_mixer_never_clips():
    async def go():
        m = TypingMixer()
        await m.start(SR)
        await m.process_frame(MixerEnableFrame(True))
        loud = (np.ones(320, dtype=np.int16) * 32767).tobytes()
        for _ in range(200):
            out = np.frombuffer(await m.mix(loud), dtype=np.int16)
            assert out.max() <= 32767 and out.min() >= -32768
    run(go())


def test_mixer_stop_on_speech_waits_for_a_gap_then_stops_at_next_speech():
    async def go():
        m = TypingMixer()
        await m.start(SR)
        speech = (np.ones(320, dtype=np.int16) * 2000).tobytes()
        await m.process_frame(MixerEnableFrame(True))
        await m.process_frame(MixerUpdateSettingsFrame({"stop_on_speech": True}))
        await m.mix(speech)  # the filler line still playing: keep typing
        assert m.enabled
        await m.mix(CHUNK)  # gap
        assert m.enabled
        assert await m.mix(speech) == speech  # the answer starts: typing stops
        assert not m.enabled
    run(go())


def test_mixer_turns_itself_off(monkeypatch):
    async def go():
        m = TypingMixer()
        await m.start(SR)
        await m.process_frame(MixerEnableFrame(True))
        m._enabled_at = time.monotonic() - audio.TYPING_MAX_SECONDS - 1
        assert await m.mix(CHUNK) == CHUNK
        assert not m.enabled
    run(go())


# ---------------------------------------------------------------------------- background voices


def voice(dbfs: float, ms: int = 300) -> list[InputAudioRawFrame]:
    """`ms` of a tone at `dbfs` RMS, as 20 ms phone frames."""
    n = SR * ms // 1000
    amp = 10 ** (dbfs / 20) * 32768 * np.sqrt(2)
    pcm = (np.sin(2 * np.pi * 300 * np.arange(n) / SR) * amp).astype(np.int16)
    return [InputAudioRawFrame(audio=pcm[i:i + 160].tobytes(), sample_rate=SR, num_channels=1)
            for i in range(0, n, 160)]


class Recorder(CallerSpeechTurnStartStrategy):
    def __init__(self, **kw):
        self.ignored: list[str] = []
        kw.setdefault("min_dbfs", -36.0)
        super().__init__(on_ignored=self.ignored.append, **kw)
        self.started = 0
        self.resets = 0

    async def report_user_turn_started(self, *a, **k):
        self.started += 1

    async def trigger_reset_aggregation(self):
        self.resets += 1

    async def feed(self, frames):
        for f in frames:
            await self.process_frame(f)


def test_frame_dbfs():
    assert abs(audio.frame_dbfs(voice(-20, 20)[0].audio) - -20) < 0.5
    assert audio.frame_dbfs(b"\x00" * 320) < -100


def test_transcript_without_caller_speech_is_ignored():
    async def go():
        s = Recorder(min_words=3)
        await s.process_frame(tx("and then she said the game was"))
        assert s.started == 0 and s.resets == 1
        assert s.ignored == ["and then she said the game was"]
    run(go())


def test_quiet_background_voice_is_ignored():
    async def go():
        s = Recorder(min_words=3)
        await s.feed(voice(-46, 2000))
        await s.process_frame(tx("did you see the game last night"))
        assert s.started == 0 and s.ignored
    run(go())


def test_short_word_at_caller_level_starts_turn():
    async def go():
        s = Recorder(min_words=3)
        await s.feed(voice(-30, 300))  # a quiet "bye"
        await s.process_frame(tx("Bye."))
        assert s.started == 1 and not s.ignored
    run(go())


def test_a_click_is_not_a_voice():
    async def go():
        s = Recorder(min_words=3)
        await s.feed(voice(-20, 40))
        await s.process_frame(tx("hmm"))
        assert s.started == 0
    run(go())


def test_late_transcript_after_caller_stopped_still_counts():
    async def go():
        s = Recorder(min_words=3)
        await s.feed(voice(-22, 500))
        s._caller_heard_at -= 1.5
        await s.process_frame(tx("thank you"))
        assert s.started == 1 and not s.ignored
    run(go())


def test_transcript_long_after_caller_stopped_is_ignored():
    async def go():
        s = Recorder(min_words=3)
        await s.feed(voice(-22, 500))
        s._caller_heard_at -= audio.TRANSCRIPT_GRACE_SECS + 0.5
        await s.process_frame(tx("background chatter"))
        assert s.started == 0 and s.ignored
    run(go())


def test_interrupting_the_agent_needs_min_words():
    async def go():
        s = Recorder(min_words=3)
        await s.process_frame(BotStartedSpeakingFrame())
        await s.feed(voice(-22, 500))
        await s.process_frame(InterimTranscriptionFrame(text="uh huh", user_id="c", timestamp=""))
        assert s.started == 0
        await s.process_frame(InterimTranscriptionFrame(text="wait I have a question", user_id="c", timestamp=""))
        assert s.started == 1
    run(go())


def test_words_inside_a_caller_turn_are_never_dropped():
    async def go():
        s = Recorder(min_words=3)
        await s.handle_user_turn_started()
        await s.process_frame(tx("and my student id question"))
        assert s.resets == 0 and not s.ignored
        await s.handle_user_turn_stopped()
        await s.process_frame(tx("tv noise"))
        assert s.resets == 1
    run(go())


def test_filter_off_reacts_to_any_transcript():
    async def go():
        s = Recorder(min_words=3, min_dbfs=None)
        await s.process_frame(tx("hello"))
        assert s.started == 1 and not s.ignored
    run(go())


def test_strong_filter_is_stricter():
    assert audio.LOUDNESS_DB_BY_FILTER["strong"] > audio.LOUDNESS_DB_BY_FILTER["standard"]


def test_short_reply_phrases():
    for t in ("Thank you.", "Okay.", "No, thank you.", "Okay. Thank you.", "That's all.", "Goodbye.", "Yeah.", "Thanks so much!"):
        assert audio.is_short_reply(t), t
    for t in ("this topic", "Would you like additional information", "How much does it cost?", ""):
        assert not audio.is_short_reply(t), t


def test_short_reply_over_the_agent_is_held_until_it_stops():
    from pipecat.frames.frames import BotStoppedSpeakingFrame

    async def go():
        s = Recorder(min_words=3)
        await s.process_frame(BotStartedSpeakingFrame())
        await s.feed(voice(-22, 400))
        await s.process_frame(tx("Thank you."))
        assert s.started == 0 and s.resets == 0  # held, not dropped
        await s.process_frame(InterimTranscriptionFrame(text="good", user_id="c", timestamp=""))
        assert s.resets == 0
        await s.process_frame(BotStoppedSpeakingFrame())
        assert s.started == 1
    run(go())


def test_goodbye_over_the_agent_interrupts():
    async def go():
        s = Recorder(min_words=3)
        await s.process_frame(BotStartedSpeakingFrame())
        await s.feed(voice(-22, 400))
        await s.process_frame(tx("Goodbye."))
        assert s.started == 1
    run(go())


def test_echo_of_the_agent_is_not_held():
    from pipecat.frames.frames import BotStoppedSpeakingFrame

    async def go():
        s = Recorder(min_words=3)
        await s.process_frame(BotStartedSpeakingFrame())
        await s.feed(voice(-22, 400))
        await s.process_frame(tx("this topic"))
        await s.process_frame(BotStoppedSpeakingFrame())
        assert s.started == 0 and s.resets == 1
    run(go())


def test_acknowledgement_mid_answer_is_dropped():
    from pipecat.frames.frames import BotStoppedSpeakingFrame

    async def go():
        s = Recorder(min_words=3)
        await s.process_frame(BotStartedSpeakingFrame())
        await s.feed(voice(-22, 400))
        await s.process_frame(tx("Okay."))
        s._held_at -= audio.HELD_REPLY_SECS + 1  # said long before the agent finished
        await s.process_frame(BotStoppedSpeakingFrame())
        assert s.started == 0 and s.resets == 1
    run(go())


def test_caller_voice_starts_turn_before_the_transcript():
    from pipecat.frames.frames import VADUserStartedSpeakingFrame

    async def go():
        s = Recorder(min_words=3)
        await s.process_frame(VADUserStartedSpeakingFrame())
        await s.feed(voice(-22, 200))
        assert s.started >= 1
    run(go())


def test_background_voice_does_not_start_turn_on_vad():
    from pipecat.frames.frames import VADUserStartedSpeakingFrame

    async def go():
        s = Recorder(min_words=3)
        await s.process_frame(VADUserStartedSpeakingFrame())
        await s.feed(voice(-46, 2000))
        assert s.started == 0
    run(go())


def test_vad_does_not_interrupt_the_agent():
    from pipecat.frames.frames import VADUserStartedSpeakingFrame

    async def go():
        s = Recorder(min_words=3)
        await s.process_frame(BotStartedSpeakingFrame())
        await s.process_frame(VADUserStartedSpeakingFrame())
        await s.feed(voice(-22, 500))
        assert s.started == 0
    run(go())
