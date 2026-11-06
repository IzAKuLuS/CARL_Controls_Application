"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const Diagnostics = require("../src/joystick-diagnostics.js");
const Client = require("../src/joystick-client.js");

function recorder(options = {}) {
    return new Diagnostics({indexedDB: null, setIntervalFn: () => 1, clearIntervalFn() {}, ...options});
}

test("offline upload retains ordered browser evidence and later drains without discarding export", async () => {
    let fail = true;
    const batches = [];
    const d = recorder({fetchFn: async (url, options) => {
        if (fail) throw new Error("network unreachable");
        if (url.endsWith("/health")) return {ok: true, status: 200, json: async () => ({ready: true})};
        const batch = JSON.parse(options.body); batches.push(batch);
        return {ok: true, json: async () => ({accepted: batch.length})};
    }});
    d.setEndpoint("ws://car:8001/ws");
    d.record("offline"); d.record("reconnect", {reason: "reply timeout"});
    await d.flush();
    assert.ok(d.outbox.length >= 2);
    assert.match(d.uploadError, /unreachable/);
    fail = false;
    await d.flush();
    assert.equal(d.outbox.length, 0);
    assert.equal(batches[0][0].event, "offline");
    assert.match(await d.exportText(), /reply timeout/);
    assert.ok(d.storageError);
});

test("bounded browser storage reports lost events and respects server batch limits", async () => {
    const d = recorder({maxRecords: 150, fetchFn: async (url, options) => {
        if (url.endsWith("/health")) throw new Error("unreachable");
        const batch = JSON.parse(options.body);
        assert.ok(batch.length <= 100);
        assert.ok(Buffer.byteLength(options.body) <= 60000);
        return {ok: false, status: 503};
    }});
    d.setEndpoint("wss://car:8001/ws");
    for (let i = 0; i < 200; i++) d.record("sample", {detail: "x".repeat(1000)});
    assert.equal(d.records.length, 150);
    assert.equal(d.dropped, 50);
    await d.flush();
    assert.equal(d.outbox.length, 150);
    assert.match(d.uploadError, /503/);
    assert.equal(d.endpoint, "https://car:8001/diagnostics");
});

test("negotiated correlation metadata stays outside lease tokens and records close evidence", () => {
    const events = [], sent = [];
    let socket;
    class Socket {
        constructor() { socket = this; }
        send(value) { sent.push(JSON.parse(value)); }
        close() {}
    }
    const c = new Client({WebSocketClass: Socket, now: () => 50, setIntervalFn: () => 1,
        clearIntervalFn() {}, onDiagnostic: (event, data) => events.push({event, data})});
    c.connect("ws://car:8001/ws"); socket.onopen();
    socket.onmessage({data: JSON.stringify({protocol: 2, token: "0123456789abcdef", ready: true,
        neutral_required: false, diagnostics: 1, run_id: "run", session_id: "session", packet_seq: 1})});
    c.begin(); c.move(0, 1); c.tick();
    assert.equal(sent.at(-1).client_seq, 1);
    assert.equal(sent.at(-1).client_mono_ms, 50);
    assert.equal(sent.at(-1).deadman, true);
    socket.onclose({code: 1006, wasClean: false, reason: ""});
    assert.equal(c.held, false);
    assert.equal(events.find(item => item.event === "socket_close").data.code, 1006);
    assert.ok(!JSON.stringify(events).includes("0123456789abcdef"));
});

test("a failed diagnostic sink cannot prevent neutral, drive, or disconnect", () => {
    const sent = [];
    let socket;
    class Socket { constructor() { socket = this; } send(value) { sent.push(JSON.parse(value)); } close() {} }
    const c = new Client({WebSocketClass: Socket, now: () => 0, setIntervalFn: () => 1,
        clearIntervalFn() {}, onDiagnostic() { throw new Error("storage full"); }});
    c.connect("ws://car:8001/ws"); socket.onopen();
    assert.equal(sent[0].deadman, false);
    socket.onmessage({data: JSON.stringify({protocol: 2, token: "0123456789abcdef", ready: true, neutral_required: false})});
    assert.equal(c.begin(), true);
    c.move(0, 1); c.tick();
    assert.equal(sent.at(-1).deadman, true);
    c.disconnect();
    assert.equal(c.held, false);
});

// Minimal asynchronous IndexedDB surface for exercising reload/pruning and quota handling.
function memoryIDB() {
    const values = new Map();
    const request = (action) => {
        const result = {};
        queueMicrotask(() => { result.result = action(); result.onsuccess?.(); });
        return result;
    };
    const db = {close() {}, transaction() {
        const tx = {objectStore() { return {
            put(item) { values.set(item.id, structuredClone(item)); },
            count() { return request(() => values.size); },
            index() { return {
                getAll() { return request(() => [...values.values()].sort((a,b) => a.wall_ms - b.wall_ms)); },
                openCursor() {
                    const entries = [...values.values()].sort((a,b) => a.wall_ms - b.wall_ms);
                    let position = 0;
                    const cursor = {};
                    const next = () => queueMicrotask(() => {
                        const item = entries[position++];
                        cursor.result = item ? {delete() { values.delete(item.id); }, continue: next} : null;
                        cursor.onsuccess?.();
                    });
                    next(); return cursor;
                }
            }; }
        }; }};
        setImmediate(() => tx.oncomplete?.());
        return tx;
    }};
    return {open() { return request(() => db); }, values};
}

test("persisted offline events survive reload, replay and bounded pruning", async () => {
    const indexedDB = memoryIDB();
    const d = recorder({indexedDB, maxRecords: 3, wall: () => 10});
    await d.ready;
    for (let i = 0; i < 5; i++) d.record("offline", {i});
    await d.flush();
    assert.equal(indexedDB.values.size, 3);
    assert.equal(d.pending.length, 0);
    const reloaded = recorder({indexedDB, maxRecords: 3});
    await reloaded.ready;
    assert.equal(reloaded.outbox.length, 3);
    const exported = (await reloaded.exportText()).trim().split("\n").map(JSON.parse);
    assert.deepEqual(exported.map(item => item.data.i), [2, 3, 4]);
});

test("quota failure retains pending evidence and reports storage error", async () => {
    const d = recorder();
    await d.ready;
    d.db = {transaction() { throw new Error("QuotaExceededError"); }};
    d.record("offline");
    await d.flush();
    assert.equal(d.pending.length, 1);
    assert.match(d.storageError, /QuotaExceeded/);
    assert.match(await d.exportText(), /offline/);
});
