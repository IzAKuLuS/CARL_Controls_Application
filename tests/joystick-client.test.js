"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Client = require("../src/joystick-client.js");

function setup() {
    let now = 0;
    const sockets = [], states = [], timers = new Map();
    class Socket {
        constructor() { this.sent = []; sockets.push(this); }
        send(value) { this.sent.push(JSON.parse(value)); }
        close() { this.closed = true; this.onclose?.(); }
        reply(data = {}) {
            this.onmessage({ data: JSON.stringify({protocol: 2, token: "0123456789abcdef",
                ready: true, neutral_required: false, ...data}) });
        }
    }
    const client = new Client({ WebSocketClass: Socket, now: () => now,
        setIntervalFn(fn) { timers.set(1, fn); return 1; },
        clearIntervalFn(id) { timers.delete(id); },
        onState: (...args) => states.push(args) });
    client.connect("ws://localhost:8001/ws");
    const socket = sockets[0];
    socket.onopen();
    return { client, socket, sockets, states, timers, elapse(ms) { now += ms; }, advance(ms) { now += ms; client.tick(); } };
}

test("connect sends neutral and movement requires a fresh touch after readiness", () => {
    const s = setup();
    assert.deepEqual(s.socket.sent, [{type: "control", x: 0, y: 0, deadman: false}]);
    assert.equal(s.client.begin(), false);
    s.socket.reply();
    assert.equal(s.client.begin(), true);
    s.client.move(0.5, 1);
    s.advance(50);
    assert.deepEqual(s.socket.sent.at(-1), {type: "control", x: 0.5, y: 1, deadman: true, token: "0123456789abcdef"});
});

test("late acknowledgement pauses movement but keeps the socket and returns to neutral", () => {
    const s = setup();
    s.socket.reply(); s.client.begin(); s.client.move(0, 1); s.advance(50);
    s.advance(200);
    assert.equal(s.socket.closed, undefined);
    assert.equal(s.client.connected, true);
    assert.equal(s.client.held, false);
    assert.equal(s.client.begin(), false);
    assert.equal(s.socket.sent.length, 2); // One packet remains in flight.
    s.socket.reply({active: true});
    assert.deepEqual(s.socket.sent.at(-1), {type: "control", x: 0, y: 0, deadman: false, token: "0123456789abcdef"});
    assert.equal(s.client.begin(), false);
    s.socket.reply();
    assert.equal(s.client.held, false);
    assert.equal(s.client.begin(), true);
});

test("release queues neutral behind in-flight input and sends immediately on acknowledgement", () => {
    const s = setup();
    s.socket.reply(); s.client.begin(); s.client.move(0, 1); s.advance(50);
    s.client.release();
    assert.equal(s.socket.sent.length, 2);
    s.socket.reply({active: true});
    assert.deepEqual(s.socket.sent.at(-1), {type: "control", x: 0, y: 0, deadman: false, token: "0123456789abcdef"});
});

test("missing telemetry and server neutral requirement release input without an ack loop", () => {
    const s = setup();
    s.socket.reply({ready: false, neutral_required: true});
    assert.equal(s.socket.sent.length, 1);
    assert.equal(s.client.begin(), false);
    s.advance(50); s.socket.reply(); s.client.begin(); s.client.move(0, 1);
    s.advance(50); s.socket.reply({ready: false, neutral_required: true});
    assert.equal(s.client.held, false);
    s.advance(50); s.socket.reply();
    s.client.move(0, 1); s.advance(50);
    assert.equal(s.socket.sent.at(-1).deadman, false);
});

test("estop/reset release input, queue with priority, and never auto-resume driving", () => {
    const s = setup();
    s.socket.reply(); s.client.begin(); s.client.move(0, 1); s.advance(50);
    s.client.command("estop");
    s.socket.reply();
    assert.deepEqual(s.socket.sent.at(-1), {type: "estop", token: "0123456789abcdef"});
    s.socket.reply({estop: true, ready: false, neutral_required: true});
    s.client.command("reset_estop");
    assert.deepEqual(s.socket.sent.at(-1), {type: "reset_estop", token: "0123456789abcdef"});
    s.socket.reply({neutral_required: true});
    s.client.move(0, 1); s.advance(50);
    assert.equal(s.socket.sent.at(-1).deadman, false);
});

test("rapid reset cannot replace a queued or unacknowledged e-stop", () => {
    const s = setup();
    s.socket.reply(); s.client.begin(); s.client.move(0, 1); s.advance(50);
    assert.equal(s.client.command("estop"), true);
    assert.equal(s.client.command("reset_estop"), false);
    s.socket.reply();
    assert.deepEqual(s.socket.sent.at(-1), {type: "estop", token: "0123456789abcdef"});
    assert.equal(s.client.command("reset_estop"), false);
    s.socket.reply({estop: true, ready: false, neutral_required: true});
    assert.equal(s.client.command("reset_estop"), true);
    assert.deepEqual(s.socket.sent.at(-1), {type: "reset_estop", token: "0123456789abcdef"});
});

test("disconnect and endpoint changes discard held inputs and ignore old socket events", () => {
    const s = setup();
    s.socket.reply(); s.client.begin(); s.client.move(0, 1);
    s.client.connect("ws://other:8001/ws");
    s.sockets[1].onopen();
    s.socket.reply(); s.socket.onclose();
    assert.ok(s.client.connected);
    assert.deepEqual(s.sockets[1].sent, [{type: "control", x: 0, y: 0, deadman: false}]);
    s.client.disconnect();
    assert.equal(s.timers.size, 0);
});

test("invalid replies close without reconnecting", () => {
    for (const reply of [{error: "Another controller is connected"}, null, []]) {
        const s = setup();
        s.socket.onmessage({data: JSON.stringify(reply)});
        assert.ok(s.socket.closed);
        assert.equal(s.timers.size, 0);
    }
});

test("occupied server during recovery retries at neutral until ownership clears", () => {
    const s = setup();
    s.socket.reply({error: "Another controller is connected", code: "controller_busy"});
    assert.ok(s.socket.closed);
    assert.equal(s.client.running, true);
    assert.equal(s.client.held, false);
    s.advance(500);
    const next = s.sockets.at(-1); next.onopen(); next.reply();
    assert.equal(s.client.begin(), true);
    assert.equal(next.sent[0].deadman, false);
    assert.equal(s.client.reconnectCount, 1);
});

test("repeated busy handshakes back off without claiming or driving another session", () => {
    const s = setup();
    for (const delay of [500, 1000, 2000, 4000, 5000, 5000]) {
        const socket = s.sockets.at(-1);
        socket.reply({error: "Another controller is connected", code: "controller_busy"});
        const count = s.sockets.length;
        s.advance(delay - 1);
        assert.equal(s.sockets.length, count);
        s.advance(1); s.sockets.at(-1).onopen();
        assert.equal(s.sockets.at(-1).sent[0].deadman, false);
        assert.equal(s.client.held, false);
    }
    s.sockets.at(-1).reply();
    assert.equal(s.client.attempt, 0);
});

test("link diagnostics count pauses once and measure actual round trips", () => {
    const s = setup(); s.advance(50); s.socket.reply();
    assert.equal(s.client.lastRttMs, 50);
    assert.equal(s.client.reconnectCount, 0);
    s.client.begin(); s.client.move(0, 1); s.advance(50);
    s.advance(200); s.advance(50);
    assert.equal(s.client.pauseCount, 1);
    assert.equal(s.client.reconnectCount, 0);
    s.socket.reply();
    assert.equal(s.client.lastRttMs, 250);
});

test("server freshness token is echoed once per reply and never reused across connections", () => {
    const s = setup();
    s.socket.reply({token: "aaaaaaaaaaaaaaaa"}); s.advance(50);
    assert.equal(s.socket.sent.at(-1).token, "aaaaaaaaaaaaaaaa");
    s.socket.reply({token: "bbbbbbbbbbbbbbbb"}); s.advance(50);
    assert.equal(s.socket.sent.at(-1).token, "bbbbbbbbbbbbbbbb");
    s.socket.close(); s.advance(500);
    s.sockets.at(-1).onopen();
    assert.equal(s.sockets.at(-1).sent[0].token, undefined);
});

test("old servers and expired input never permit held movement to resume", () => {
    const s = setup();
    s.socket.reply({protocol: 1});
    assert.equal(s.client.running, false);
    const t = setup(); t.socket.reply(); t.client.begin(); t.client.move(0, 1); t.advance(50);
    t.socket.reply({rejection: "expired_command", neutral_required: true});
    assert.equal(t.client.held, false);
    assert.equal(t.client.begin(), false);
    t.advance(50);
    assert.equal(t.socket.sent.at(-1).deadman, false);
});

test("idle and unchanged held input remain connected without move events", () => {
    const s = setup(); s.socket.reply();
    for (let i = 0; i < 1200; i++) { s.advance(50); s.socket.reply(); }
    assert.equal(s.client.connected, true);
    assert.equal(s.sockets.length, 1);
    s.client.begin(); s.client.move(0, 1);
    for (let i = 0; i < 100; i++) {
        s.advance(50);
        assert.equal(s.socket.sent.at(-1).deadman, true);
        assert.equal(s.socket.sent.at(-1).y, 1);
        s.socket.reply({active: true});
    }
    s.client.release(); s.socket.reply();
    for (let i = 0; i < 100; i++) { s.advance(50); s.socket.reply(); }
    assert.equal(s.client.connected, true);
    assert.equal(s.sockets.length, 1);
    assert.equal(s.client.begin(), true);
});

test("lost replies reconnect automatically at neutral and discard old socket events", () => {
    const s = setup(); s.socket.reply(); s.client.begin(); s.client.move(0, 1); s.advance(50);
    s.advance(3000);
    assert.ok(s.socket.closed);
    assert.equal(s.client.connected, false);
    assert.equal(s.client.held, false);
    s.advance(500);
    const next = s.sockets[1]; next.onopen();
    assert.deepEqual(next.sent, [{type: "control", x: 0, y: 0, deadman: false}]);
    s.socket.reply({active: true}); s.socket.onclose();
    assert.equal(s.client.pending, true);
    next.reply();
    assert.equal(s.client.held, false);
    assert.equal(s.client.begin(), true);
});

test("explicit disconnect cancels pending retries", () => {
    const s = setup(); s.socket.close();
    s.client.disconnect(); s.advance(10000);
    assert.equal(s.sockets.length, 1);
    assert.equal(s.timers.size, 0);
});

test("a late reply arriving before the timer still cancels old movement", () => {
    const s = setup(); s.socket.reply(); s.client.begin(); s.client.move(1, 1); s.advance(50);
    // The receive handler must also detect lateness when it runs before tick.
    s.elapse(200); s.socket.reply({active: true});
    assert.equal(s.client.held, false);
    assert.equal(s.socket.sent.at(-1).deadman, false);
});
