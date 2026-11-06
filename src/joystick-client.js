"use strict";

// CARL's 20 Hz input stream. Motion freshness and connection liveness have
// separate deadlines. Every reconnect begins neutral and requires a new touch.
(() => {
    class CarlJoystickClient {
        constructor({ onState = () => {}, onDiagnostic = () => {}, WebSocketClass = globalThis.WebSocket,
            isInputActive = () => true,
            now = () => performance.now(),
            setIntervalFn = (fn, ms) => globalThis.setInterval(fn, ms),
            clearIntervalFn = (id) => globalThis.clearInterval(id) } = {}) {
            Object.assign(this, { onState, onDiagnostic, WebSocketClass, isInputActive, now, setIntervalFn, clearIntervalFn });
            this.clientId = globalThis.crypto?.randomUUID?.() || `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            this.clientSeq = 0;
            this.socket = null;
            this.timer = null;
            this.running = false;
            this.pauseCount = this.reconnectCount = 0;
            this.lastRttMs = null;
            this.release();
        }

        diagnostic(event, data = {}) {
            try { this.onDiagnostic(event, {client_id: this.clientId, run_id: this.runId,
                session_id: this.sessionId, connection_seq: this.connectionSeq, ...data}); } catch { /* Diagnostics must not affect control. */ }
        }

        static endpoint(value, pageProtocol = globalThis.location?.protocol || "http:") {
            const url = new URL(value);
            if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.hash) {
                throw new Error("Enter a ws:// or wss:// joystick address without credentials or a fragment.");
            }
            if (pageProtocol === "https:" && url.protocol !== "wss:") {
                throw new Error("An HTTPS page requires a secure wss:// joystick connection.");
            }
            return url.href;
        }

        connect(endpoint) {
            const url = new URL(CarlJoystickClient.endpoint(endpoint));
            this.disconnect();
            this.url = url.href;
            this.diagnostic('connect_requested', {endpoint: url.origin});
            this.running = true;
            this.attempt = 0;
            this.retryAt = null;
            this.timer = this.setIntervalFn(() => this.tick(), 50);
            this.open();
        }

        open() {
            if (!this.running) return;
            const connectionSeq = this.connectionSeq = (this.connectionSeq || 0) + 1;
            let socketSessionId = null, socketRunId = null;
            this.connected = false;
            this.pending = false;
            this.paused = false;
            this.lastState = null;
            this.lastPacket = null;
            this.queued = null;
            this.token = null;
            this.diagnosticsSupported = false;
            this.sessionId = null;
            this.runId = null;
            this.release();
            this.sentAt = this.now();
            this.retryAt = null;
            this.diagnostic('socket_connecting');
            this.onState("Connecting to joystick server…");
            let socket;
            try { socket = new this.WebSocketClass(this.url); }
            catch (error) {
                this.diagnostic('socket_create_error', {error_type: error.name, detail: error.message});
                this.reconnect("Joystick connection failed."); return;
            }
            this.socket = socket;
            socket.onopen = () => {
                if (this.socket !== socket) return;
                this.diagnostic('socket_open');
                this.connected = true;
                this.flush();
            };
            socket.onmessage = (event) => {
                if (this.socket !== socket) return;
                let data;
                try { data = JSON.parse(event.data); } catch (error) {
                    this.diagnostic('reply_parse_error', {error_type: error.name, detail: "Reply was not valid JSON"});
                    this.fail("Invalid joystick reply."); return;
                }
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
                if (data.diagnostics === 1) {
                    this.diagnosticsSupported = true;
                    this.runId = socketRunId = data.run_id; this.sessionId = socketSessionId = data.session_id;
                }
                this.diagnostic('reply_received', {packet_seq: data.packet_seq, client_seq: data.client_seq,
                    server_mono_ns: data.server_mono_ns, rtt_ms: this.pending ? this.now() - this.sentAt : null,
                    state: {ready: data.ready, active: data.active, neutral_required: data.neutral_required,
                        estop: data.estop, left: data.left, right: data.right,
                        blocked_reason: data.blocked_reason, rejection: data.rejection,
                        last_stop_reason: data.last_stop_reason, stop_count: data.stop_count}});
                this.token = data.token;
                this.attempt = 0;
                if (this.pending) this.lastRttMs = Math.round(this.now() - this.sentAt);
                if (this.pending && this.now() - this.sentAt >= 200) this.pauseMotion();
                const neutralAck = this.lastPacket?.type === "control"
                    && !this.lastPacket.deadman && this.lastPacket.x === 0 && this.lastPacket.y === 0;
                this.pending = false;
                if (neutralAck) {
                    this.paused = false;
                    if (!this.held) this.neutralConfirmed = true;
                }
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
                this.diagnostic('socket_close', {connection_seq: connectionSeq, session_id: socketSessionId, run_id: socketRunId, code: event?.code, reason: event?.reason,
                    was_clean: event?.wasClean, obsolete_socket: this.socket !== socket});
                if (this.socket === socket) this.reconnect(`Joystick connection lost (code ${event?.code ?? "unknown"}).`);
            };
            socket.onerror = () => {
                this.diagnostic('socket_error', {connection_seq: connectionSeq, session_id: socketSessionId, run_id: socketRunId, obsolete_socket: this.socket !== socket});
                if (this.socket === socket) this.reconnect("Joystick connection failed.");
            };
        }

        begin() {
            this.diagnostic('touch_begin_requested', {connected: this.connected, paused: this.paused,
                ready: this.lastState?.ready, neutral_required: this.lastState?.neutral_required});
            // A quick retouch must not replace a queued release. Confirm the
            // neutral packet before accepting another physical hold.
            if (!this.connected || this.paused || !this.lastState?.ready
                || this.lastState.neutral_required || !this.neutralConfirmed
                || this.releasePending || this.queued) return false;
            this.held = true;
            this.neutralConfirmed = false;
            this.diagnostic('touch_begin');
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
            this.diagnostic('touch_move', {x, y});
        }

        release(reason = 'release') {
            if (this.held) this.diagnostic('input_release', {reason});
            this.held = false;
            this.neutralConfirmed = false;
            this.x = this.y = 0;
            this.releasePending = true;
            if (this.connected && !this.pending) this.flush();
        }

        pauseMotion() {
            if (this.paused) return;
            this.paused = true;
            this.pauseCount++;
            this.diagnostic('input_paused', {reply_age_ms: this.now() - this.sentAt, pauses: this.pauseCount});
            this.held = false;
            this.neutralConfirmed = false;
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
            this.diagnostic('operator_command', {type});
            this.neutralConfirmed = false;
            this.queued = { type };
            this.flush();
            return true;
        }

        tick() {
            if (!this.running) return;
            const tickNow = this.now();
            // A suspended event loop may have missed contact cancellation.
            if (this.held && this.lastTick !== undefined && tickNow - this.lastTick >= 200)
                this.pauseMotion();
            if (this.lastTick !== undefined && tickNow - this.lastTick > 150)
                this.diagnostic('browser_timer_late', {interval_ms: tickNow - this.lastTick});
            this.lastTick = tickNow;
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
            // Do not refresh a held command after the DOM loses contact/capture,
            // even if the corresponding cancellation callback was missed.
            if (this.held) {
                let active = false;
                try { active = this.isInputActive(); } catch { /* Fail closed. */ }
                if (!active) {
                    this.diagnostic('input_contact_lost');
                    this.held = false;
                    this.neutralConfirmed = false;
                    this.x = this.y = 0;
                }
            }
            const packet = this.queued || { type: "control", x: this.x, y: this.y, deadman: this.held };
            this.queued = null;
            this.releasePending = false;
            this.pending = true;
            this.lastPacket = packet;
            this.sentAt = this.now();
            const metadata = this.diagnosticsSupported ? {client_id: this.clientId, client_seq: ++this.clientSeq,
                client_mono_ms: this.sentAt, client_wall_ms: Date.now()} : {};
            this.diagnostic('command_send', {...packet, ...metadata, buffered_bytes: this.socket.bufferedAmount});
            try { this.socket.send(JSON.stringify({ ...packet, ...metadata, ...(this.token ? { token: this.token } : {}) })); }
            catch (error) {
                this.diagnostic('command_send_error', {error_type: error.name, detail: error.message,
                    ready_state: this.socket?.readyState, buffered_bytes: this.socket?.bufferedAmount});
                this.reconnect("Joystick send failed.");
            }
        }

        reconnect(message) {
            this.diagnostic('reconnect', {reason: message, reply_age_ms: this.now() - this.sentAt});
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
            this.diagnostic('protocol_error', {reason: message});
            this.disconnect();
            this.onState(message);
        }

        disconnect() {
            this.diagnostic('disconnect_requested');
            this.lastTick = undefined;
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
