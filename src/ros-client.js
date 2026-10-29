"use strict";

// Receive-only rosbridge transport. Keeping this separate from the display
// lets the UI refresh slowly without limiting incoming ROS message rates.
(() => {
    class CarlRosClient {
        constructor({ topics, onState = () => {}, onMessage = () => {},
            onTopicError = () => {}, WebSocketClass = globalThis.WebSocket,
            setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
            clearTimer = (id) => globalThis.clearTimeout(id) }) {
            this.topics = topics;
            this.onState = onState;
            this.onMessage = onMessage;
            this.onTopicError = onTopicError;
            this.WebSocketClass = WebSocketClass;
            this.setTimer = setTimer;
            this.clearTimer = clearTimer;
            this.socket = null;
            this.retryTimer = null;
            this.openTimer = null;
            this.attempt = 0;
            this.running = false;
        }

        static endpoint(value, pageProtocol = "http:") {
            const url = new URL(value);
            if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.hash) {
                throw new Error("Enter a ws:// or wss:// address without credentials or a fragment.");
            }
            if (pageProtocol === "https:" && url.protocol !== "wss:") {
                throw new Error("An HTTPS page requires a secure wss:// rosbridge connection.");
            }
            return url.href;
        }

        connect(endpoint) {
            const url = CarlRosClient.endpoint(endpoint);
            this.disconnect();
            this.url = url;
            this.running = true;
            this.attempt = 0;
            this.open();
        }

        open() {
            if (!this.running) return;
            this.onState("connecting", `Connecting to ${this.url}`);
            let socket;
            try {
                socket = new this.WebSocketClass(this.url);
            } catch (error) {
                this.retry(error.message);
                return;
            }
            this.socket = socket;
            this.openTimer = this.setTimer(() => {
                if (this.socket !== socket) return;
                this.socket = null;
                socket.close();
                this.retry("Connection timed out.");
            }, 8000);

            socket.onopen = () => {
                if (this.socket !== socket) return;
                this.clearTimer(this.openTimer);
                this.openTimer = null;
                this.attempt = 0;
                try {
                    for (const topic of this.topics) {
                        socket.send(JSON.stringify({
                            op: "subscribe", id: `telemetry:${topic.topic}`,
                            topic: topic.topic, type: topic.type,
                            // The screen renders at 10 Hz. Keep only the newest
                            // sample per interval instead of competing with
                            // joystick traffic for every high-rate IMU sample.
                            compression: "none", throttle_rate: 100, queue_length: 1
                        }));
                    }
                    this.onState("connected", "rosbridge connected.");
                } catch {
                    socket.close();
                }
            };
            socket.onmessage = (event) => {
                if (this.socket !== socket) return;
                let data;
                try { data = JSON.parse(event.data); } catch { return; }
                if (!data || typeof data !== "object") return;
                if (data.op === "status" && ["error", "warning"].includes(data.level)) {
                    const topic = this.topics.find((entry) => data.id === `telemetry:${entry.topic}`);
                    if (topic) this.onTopicError(topic.topic, String(data.msg || "Subscription failed."));
                    return;
                }
                if (data.op !== "publish" || !data.msg || typeof data.msg !== "object"
                    || Array.isArray(data.msg) || !this.topics.some((entry) => entry.topic === data.topic)) return;
                this.onMessage(data.topic, data.msg);
            };
            // Browsers provide little detail for socket errors. onclose handles
            // reconnection; the open timeout also covers stalled handshakes.
            socket.onerror = () => {};
            socket.onclose = () => {
                if (this.socket !== socket) return;
                this.socket = null;
                this.clearTimer(this.openTimer);
                this.openTimer = null;
                this.retry("rosbridge connection lost or unavailable.");
            };
        }

        retry(reason) {
            if (!this.running) return;
            const delay = Math.min(1000 * 2 ** Math.min(this.attempt++, 5), 30000);
            this.onState("reconnecting", `${reason} Retrying in ${delay / 1000}s.`);
            this.retryTimer = this.setTimer(() => {
                this.retryTimer = null;
                this.open();
            }, delay);
        }

        disconnect() {
            this.running = false;
            this.clearTimer(this.retryTimer);
            this.clearTimer(this.openTimer);
            this.retryTimer = this.openTimer = null;
            const socket = this.socket;
            this.socket = null;
            if (socket) socket.close();
            this.onState("disconnected", "Disconnected.");
        }
    }

    globalThis.CarlRosClient = CarlRosClient;
    if (typeof module !== "undefined") module.exports = CarlRosClient;
})();
