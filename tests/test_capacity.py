"""Admission control: slots, FIFO queue, expiry, per-caller cap, drain. Run: uv run python -m pytest tests"""

from numen.capacity import CallLimiter, Limits


class Clock:
    t = 0.0

    def __call__(self):
        return self.t


def make(**kw):
    c = Clock()
    base = dict(max_calls=2, max_queue=2, max_wait_s=60, per_caller=0, max_call_s=0)
    return CallLimiter(Limits(**{**base, **kw}), clock=c), c


def test_admits_up_to_max_then_queues_then_rejects():
    l, _ = make()
    assert l.admit("a").status == "admitted"
    assert l.admit("b").status == "admitted"
    q1, q2 = l.admit("c"), l.admit("d")
    assert (q1.status, q1.position, q2.position) == ("queued", 1, 2)
    d = l.admit("e")
    assert (d.status, d.reason) == ("rejected", "full")


def test_release_promotes_head_of_queue_in_order():
    l, _ = make()
    for s in "ab":
        l.admit(s)
        l.connect(s)
    q1, q2 = l.admit("c"), l.admit("d")
    assert l.poll(q1.ticket).status == "queued"
    l.release("a")
    assert l.poll(q2.ticket).status == "queued" and l.poll(q2.ticket).position == 1  # c holds the slot
    got = l.poll(q1.ticket)
    assert got.status == "admitted" and got.call_sid == "c"
    assert l.connect("c") and l.live == 2


def test_newcomer_cannot_jump_the_queue():
    l, _ = make()
    for s in "ab":
        l.admit(s)
        l.connect(s)
    q = l.admit("c")
    l.release("a")  # slot now reserved for c
    assert l.admit("z").status == "queued"
    assert l.poll(q.ticket).status == "admitted"


def test_unclaimed_reservation_expires():
    l, clk = make(max_calls=1)
    assert l.admit("a").status == "admitted"  # never connects
    b = l.admit("b")
    clk.t += 20
    assert l.poll(b.ticket).status == "queued"  # b keeps polling
    clk.t += 11  # a's reservation (30 s) expires; its slot goes to b
    assert l.connect("a") is False  # a is late and the only slot is b's
    assert l.poll(b.ticket).status == "admitted"


def test_abandoned_waiters_are_dropped_and_wait_times_out():
    l, clk = make(max_calls=1)
    l.admit("a"), l.connect("a")
    gone, stays = l.admit("b"), l.admit("c")
    clk.t += 20
    assert l.poll(stays.ticket).status == "queued"  # polls, b doesn't
    clk.t += 10
    assert l.poll(stays.ticket).position == 1  # b abandoned
    assert l.poll(gone.ticket).reason == "expired"
    while True:  # keeps polling every 8 s until max_wait_s
        clk.t += 8
        d = l.poll(stays.ticket)
        if d.status != "queued":
            break
    assert (d.status, d.reason) == ("rejected", "timeout")


def test_per_caller_limit_counts_running_and_waiting():
    l, _ = make(max_calls=5, per_caller=2)
    assert l.admit("a", "+1555").status == "admitted"
    assert l.admit("b", "+1555").status == "admitted"
    assert l.admit("c", "+1555").reason == "caller_limit"
    assert l.admit("d", "+1666").status == "admitted"


def test_connect_without_reservation_respects_capacity():
    l, _ = make(max_calls=1)
    assert l.connect("x") is True
    assert l.connect("y") is False
    l.release("x")
    assert l.connect("y") is True


def test_drain_blocks_new_calls_but_not_live_ones():
    l, _ = make()
    l.admit("a"), l.connect("a")
    q = l.admit("b"), l.admit("c")
    l.set_draining(True)
    assert l.admit("d").reason == "draining"
    assert l.poll(q[1].ticket).reason == "draining" or l.poll(q[1].ticket).status == "admitted"
    assert l.live == 1


def test_webhook_retry_is_idempotent():
    l, _ = make(max_calls=1)
    assert l.admit("a").status == "admitted"
    assert l.admit("a").status == "admitted"
    assert l.active == 1
