"""Call audio helpers: the faint keyboard-typing sound played during knowledge-base lookups,
and the turn-start strategy that keeps background voices from interrupting the agent.
"""

from __future__ import annotations

import time
from collections import deque

import numpy as np
from loguru import logger
from pipecat.audio.mixers.base_audio_mixer import BaseAudioMixer
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    Frame,
    InputAudioRawFrame,
    InterimTranscriptionFrame,
    MixerControlFrame,
    MixerEnableFrame,
    MixerUpdateSettingsFrame,
    TranscriptionFrame,
)
from pipecat.turns.user_start.base_user_turn_start_strategy import BaseUserTurnStartStrategy
from pipecat.utils.text.word_count import count_spoken_words

# ---------------------------------------------------------------------------- typing sound

# Peak level of a keystroke, as a fraction of full scale. The agent's voice peaks around
# -3 to -8 dBFS on the line; -32 dBFS keeps the typing faint, like someone typing nearby.
TYPING_PEAK = 0.025
TYPING_LOOP_SECONDS = 7.0
# The mixer turns itself off after this long, whatever happens to the lookup.
TYPING_MAX_SECONDS = 20.0


def _keystroke(sr: int, rng: np.random.Generator) -> np.ndarray:
    """One key press: a sharp click (filtered noise, fast decay) over a short low 'thock'."""
    n = int(sr * rng.uniform(0.018, 0.03))
    t = np.arange(n) / sr
    noise = rng.standard_normal(n)
    # A first difference tilts the noise towards the treble, like a plastic key click.
    click = np.diff(noise, prepend=0.0) * np.exp(-t / rng.uniform(0.002, 0.004))
    thock = np.sin(2 * np.pi * rng.uniform(180, 320) * t) * np.exp(-t / 0.008) * 0.6
    k = click + thock
    return k / (np.max(np.abs(k)) or 1.0) * rng.uniform(0.55, 1.0)


def typing_loop(sample_rate: int, seconds: float = TYPING_LOOP_SECONDS, seed: int = 7) -> np.ndarray:
    """A loop of natural-sounding typing: bursts of keys, the odd space bar, short pauses."""
    rng = np.random.default_rng(seed)
    out = np.zeros(int(sample_rate * seconds))
    pos = int(sample_rate * 0.05)
    while True:
        for _ in range(int(rng.integers(3, 9))):  # one word
            k = _keystroke(sample_rate, rng)
            if pos + len(k) >= len(out):
                break
            out[pos:pos + len(k)] += k
            pos += int(sample_rate * rng.uniform(0.07, 0.18))
        else:
            # The odd longer pause, but not in the first seconds: most lookups are short.
            long_pause = pos > sample_rate * 2.5 and rng.random() < 0.25
            pos += int(sample_rate * (rng.uniform(0.35, 0.8) if long_pause else rng.uniform(0.08, 0.2)))
            if pos < len(out) - sample_rate // 4:
                continue
        break
    # Fade the ends so the loop point doesn't click.
    fade = int(sample_rate * 0.02)
    out[:fade] *= np.linspace(0, 1, fade)
    out[-fade:] *= np.linspace(1, 0, fade)
    return (out / (np.max(np.abs(out)) or 1.0) * TYPING_PEAK * 32767).astype(np.int16)


class TypingMixer(BaseAudioMixer):
    """Mixes the typing loop into the call audio while enabled.

    Starts disabled. Control frames:
      MixerEnableFrame(True/False)                     start / stop typing
      MixerUpdateSettingsFrame({"stop_on_speech": True}) stop when the agent next starts talking
    It also stops on its own after TYPING_MAX_SECONDS, so a lookup that is cancelled midway
    (the caller hangs up or talks over it) can never leave it typing.
    """

    def __init__(self, volume: float = 1.0):
        self._volume = volume
        self._loop = np.zeros(0, dtype=np.int16)
        self._pos = 0
        self._enabled = False
        self._enabled_at = 0.0
        self._stop_on_speech = False
        self._saw_silence = False

    async def start(self, sample_rate: int):
        self._loop = (typing_loop(sample_rate) * self._volume).astype(np.int16)

    async def stop(self):
        self._enabled = False

    async def process_frame(self, frame: MixerControlFrame):
        if isinstance(frame, MixerEnableFrame):
            if frame.enable and not self._enabled:
                self._pos = 0
                self._enabled_at = time.monotonic()
            self._enabled = frame.enable
            self._stop_on_speech = False
        elif isinstance(frame, MixerUpdateSettingsFrame) and frame.settings.get("stop_on_speech"):
            self._stop_on_speech = True
            self._saw_silence = False

    @property
    def enabled(self) -> bool:
        return self._enabled

    async def mix(self, audio: bytes) -> bytes:
        if not self._enabled or not len(self._loop):
            return audio
        if time.monotonic() - self._enabled_at > TYPING_MAX_SECONDS:
            self._enabled = False
            return audio
        pcm = np.frombuffer(audio, dtype=np.int16)
        if self._stop_on_speech:
            # Wait for a gap (the filler line finishing), then stop at the next speech.
            if not pcm.any():
                self._saw_silence = True
            elif self._saw_silence:
                self._enabled = False
                return audio
        n = len(pcm)
        idx = (np.arange(n) + self._pos) % len(self._loop)
        self._pos = (self._pos + n) % len(self._loop)
        mixed = pcm.astype(np.int32) + self._loop[idx]
        return np.clip(mixed, -32768, 32767).astype(np.int16).tobytes()


# ---------------------------------------------------------------------------- background voices

# How loud speech must be to count as the caller's, per filter level, in dBFS over 20 ms
# frames of the phone audio. Measured on 8 kHz mu-law: a caller speaking into the phone,
# even quietly or saying one short word ("bye", "yes"), spends 250 ms+ above -33 dBFS;
# voices across the room at -46 dBFS never reach -40, and loud ones at -40 dBFS spend
# under 100 ms above -36. (Silero's own volume gate can't do this: it averages over 400 ms,
# so a short word never gets loud enough on it, and the STT never receives a commit.)
LOUDNESS_DB_BY_FILTER = {"standard": -36.0, "strong": -33.0}
LOUD_MS_NEEDED = 100  # within the last LOUD_WINDOW_SECS
LOUD_WINDOW_SECS = 1.5

# A transcript arrives a little after the speech it came from; it still counts as the
# caller's if they spoke this recently.
TRANSCRIPT_GRACE_SECS = 2.5


def frame_dbfs(pcm: bytes) -> float:
    a = np.frombuffer(pcm, dtype=np.int16).astype(np.float32)
    if not len(a):
        return -120.0
    return float(20 * np.log10(np.sqrt(np.mean(a * a)) / 32768 + 1e-9))


class CallerSpeechTurnStartStrategy(BaseUserTurnStartStrategy):
    """Starts the caller's turn only for words the caller actually said.

    Pipecat's MinWordsUserTurnStartStrategy starts a turn on any transcribed word (or
    `min_words` while the agent talks), including words from a TV or people nearby that the
    speech-to-text picks up. This one also measures the caller's audio and counts a
    transcript only if speech at caller loudness (`min_dbfs`) was heard just before it.
    Anything else is dropped from the aggregation, so it never reaches the LLM.
    `min_dbfs=None` turns the filter off.
    """

    def __init__(self, *, min_words: int, min_dbfs: float | None = None, on_ignored=None, **kwargs):
        super().__init__(**kwargs)
        self._min_words = min_words
        self._min_dbfs = min_dbfs
        self._on_ignored = on_ignored
        self._bot_speaking = False
        self._in_turn = False
        self._loud: deque[tuple[float, float]] = deque()  # (time, seconds) of loud frames
        self._caller_heard_at = -1e9
        self._levels: deque[tuple[float, float]] = deque()  # (time, dBFS) of speech frames
        # Loudness of the caller's most recent turn (median of their speech frames), for the
        # call log: shows whether real callers sit well above the filter's threshold.
        self.last_turn_dbfs: float | None = None
        self.last_ignored_dbfs: float | None = None  # loudest recent frame when a transcript was ignored

    async def handle_user_turn_started(self):
        self._bot_speaking = False
        self._in_turn = True

    async def handle_user_turn_stopped(self):
        self._in_turn = False

    async def process_frame(self, frame: Frame):
        if isinstance(frame, InputAudioRawFrame):
            self._measure(frame)
        elif isinstance(frame, BotStartedSpeakingFrame):
            self._bot_speaking = True
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._bot_speaking = False
        elif isinstance(frame, (TranscriptionFrame, InterimTranscriptionFrame)):
            await self._handle_transcription(frame)

    def _measure(self, frame: InputAudioRawFrame) -> None:
        if self._min_dbfs is None:
            return
        now = time.monotonic()
        db = frame_dbfs(frame.audio)
        if db > -60:
            self._levels.append((now, db))
        while self._levels and now - self._levels[0][0] > 4:
            self._levels.popleft()
        if db >= self._min_dbfs:
            self._loud.append((now, len(frame.audio) / 2 / (frame.sample_rate or 8000)))
        while self._loud and now - self._loud[0][0] > LOUD_WINDOW_SECS:
            self._loud.popleft()
        if sum(d for _, d in self._loud) * 1000 >= LOUD_MS_NEEDED:
            self._caller_heard_at = now

    def caller_spoke_recently(self) -> bool:
        return time.monotonic() - self._caller_heard_at < TRANSCRIPT_GRACE_SECS

    async def _handle_transcription(self, frame: TranscriptionFrame | InterimTranscriptionFrame):
        if self._in_turn:
            return  # the caller's turn is under way; their words all count
        if self._min_dbfs is not None and not self.caller_spoke_recently():
            if isinstance(frame, TranscriptionFrame) and frame.text.strip():
                self.last_ignored_dbfs = round(max((d for _, d in self._levels), default=-120.0), 1)
                logger.debug(f"Ignoring background speech ({self.last_ignored_dbfs} dBFS): {frame.text!r}")
                if self._on_ignored:
                    self._on_ignored(frame.text)
            await self.trigger_reset_aggregation()
            return
        min_words = self._min_words if self._bot_speaking else 1
        if count_spoken_words(frame.text) >= min_words:
            loud = sorted(d for _, d in self._levels if d >= (self._min_dbfs or -60) - 6)
            self.last_turn_dbfs = round(loud[len(loud) // 2], 1) if loud else None
            await self.report_user_turn_started()
        else:
            await self.trigger_reset_aggregation()
