"""Reused speech models must behave exactly like freshly loaded ones (numen/bot.py pools)."""

import asyncio

import numpy as np
from pipecat.audio.vad.silero import SileroVADAnalyzer

from numen import bot

SR = 8000


def speechy(seconds=2.0, seed=1):
    rng = np.random.default_rng(seed)
    t = np.arange(int(SR * seconds)) / SR
    # Voiced-like signal: harmonics with a syllable-rate envelope, plus a little noise.
    sig = sum(np.sin(2 * np.pi * f * t) / (i + 1) for i, f in enumerate((140, 280, 420, 560, 700)))
    env = (np.sin(2 * np.pi * 4 * t) > 0).astype(float)
    pcm = (sig * env * 6000 + rng.normal(0, 200, len(t))).clip(-32768, 32767).astype(np.int16)
    return pcm.tobytes()


def confidences(vad, audio):
    vad.set_sample_rate(SR)
    n = vad.num_frames_required() * 2
    return [float(np.max(vad.voice_confidence(audio[i:i + n]))) for i in range(0, len(audio) - n, n)]


def test_pooled_vad_matches_a_fresh_one_after_reuse():
    audio = speechy()
    fresh = confidences(SileroVADAnalyzer(), audio)

    async def go():
        pool = bot._ModelPool(bot._load_silero_model, lambda m: m.reset_states(), 1)
        await pool.ready()
        m = await pool.take()
        confidences(bot._PooledSileroVAD(m), speechy(3.0, seed=9))  # a previous call
        pool.give(m)
        m2 = await pool.take()
        assert m2 is m and pool.size == 0  # the same loaded model, lent again
        return confidences(bot._PooledSileroVAD(m2), audio)

    reused = asyncio.run(go())
    assert np.allclose(fresh, reused, atol=1e-5)


def test_pool_builds_more_when_empty_and_keeps_returned():
    async def go():
        built = []
        pool = bot._ModelPool(lambda: built.append(1) or object(), lambda m: None, 2)
        await pool.ready()
        a, b, c = await pool.take(), await pool.take(), await pool.take()
        assert len(built) == 3
        for x in (a, b, c):
            pool.give(x)
        assert pool.size == 3
    asyncio.run(go())
