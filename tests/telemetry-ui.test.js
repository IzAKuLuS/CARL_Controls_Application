"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function setup() {
    class Element {
        constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.handlers = {}; this.textContent = ""; }
        append(...elements) { for (const el of elements) { el.parentElement = this; this.children.push(el); } }
        addEventListener(event, callback) { this.handlers[event] = callback; }
        fire(event, value = {}) { this.handlers[event]?.(value); }
    }
    const ids = new Map();
    const get = (id) => {
        if (!ids.has(id)) ids.set(id, new Element("div"));
        return ids.get(id);
    };
    let now = 0, render, client;
    const window = new Element("window");
    window.location = { hostname: "localhost", protocol: "http:" };
    window.setInterval = (callback) => { render = callback; return 1; };
    window.clearInterval = () => { render = null; };
    class Client {
        static endpoint(value) { return value; }
        constructor(options) { this.options = options; this.connections = []; client = this; }
        connect(endpoint) { this.connections.push(endpoint); this.options.onState("connected", "Connected"); }
        disconnect() { this.options.onState("disconnected", "Disconnected"); }
    }
    vm.runInNewContext(fs.readFileSync(require.resolve("../src/app.js"), "utf8"), {
        document: { getElementById: get, createElement: (tag) => new Element(tag),
            documentElement: { classList: { contains: () => false } } },
        window, CarlRosClient: Client, performance: { now: () => now },
        localStorage: { getItem: () => null, setItem() {} }
    });
    return { get, window, client, tick(ms) { now += ms; render(); },
        sections: get("telemetry-sections").children };
}

test("telemetry screen subscribes only to installed metrics and creates their sections", () => {
    const s = setup();
    assert.deepEqual(Array.from(s.client.options.topics, (t) => t.topic),
        ["/carl/encoders", "/carl/throttle_status", "/carl/heartbeat", "/carl/imu", "/carl/imu/temperature", "/carl/imu/diagnostics"]);
    assert.deepEqual(s.sections.map((el) => el.children[0].textContent),
        ["Encoders", "Throttle status", "Heartbeat", "IMU motion", "IMU temperature", "IMU health"]);
    assert.equal(s.client.connections.length, 1);
});

test("encoder, throttle and heartbeat values render, become stale and clear on disconnect", () => {
    const s = setup();
    const messages = [
        { rear_left_counts: 1234, rear_right_counts: -5678 },
        { state: 2, faults: 0, applied_left: 0.4, applied_right: -0.4 },
        { counter: 42, flags: 5, mode: 1 }
    ];
    for (let i = 0; i < messages.length; ++i) {
        messages[i].header = { stamp: { sec: 1, nanosec: 2 }, frame_id: "base_link" };
        s.client.options.onMessage(s.client.options.topics[i].topic, messages[i]);
    }
    s.tick(100);
    for (let i = 0; i < messages.length; ++i) {
        const section = s.sections[i];
        assert.equal(section.dataset.state, "live");
        const raw = section.children[4].children[1];
        assert.deepEqual(JSON.parse(raw.textContent), messages[i]);
    }
    const values = (section) => section.children[3].children.map((row) => row.children[1].textContent);
    assert.deepEqual(values(s.sections[0]).slice(0, 2), ["1234", "-5678"]);
    assert.deepEqual(values(s.sections[1]).slice(0, 4), ["Driving (2)", "0", "0.4", "-0.4"]);
    assert.deepEqual(values(s.sections[2]).slice(0, 3), ["42", "5", "Teleop (1)"]);
    assert.equal(s.get("carl-connection-status").textContent, "CARL heartbeat: live");
    s.tick(1001);
    assert.ok(s.sections.slice(0, 3).every((section) => section.dataset.state === "stale"));
    assert.equal(s.get("carl-connection-status").textContent, "CARL heartbeat: stale");
    s.get("ros-disconnect").fire("click");
    assert.ok(s.sections.every((section) => section.dataset.state === "waiting"));
    assert.ok(s.sections.every((section) => values(section).every((v) => v === "No data")));
    assert.ok(s.sections.every((section) => section.children[4].children[1].textContent === "No message received"));
});

test("subscription errors and reconnect preserve freshness reporting and page lifecycle", () => {
    const s = setup();
    s.client.options.onTopicError("/carl/encoders", "Unknown message type");
    s.tick(100);
    assert.match(s.sections[0].children[2].textContent, /Subscription error: Unknown message type/);
    s.get("ros-disconnect").fire("click");
    s.window.fire("pageshow", { persisted: true });
    assert.equal(s.client.connections.length, 1); // Explicit disconnect remains disconnected.
    s.get("ros-connection-form").fire("submit", { preventDefault() {} });
    assert.equal(s.client.connections.length, 2);
    assert.match(s.sections[0].children[2].textContent, /Waiting for messages/);
    s.window.fire("pagehide");
    assert.equal(s.get("ros-connection-status").textContent, "Disconnected");
});

test("75% forward/reverse applied throttle renders without the old 40% ceiling", () => {
    const s = setup();
    for (const sign of [-1, 1]) {
        s.client.options.onMessage("/carl/throttle_status", {
            state: 2, faults: 0, applied_left: sign * 0.75, applied_right: sign * 0.75
        });
        s.tick(100);
        const values = s.sections[1].children[3].children.map((row) => row.children[1].textContent);
        assert.deepEqual(values.slice(0, 4), ["Driving (2)", "0", String(sign * 0.75), String(sign * 0.75)]);
    }
});

const values = (section) => section.children[3].children.map((row) => row.children[1].textContent);
const imuMessage = () => ({linear_acceleration:{x:1.25,y:-2.5,z:9.80665}, angular_velocity:{x:.1,y:-.2,z:0},
    orientation_covariance:[-1,0,0,0,0,0,0,0,0], header:{stamp:{sec:1,nanosec:2},frame_id:"imu_link"}});
const imuDiagnostic = (extra={}) => ({data:JSON.stringify({schema:1,sensor:"MPU-9250",interface:"spi",
    ready:true,stage:"ready",error:"ok",error_count:5,...extra})});

test("IMU vectors, zero temperature and JSON health render in SI units with original payloads", () => {
    const s=setup(), m=imuMessage(), d=imuDiagnostic();
    s.client.options.onMessage("/carl/imu",m);
    s.client.options.onMessage("/carl/imu/temperature",{temperature:0});
    s.client.options.onMessage("/carl/imu/diagnostics",d); s.tick(100);
    assert.deepEqual(values(s.sections[3]).slice(0,6),["1.250 m/s²","-2.500 m/s²","9.807 m/s²","0.100 rad/s","-0.200 rad/s","0.000 rad/s"]);
    assert.equal(values(s.sections[4])[0],"0.000 °C");
    assert.deepEqual(values(s.sections[5]),["MPU-9250","spi","ready","Yes","ok","5"]);
    assert.deepEqual(JSON.parse(s.sections[5].children[4].children[1].textContent),d);
    assert.match(s.sections[3].children[5].textContent,/does not estimate orientation/);
    assert.match(s.sections[4].children[5].textContent,/not ambient/);
    s.tick(401); assert.equal(s.sections[3].dataset.state,"stale");
    assert.equal(s.sections[4].dataset.state,"live"); assert.equal(s.sections[5].dataset.state,"live");
    s.tick(600); assert.equal(s.sections[4].dataset.state,"stale"); assert.equal(s.sections[5].dataset.state,"live");
    s.tick(1500); assert.equal(s.sections[5].dataset.state,"stale");
    s.get("ros-disconnect").fire("click");
    for(const section of s.sections.slice(3)) assert.ok(values(section).every(v=>v==="No data"));
});

test("malformed sensor messages clear old values and recover without breaking other topics", () => {
    const s=setup(); s.client.options.onMessage("/carl/imu",imuMessage()); s.tick(100);
    s.client.options.onMessage("/carl/imu",{linear_acceleration:{x:null,y:0,z:0}}); s.tick(100);
    assert.match(s.sections[3].children[2].textContent,/Data error/);
    assert.ok(values(s.sections[3]).every(v=>v==="No data"));
    for(const data of ["bad json","null","[]","{}","x".repeat(4097)]) {
        s.client.options.onMessage("/carl/imu/diagnostics",{data}); s.tick(100);
        assert.match(s.sections[5].children[2].textContent,/Data error/);
    }
    s.client.options.onMessage("/carl/imu/temperature",{temperature:"35"}); s.tick(100);
    assert.match(s.sections[4].children[2].textContent,/Data error/);
    s.client.options.onMessage("/carl/imu",imuMessage());
    s.client.options.onMessage("/carl/imu/diagnostics",imuDiagnostic({ready:false,stage:"retry_wait",error:"data_timeout"}));
    s.tick(100); assert.equal(s.sections[3].dataset.state,"live"); assert.equal(s.sections[5].dataset.state,"fault");
    assert.equal(values(s.sections[5])[4],"data_timeout");
    s.client.options.onMessage("/carl/imu/diagnostics",imuDiagnostic({error_count:6}));
    s.tick(100); assert.equal(s.sections[5].dataset.state,"live"); assert.equal(values(s.sections[5])[5],"6");
});
