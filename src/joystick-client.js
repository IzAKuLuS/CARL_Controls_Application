"use strict";

// CARL's 20 Hz input stream. Motion freshness and connection liveness have
// separate deadlines. Every reconnect begins neutral and requires a new touch.
(() => {
    class CarlJoystickClient {
        constructor({ onState = () => {}, WebSocketClass = globalThis.WebSocket,
            now = () => performance.now(),
            setIntervalFn = (fn, ms) => globalThis.setInterval(fn, ms),
            clearIntervalFn = (id) => globalThis.clearInterval(id) } = {}) {
            Object.assign(this, { onState, WebSocketClass, now, setIntervalFn, clearIntervalFn });
            this.socket = null;
            this.timer = null;
            this.running = false;
            this.pauseCount = this.reconnectCount = 0;
            this.lastRttMs = null;
            this.release();
        }

        connect(endpoint) {
            const url = new URL(endpoint);
            if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.hash) {
                throw new Error("Enter a ws:// or wss:// joystick address without credentials or a fragment.");
            }
            this.disconnect();
            this.url = url.href;
            this.running = true;
            this.attempt = 0;
            this.retryAt = null;
            this.timer = this.setIntervalFn(() => this.tick(), 50);
            this.open();
        }

        open() {
            if (!this.running) return;
            this.connected = false;
            this.pending = false;
            this.paused = false;
            this.lastState = null;
            this.lastPacket = null;
            this.queued = null;
            this.token = null;
            this.release();
            this.sentAt = this.now();
            this.retryAt = null;
            this.onState("Connecting to joystick server…");
            let socket;
            try { socket = new this.WebSocketClass(this.url); }
            catch { this.reconnect("Joystick connection failed."); return; }
            this.socket = socket;
            socket.onopen = () => {
                if (this.socket !== socket) return;
                this.connected = true;
                this.flush();
            };
            socket.onmessage = (event) => {
                if (this.socket !== socket) return;
                let data;
                try { data = JSON.parse(event.data); } catch { this.fail("Invalid joystick reply."); return; }
                // A half-open session from this phone may still own the server
                // during recovery. Do not permanently abandon automatic retry.
                if (data?.code === "controller_busy") {
                    this.reconnect("Joystick server is still releasing a controller session.");
                    return;
                }
                if (!data || data.error || typeof data.ready !== "boolean"
                    || typeof data.neutral_required !== "boolean") {
                    this.fail(data?.error || "Invalid joystick reply.");
                    return;
                }
                if (data.protocol !== 2 || typeof data.token !== "string"
                    || !/^[0-9a-f]{16}$/.test(data.token)) {
                    this.fail("Joystick server update required. Update server and reload this page.");
                    return;
                }
                this.token = data.token;
                this.attempt = 0;
                if (this.pending) this.lastRttMs = Math.round(this.now() - this.sentAt);
                if (this.pending && this.now() - this.sentAt >= 200) this.pauseMotion();
                const neutralAck = this.lastPacket?.type === "control"
                    && !this.lastPacket.deadman && this.lastPacket.x === 0 && this.lastPacket.y === 0;
                this.pending = false;
                if (neutralAck) this.paused = false;
                this.lastState = data;
                if (!data.ready || data.neutral_required || data.rejection) {
                    this.held = false;
                    this.x = this.y = 0;
                }
                if (this.paused) {
                    this.lastState = { ...data, ready: false, active: false };
                    this.onState("Input paused after a delayed reply — returning to neutral.", this.lastState);
                } else {
                    this.onState(data.estop ? "E-stop active. Release the joystick before resetting."
                        : !data.ready ? `Waiting for CARL: ${data.blocked_reason || "healthy heartbeat and motor status"}.`
                        : data.rejection ? "Delayed input rejected — release and touch again to drive."
                        : data.active ? "Driving — release joystick to command zero."
                        : "Ready — touch and hold the joystick to drive.", data);
                }
                if (this.queued || this.releasePending) this.flush();
            };
            socket.onclose = (event) => {
                if (this.socket === socket) this.reconnect(`Joystick connection lost (code ${event?.code ?? "unknown"}).`);
            };
            socket.onerror = () => {
                if (this.socket === socket) this.reconnect("Joystick connection failed.");
            };
        }

        begin() {
            if (!this.connected || this.paused || !this.lastState?.ready
                || this.lastState.neutral_required) return false;
            this.held = true;
            return true;
        }

        move(x, y) {
            if (!this.held) return;
            if (![x, y].every((v) => Number.isFinite(v) && Math.abs(v) <= 1)) {
                this.release();
                return;
            }
            this.x = x;
            this.y = y;
        }

        release() {
            this.held = false;
            this.x = this.y = 0;
            this.releasePending = true;
            if (this.connected && !this.pending) this.flush();
        }

        pauseMotion() {
            if (this.paused) return;
            this.paused = true;
            this.pauseCount++;
            this.held = false;
            this.x = this.y = 0;
            this.releasePending = true;
            this.lastState = null;
            this.onState("Input paused — waiting for a joystick reply. Motion requires a fresh touch.");
        }

        command(type) {
            if (!["estop", "reset_estop"].includes(type)) throw new Error("Unknown joystick command");
            if (!this.connected) return false;
            // A rapid reset click must never overwrite or overtake an e-stop
            // still queued behind input, or awaiting its server acknowledgement.
            if (type === "reset_estop" && (this.queued?.type === "estop"
                || (this.pending && this.lastPacket?.type === "estop"))) return false;
            this.held = false;
            this.x = this.y = 0;
            this.queued = { type };
            this.flush();
            return true;
        }

        tick() {
            if (!this.running) return;
            if (!this.socket) {
                if (this.retryAt !== null && this.now() >= this.retryAt) this.open();
                return;
            }
            const age = this.now() - this.sentAt;
            if ((!this.connected && age >= 8000) || (this.pending && age >= 3000)) {
                this.reconnect("Joystick reply timed out.");
                return;
            }
            // Expire motion without dropping an otherwise healthy connection.
            if (this.pending && age >= 200) this.pauseMotion();
            this.flush();
        }

        flush() {
            if (!this.connected || this.pending) return;
            const packet = this.queued || { type: "control", x: this.x, y: this.y, deadman: this.held };
            this.queued = null;
            this.releasePending = false;
            this.pending = true;
            this.lastPacket = packet;
            this.sentAt = this.now();
            try { this.socket.send(JSON.stringify({ ...packet, ...(this.token ? { token: this.token } : {}) })); }
            catch { this.reconnect("Joystick send failed."); }
        }

        reconnect(message) {
            const socket = this.socket;
            this.socket = null;
            this.connected = false;
            this.pending = false;
            this.lastState = null;
            this.queued = null;
            this.release();
            if (socket) socket.close();
            if (!this.running) return;
            this.reconnectCount++;
            const delay = Math.min(500 * 2 ** Math.min(this.attempt++, 4), 5000);
            this.retryAt = this.now() + delay;
            this.onState(message + " Reconnecting at neutral…");
        }

        fail(message) {
            this.disconnect();
            this.onState(message);
        }

        disconnect() {
            this.running = false;
            this.clearIntervalFn(this.timer);
            this.timer = null;
            const socket = this.socket;
            this.socket = null;
            this.connected = false;
            this.pending = false;
            this.retryAt = null;
            this.queued = null;
            this.lastState = null;
            this.release();
            if (socket) socket.close();
        }
    }
    globalThis.CarlJoystickClient = CarlJoystickClient;
    if (typeof module !== "undefined") module.exports = CarlJoystickClient;
})();
