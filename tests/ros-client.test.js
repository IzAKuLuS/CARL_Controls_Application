"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const CarlRosClient = require("../src/ros-client.js");

test("default browser timers retain the global receiver", () => {
    const vm = require("node:vm");
    const fs = require("node:fs");
    const context = vm.createContext({ URL });
    vm.runInContext(`
        function setTimeout(callback, delay) {
            if (this !== globalThis) throw new TypeError('Illegal invocation');
            return 1;
        }
        function clearTimeout(id) {
            if (this !== globalThis) throw new TypeError('Illegal invocation');
        }
        class WebSocket {
            close() {}
        }
        globalThis.WebSocket = WebSocket;
    `, context);
    vm.runInContext(fs.readFileSync(require.resolve("../src/ros-client.js"), "utf8"), context);
    vm.runInContext(`
        const client = new CarlRosClient({ topics: [] });
        client.connect('ws://localhost:9090');
        client.disconnect();
    `, context);
});

function setup() {
    const sockets = [], timers = new Map(), states = [], messages = [], errors = [];
    let timerId = 0;
    class Socket {
        constructor(url) { this.url = url; this.sent = []; sockets.push(this); }
        send(value) { this.sent.push(JSON.parse(value)); }
        close() { this.closed = true; this.onclose?.(); }
        receive(value) { this.onmessage({ data: JSON.stringify(value) }); }
    }
    const client = new CarlRosClient({
        topics: [
            { topic: "/carl/heartbeat", type: "carl_msgs/msg/CarlHeartbeat" },
            { topic: "/carl/imu", type: "sensor_msgs/msg/Imu" }
        ],
        WebSocketClass: Socket,
        setTimer(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
        clearTimer(id) { timers.delete(id); },
        onState: (...args) => states.push(args),
        onMessage: (...args) => messages.push(args),
        onTopicError: (...args) => errors.push(args)
    });
    function runTimer(delay) {
        const entry = [...timers].find(([, timer]) => timer.delay === delay);
        assert.ok(entry, `Expected timer ${delay}`);
        timers.delete(entry[0]);
        entry[1].callback();
    }
    return { client, sockets, timers, states, messages, errors, runTimer };
}

test("subscribes once per topic and preserves complete payloads without publishing", () => {
    const s = setup();
    s.client.connect("ws://localhost:9090");
    s.sockets[0].onopen();
    assert.equal(s.sockets[0].sent.length, 2);
    assert.ok(s.sockets[0].sent.every((request) => request.op === "subscribe"
        && request.throttle_rate === 100 && request.queue_length === 1));
    const message = { counter: 1, header: { stamp: { sec: 1, nanosec: 2 } }, extra: [1, 2, 3] };
    s.sockets[0].receive({ op: "publish", topic: "/carl/heartbeat", msg: message });
    assert.deepEqual(s.messages, [["/carl/heartbeat", message]]);
    s.sockets[0].onmessage({ data: "broken JSON" });
    s.sockets[0].receive(null);
    s.sockets[0].receive({ op: "publish", topic: "/unrelated", msg: message });
    assert.equal(s.messages.length, 1);
});

test("reconnect restores subscriptions and ignores obsolete sockets", () => {
    const s = setup();
    s.client.connect("ws://localhost:9090");
    const old = s.sockets[0];
    old.onopen();
    old.close();
    s.runTimer(1000);
    const next = s.sockets[1];
    next.onopen();
    assert.equal(next.sent.length, 2);
    old.receive({ op: "publish", topic: "/carl/heartbeat", msg: { counter: 99 } });
    old.onclose();
    assert.equal(s.messages.length, 0);
    assert.equal(s.timers.size, 0);
});

test("explicit disconnect cancels reconnect and handshake timers", () => {
    const s = setup();
    s.client.connect("ws://localhost:9090");
    s.client.disconnect();
    assert.equal(s.timers.size, 0);
    s.sockets[0].onclose();
    assert.equal(s.timers.size, 0);
    assert.equal(s.states.at(-1)[0], "disconnected");
});

test("handshake timeout and unavailable server retry with bounded backoff", () => {
    const s = setup();
    s.client.connect("ws://localhost:9090");
    s.runTimer(8000);
    assert.ok(s.sockets[0].closed);
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
        s.runTimer(delay);
        s.sockets.at(-1).close();
    }
    assert.equal([...s.timers.values()][0].delay, 30000);
    s.client.disconnect();
    assert.equal(s.timers.size, 0);
});

test("switching endpoints closes the previous socket without retrying it", () => {
    const s = setup();
    s.client.connect("ws://localhost:9090");
    s.client.connect("ws://192.168.1.10:9090");
    assert.ok(s.sockets[0].closed);
    assert.equal(s.sockets[1].url, "ws://192.168.1.10:9090/");
    s.sockets[1].onopen();
    assert.equal(s.timers.size, 0);
});

test("subscription errors identify affected topic", () => {
    const s = setup();
    s.client.connect("ws://localhost:9090");
    s.sockets[0].onopen();
    s.sockets[0].receive({ op: "status", level: "error", id: "telemetry:/carl/imu", msg: "Unknown message type" });
    assert.deepEqual(s.errors, [["/carl/imu", "Unknown message type"]]);
});

test("rejects invalid endpoints and mixed secure/insecure connections", () => {
    for (const value of ["http://localhost:9090", "bad address", "ws://user:pass@localhost:9090", "ws://localhost/#fragment"]) {
        assert.throws(() => CarlRosClient.endpoint(value));
    }
    assert.throws(() => CarlRosClient.endpoint("ws://localhost:9090", "https:"));
    assert.equal(CarlRosClient.endpoint("wss://example.test/rosbridge", "https:"), "wss://example.test/rosbridge");
});
