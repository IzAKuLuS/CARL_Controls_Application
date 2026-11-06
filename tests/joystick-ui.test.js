"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {setup} = require("./helpers/joystick-dom.js");
const fs = require("node:fs");
const path = require("node:path");

test("joystick page keeps controls without loading or displaying ROS telemetry", () => {
    const html = fs.readFileSync(path.join(__dirname, "../src/joystick.html"), "utf8");
    assert.doesNotMatch(html, /(?:ros-client|app)\.js|id="(?:telemetry-sections|ros-connection-form|rosbridge-url|carl-connection-status)"/);
    for (const id of ["joystick-zone", "joystick-connection-form", "joystick-status", "joystick-estop", "joystick-reset-estop"]) {
        assert.ok(html.includes(`id="${id}"`));
    }
});

function driving(s) {
    s.pointer("pointerdown"); s.advance(); s.socket.reply({left: 0.75, right: 0.75});
    assert.equal(s.client.held, true);
}
function stopped(s) {
    assert.equal(s.client.held, false);
    assert.equal(s.client.x, 0); assert.equal(s.client.y, 0);
    assert.equal(s.element("joystick-knob").style.transform, "translate(0px, 0px)");
    assert.equal(s.element("joystick-x").textContent, "0.00");
    assert.equal(s.element("joystick-left").textContent, "0.0%");
    assert.equal(s.captured.size, 0);
    if (s.client.pending) s.socket.reply({active: false});
    s.advance();
    assert.equal(s.socket.sent.at(-1).deadman, false);
    assert.equal(s.socket.sent.at(-1).x, 0); assert.equal(s.socket.sent.at(-1).y, 0);
    s.socket.reply({active: false});
    // A delayed move from the old gesture never re-arms input.
    s.move(0, 1); assert.equal(s.client.held, false);
}

test("first touch and raw travel preserve every direction, diagonals and overtravel", () => {
    const s = setup(); s.connect();
    for (const [x, y] of [[0, 0.5], [0, -0.5], [-0.5, 0], [0.5, 0], [0, 0]]) {
        s.pointer("pointerdown", {clientX: 180 + x * 75, clientY: 180 - y * 75});
        assert.equal(s.client.x, x); assert.equal(s.client.y, y);
        for (const travel of [0, 0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 1]) {
            for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI, 5 * Math.PI / 4]) {
                const a = Math.cos(angle) * travel, b = Math.sin(angle) * travel;
                s.move(a, b);
                assert.ok(Math.abs(s.client.x - a) < 1e-12);
                assert.ok(Math.abs(s.client.y - b) < 1e-12);
            }
        }
        s.move(0, 2); assert.equal(s.client.y, 1);
        s.pointer("pointerup"); stopped(s);
    }
});

test("current visible center is used on first touch after layout changes", () => {
    const s = setup(); s.connect(); s.setBox({left: 0, top: 280, width: 360, height: 360});
    s.pointer("pointerdown", {clientX: 180, clientY: 422.5});
    assert.equal(s.client.x, 0); assert.equal(s.client.y, 0.5);
});

for (const type of ["contextmenu", "selectstart", "dragstart", "gesturestart"]) {
    test(`${type} is prevented, sends neutral and permits a fresh touch without refresh`, () => {
        const s = setup(); s.connect(); driving(s);
        const event = s.zone.fire(type);
        assert.equal(event.defaultPrevented, true); stopped(s);
        driving(s); // Same DOM, socket, and control instance recover.
    });
}

for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    test(`${type} on the owning pointer clears capture, commands and knob`, () => {
        const s = setup(); s.connect(); driving(s);
        s.document.fire(type, {pointerId: 1}); stopped(s); driving(s);
    });
}

for (const type of ["touchend", "touchcancel"]) {
    test(`${type} independently releases when the pointer release event is missing`, () => {
        const s = setup(); s.connect(); driving(s);
        s.document.fire(type, {touches: []}); stopped(s); driving(s);
    });
}

test("native selection interrupts a held input without preventing other page selection", () => {
    const s = setup(); s.connect(); driving(s);
    s.select({isCollapsed: false}); stopped(s); driving(s);
});

test("additional contacts cannot take over a hold; late events cannot revive it", () => {
    const s = setup(); s.connect(); driving(s);
    s.document.fire("pointerdown", {pointerId: 2, isPrimary: false}); stopped(s);
    s.pointer("pointerdown", {pointerId: 2, isPrimary: false});
    assert.equal(s.client.held, false);
    driving(s);
    s.document.fire("pointerup", {pointerId: 2}); assert.equal(s.client.held, true);
    s.document.fire("touchstart", {touches: [{}, {}]}); stopped(s);
    driving(s);
    // Different pointer types may each be primary (e.g. touch plus mouse/pen).
    s.pointer("pointerdown", {pointerId: 2, pointerType: "pen", isPrimary: true}); stopped(s);
});

test("lost capture is checked before every transmitted command even without a cancel event", () => {
    const s = setup(); s.connect(); driving(s); s.captured.clear(); s.advance();
    assert.equal(s.socket.sent.at(-1).deadman, false);
    s.socket.reply({active: false}); stopped(s); driving(s);
});

test("a pointermove with no button/contact releases instead of keeping the old value", () => {
    const s = setup(); s.connect(); driving(s); s.move(0, 1, {buttons: 0}); stopped(s);
});

test("capture failure, malformed coordinates and unready starts never drive", () => {
    const s = setup(); s.pointer("pointerdown"); assert.equal(s.client.held, false);
    s.connect();
    s.zone.failCapture = true; s.pointer("pointerdown"); stopped(s);
    s.zone.failCapture = false;
    s.pointer("pointerdown", {clientX: NaN}); assert.equal(s.client.held, false);
    s.pointer("pointerdown", {button: 2, buttons: 2}); assert.equal(s.client.held, false);
    driving(s); s.move(0, 1, {clientY: Infinity}); stopped(s);
});

for (const type of ["blur", "resize", "orientationchange", "scroll"]) {
    test(`${type} releases and recenters without losing a healthy connection`, () => {
        const s = setup(); s.connect(); driving(s); s.window.fire(type); stopped(s);
        assert.equal(s.client.connected, true); driving(s);
    });
}

test("tab hiding, disconnect, reconnect and sign-out discard old touch ownership", () => {
    const s = setup(); s.connect(); driving(s); s.visibility(true);
    assert.equal(s.client.held, false); assert.equal(s.captured.size, 0);
    s.visibility(false); s.socket.onopen(); s.socket.reply({active: false});
    s.move(0, 1); assert.equal(s.client.held, false); driving(s);
    for (const id of ["joystick-disconnect", "sign-out"]) {
        s.element(id).fire("click");
        assert.equal(s.client.held, false); assert.equal(s.captured.size, 0);
        const count = s.sockets.length; s.visibility(true); s.visibility(false);
        s.window.fire("pageshow", {persisted: true}); assert.equal(s.sockets.length, count);
        s.connect(); driving(s);
    }
});

test("server rejection and delayed replies clear DOM ownership before recovery", () => {
    for (const reply of [{ready: false, neutral_required: true}, {rejection: "expired_command"}]) {
        const s = setup(); s.connect(); driving(s); s.advance(); s.socket.reply(reply);
        stopped(s); driving(s);
    }
    const s = setup(); s.connect(); driving(s); s.advance(); s.advance(200);
    assert.equal(s.captured.size, 0); assert.equal(s.client.held, false);
    s.socket.reply(); s.socket.reply({active: false}); stopped(s); driving(s);
});

test("signed server percentages, configured cap and e-stop/reset behavior are retained", () => {
    const s = setup(); s.connect(); driving(s);
    s.advance(); s.socket.reply({left: 0.1682825, right: -0.4, max_throttle: 0.75});
    assert.equal(s.element("joystick-left").textContent, "16.8%");
    assert.equal(s.element("joystick-right").textContent, "-40.0%");
    assert.equal(s.element("joystick-limit").textContent, "75.0%");
    s.element("joystick-estop").fire("click"); assert.equal(s.socket.sent.at(-1).type, "estop");
    s.socket.reply({estop: true, ready: false, neutral_required: true});
    assert.equal(s.captured.size, 0); assert.equal(s.element("joystick-left").textContent, "0.0%");
    s.element("joystick-reset-estop").fire("click");
    assert.equal(s.socket.sent.at(-1).type, "reset_estop");
    s.socket.reply({active: false}); s.move(0, 1); assert.equal(s.client.held, false);
    s.advance(); s.socket.reply({active: false}); // Confirm neutral after reset acknowledgement.
    driving(s);
});
