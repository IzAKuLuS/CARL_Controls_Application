"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Shared DOM/event harness. Tests exercise the production input, UI and client
// together; live integration selects real WebSockets and real timers.
function setup({live = false, endpoint = "ws://localhost:8001/ws"} = {}) {
    function target() {
        const handlers = new Map();
        return {textContent: "", disabled: false, value: "", style: {}, handlers,
            addEventListener(name, fn, options) {
                if (!handlers.has(name)) handlers.set(name, []);
                handlers.get(name).push({fn, options});
            },
            fire(name, event = {}) {
                event.type = name;
                event.cancelable ??= true;
                event.preventDefault ??= () => { event.defaultPrevented = true; };
                for (const {fn} of handlers.get(name) || []) fn(event);
                return event;
            }};
    }
    const elements = new Map(), sockets = [], timers = new Map();
    const window = target(), document = target();
    let protectedPage = false, client, now = 0, selection = null;
    document.hidden = false;
    document.documentElement = {classList: {contains: () => protectedPage}};
    document.getSelection = () => selection;
    document.getElementById = (id) => {
        if (!elements.has(id)) elements.set(id, target());
        return elements.get(id);
    };
    const element = (id) => document.getElementById(id);
    const zone = element("joystick-zone"), captured = new Set();
    let box = {left: 0, top: 0, width: 360, height: 360};
    zone.getBoundingClientRect = () => box;
    zone.setPointerCapture = (id) => {
        if (zone.failCapture) throw new Error("Simulated lost contact");
        captured.add(id);
    };
    zone.hasPointerCapture = (id) => captured.has(id);
    zone.releasePointerCapture = (id) => captured.delete(id);
    class Socket {
        constructor() { this.sent = []; sockets.push(this); }
        send(value) { this.sent.push(JSON.parse(value)); }
        close() { this.closed = true; this.onclose?.({code: 1000}); }
        reply(data = {}) {
            this.onmessage({data: JSON.stringify({protocol: 2, token: "0123456789abcdef",
                ready: true, neutral_required: false, active: Boolean(client.held), ...data})});
        }
    }
    const context = vm.createContext({window, document, PointerEvent: function() {},
        location: {protocol: "http:", hostname: "localhost"},
        localStorage: {getItem: () => endpoint, setItem() {}},
        URL,
        WebSocket: globalThis.WebSocket, performance, setInterval, clearInterval});
    const src = path.resolve(__dirname, "../../src");
    const run = (name) => vm.runInContext(fs.readFileSync(path.join(src, name), "utf8"), context);
    run("joystick-client.js"); run("joystick-input.js");
    const OriginalClient = context.CarlJoystickClient;
    context.CarlJoystickClient = class extends OriginalClient {
        constructor(options) {
            super({...options, ...(!live ? {WebSocketClass: Socket, now: () => now,
                setIntervalFn(fn) { timers.set(1, fn); return 1; },
                clearIntervalFn(id) { timers.delete(id); }} : {})});
            client = this;
        }
    };
    run("joystick-ui.js");
    function connect() {
        element("joystick-connection-form").fire("submit");
        if (!live) { sockets.at(-1).onopen(); sockets.at(-1).reply({active: false}); }
    }
    function pointer(type, fields = {}) {
        const event = {pointerId: 1, pointerType: "touch", isPrimary: true,
            button: 0, buttons: type === "pointerup" ? 0 : 1,
            clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 - 75,
            ...fields};
        document.fire(type, event);
        zone.fire(type, event);
        return event;
    }
    return {client, window, document, context, zone, captured, element, connect, pointer, sockets, timers,
        get socket() { return sockets.at(-1); },
        advance(ms = 50) { now += ms; client.tick(); },
        move(x, y, fields = {}) { return pointer("pointermove", {
            clientX: box.left + box.width / 2 + x * 75,
            clientY: box.top + box.height / 2 - y * 75, ...fields}); },
        visibility(hidden) { document.hidden = hidden; document.fire("visibilitychange"); },
        select(value) { selection = value; document.fire("selectionchange"); },
        setBox(value) { box = value; }, protect() { protectedPage = true; }};
}
module.exports = {setup};
