"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function setup() {
    function target() {
        const handlers = new Map();
        return { textContent: "", disabled: false, value: "", handlers,
            addEventListener(name, fn) { handlers.set(name, fn); },
            fire(name, ...args) { handlers.get(name)?.(...args); } };
    }
    const elements = new Map();
    const window = target(), document = target(), joystick = target();
    let protectedPage = false, client, joystickOptions;
    document.hidden = false;
    document.documentElement = {classList: {contains: () => protectedPage}};
    document.getElementById = (id) => {
        if (!elements.has(id)) elements.set(id, target());
        return elements.get(id);
    };
    joystick.on = joystick.addEventListener;
    class Client {
        constructor() { client = this; this.connections = []; this.disconnects = 0; this.x = this.y = 0; }
        connect(url) { this.connections.push(url); this.connected = true; this.held = false; }
        disconnect() { this.disconnects++; this.connected = this.held = false; }
        begin() { this.held = Boolean(this.connected); }
        release() { this.held = false; this.x = this.y = 0; }
        move(x, y) { if (this.held) { this.x = x; this.y = y; } }
        command() { this.release(); }
    }
    const context = vm.createContext({ window, document,
        location: {protocol: "http:", hostname: "localhost"},
        localStorage: {getItem: () => null, setItem() {}},
        nipplejs: {create: (options) => { joystickOptions = options; return joystick; }},
        CarlJoystickClient: Client,
        CarlRosClient: {endpoint: (value) => value} });
    vm.runInContext(fs.readFileSync(require.resolve("../src/joystick-ui.js"), "utf8"), context);
    const element = (id) => document.getElementById(id);
    function connect() { element("joystick-connection-form").fire("submit", {preventDefault() {}}); }
    function visibility(hidden) { document.hidden = hidden; document.fire("visibilitychange"); }
    return {client, window, document, joystick, joystickOptions, element, connect, visibility,
        protect() { protectedPage = true; }};
}

test("returning to a visible joystick page reconnects a requested session at rest", () => {
    const s = setup();
    s.visibility(true); s.visibility(false);
    assert.equal(s.client.connections.length, 0);
    s.connect(); s.joystick.fire("start");
    assert.equal(s.client.held, true);
    s.visibility(true);
    assert.equal(s.client.held, false);
    s.visibility(false);
    assert.equal(s.client.connections.length, 2);
    assert.equal(s.client.held, false);
});

test("first touch preserves direction and the existing response curve; release returns to zero", () => {
    const s = setup(); s.connect();
    // nipplejs emits move immediately after start, before the finger slides.
    for (const [x, y] of [[0, 0.5], [0, -0.5], [-0.5, 0], [0.5, 0], [0, 0]]) {
        s.joystick.fire("start");
        s.joystick.fire("move", {}, {distance: 37.5, vector: {x, y}});
        assert.equal(s.client.x, x * 0.5);
        assert.equal(s.client.y, y * 0.5);
        s.joystick.fire("end");
        assert.equal(s.client.x, 0);
        assert.equal(s.client.y, 0);
        assert.equal(s.client.held, false);
    }
});

test("a moved joystick zone uses its current center for the first touch", () => {
    const s = setup(); s.connect();
    const initialCenter = {x: 180, y: 300};
    const currentCenter = {x: 180, y: 460}; // Text above expanded after initialization.
    const finger = {x: 180, y: 422.5};      // First touch is forward of the visible center.
    // Model nipplejs 0.10.2's documented dynamicPage coordinate contract.
    const origin = s.joystickOptions.dynamicPage ? currentCenter : initialCenter;
    const dx = finger.x - origin.x, dy = origin.y - finger.y;
    const scale = Math.max(75, Math.hypot(dx, dy));
    s.joystick.fire("start");
    s.joystick.fire("move", {}, {
        distance: Math.min(75, Math.hypot(dx, dy)),
        vector: {x: dx / scale, y: dy / scale}
    });
    assert.equal(s.client.x, 0);
    assert.equal(s.client.y, 0.25);
});

test("explicit disconnect and sign-out prevent visibility and cached-page reconnects", () => {
    for (const id of ["joystick-disconnect", "sign-out"]) {
        const s = setup(); s.connect(); s.element(id).fire("click");
        s.visibility(true); s.visibility(false); s.window.fire("pageshow", {persisted: true});
        assert.equal(s.client.connections.length, 1);
        assert.equal(s.client.connected, false);
    }
    const s = setup(); s.connect(); s.visibility(true); s.protect(); s.visibility(false);
    assert.equal(s.client.connections.length, 1);
});

test("focus loss and cancelled touch release motion while retaining the session", () => {
    const s = setup(); s.connect();
    for (const event of ["blur", "pointercancel", "touchcancel"]) {
        s.joystick.fire("start");
        s.joystick.fire("move", {}, {distance: 75, vector: {x: 0, y: 1}});
        s.window.fire(event);
        assert.equal(s.client.held, false);
        assert.equal(s.client.connected, true);
        assert.equal(s.element("joystick-x").textContent, "0.00");
    }
});

test("malformed joystick events release rather than leave the previous command held", () => {
    const s = setup(); s.connect();
    for (const data of [null, {}, {distance: 75}, {distance: NaN, vector: {x: 0, y: 1}},
        {distance: 75, vector: {x: Infinity, y: 1}}, {distance: -1, vector: {x: 0, y: 1}}]) {
        s.joystick.fire("start");
        s.joystick.fire("move", {}, {distance: 75, vector: {x: 0, y: 1}});
        assert.equal(s.client.held, true);
        s.joystick.fire("move", {}, data);
        assert.equal(s.client.held, false);
        assert.equal(s.client.x, 0);
        assert.equal(s.client.y, 0);
    }
});
