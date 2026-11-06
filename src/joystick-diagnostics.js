"use strict";

// Independent of command pacing. Retains a bounded browser copy even after upload.
(() => {
    class CarlJoystickDiagnostics {
        constructor({maxRecords = 20000, fetchFn = globalThis.fetch?.bind(globalThis),
            indexedDB = globalThis.indexedDB, onStatus = () => {},
            now = () => performance.now(), wall = () => Date.now(),
            setIntervalFn = globalThis.setInterval, clearIntervalFn = globalThis.clearInterval} = {}) {
            Object.assign(this, {maxRecords, fetchFn, indexedDB, onStatus, now, wall, clearIntervalFn});
            this.pageId = globalThis.crypto?.randomUUID?.() || `${wall()}-${Math.random().toString(16).slice(2)}`;
            this.seq = this.dropped = 0;
            this.records = []; this.pending = []; this.outbox = [];
            this.persistedThrough = 0;
            this.endpoint = null; this.storageError = null;
            this.ready = this.openStorage();
            this.timer = setIntervalFn(() => { void this.flush(); }, 1000);
            this.timer?.unref?.();
        }

        async openStorage() {
            if (!this.indexedDB) { this.storageError = "Browser storage unavailable; export before closing this page."; return; }
            try {
                this.db = await new Promise((resolve, reject) => {
                    const request = this.indexedDB.open("carl-joystick-diagnostics-v1", 1);
                    request.onupgradeneeded = () => {
                        const store = request.result.createObjectStore("events", {keyPath: "id"});
                        store.createIndex("wall_ms", "wall_ms");
                    };
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                });
                const stored = await this.readStored();
                // Replay retained evidence after reload; IDs allow offline deduplication.
                this.outbox = [...stored, ...this.outbox].slice(-this.maxRecords);
            } catch (error) { this.storageError = String(error); }
        }

        setEndpoint(websocketUrl) {
            const url = new URL(websocketUrl);
            url.protocol = url.protocol === "wss:" ? "https:" : "http:";
            url.pathname = "/diagnostics"; url.search = url.hash = "";
            this.endpoint = url.href;
        }

        record(event, data = {}) {
            const connection = globalThis.navigator?.connection;
            const item = {id: `${this.pageId}:${++this.seq}`, page_id: this.pageId,
                seq: this.seq, event, mono_ms: this.now(), wall_ms: this.wall(),
                online: globalThis.navigator?.onLine ?? null,
                visibility: globalThis.document?.visibilityState ?? null,
                network: connection ? {type: connection.type, effective_type: connection.effectiveType,
                    downlink_mbps: connection.downlink, rtt_ms: connection.rtt, save_data: connection.saveData} : null,
                local_dropped_total: this.dropped, data};
            for (const list of [this.records, this.pending, this.outbox]) {
                list.push(item);
                if (list.length > this.maxRecords) {
                    list.shift();
                    if (list === this.outbox) this.dropped++;
                }
            }
        }

        readStored() {
            return new Promise((resolve, reject) => {
                const request = this.db.transaction("events").objectStore("events").index("wall_ms").getAll();
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        }

        async persist() {
            if (!this.db || !this.pending.length) return;
            const batch = this.pending.slice();
            try {
                await new Promise((resolve, reject) => {
                    const tx = this.db.transaction("events", "readwrite"), store = tx.objectStore("events");
                    batch.forEach(item => store.put(item));
                    const count = store.count();
                    count.onsuccess = () => {
                        let excess = count.result - this.maxRecords;
                        if (excess <= 0) return;
                        const cursor = store.index("wall_ms").openCursor();
                        cursor.onsuccess = () => {
                            if (excess-- > 0 && cursor.result) { cursor.result.delete(); cursor.result.continue(); }
                        };
                    };
                    tx.oncomplete = resolve;
                    tx.onerror = tx.onabort = () => reject(tx.error);
                });
                const ids = new Set(batch.map(item => item.id));
                this.pending = this.pending.filter(item => !ids.has(item.id));
            } catch (error) { this.storageError = String(error); }
        }

        async flush() {
            if (this.flushing) return;
            this.flushing = true;
            try {
                await this.ready;
                await this.persist();
                if (this.endpoint && this.fetchFn && (!this.lastProbe || this.now() - this.lastProbe >= 5000)) {
                    this.lastProbe = this.now();
                    const started = this.now();
                    try {
                        const response = await this.fetchFn(this.endpoint.replace(/\/diagnostics$/, "/health"),
                            {cache: "no-store", signal: AbortSignal.timeout(1000)});
                        const health = response.ok ? await response.json() : null;
                        this.serverLogging = health?.logging;
                        this.record("server_http_probe", {ok: response.ok, status: response.status,
                            elapsed_ms: this.now() - started, ready: health?.ready,
                            run_id: health?.logging?.run_id, logging_error: health?.logging?.error});
                    } catch (error) {
                        this.record("server_http_probe", {ok: false, elapsed_ms: this.now() - started, error: String(error)});
                    }
                }
                if (!this.endpoint || !this.fetchFn || !this.outbox.length) return;
                // Drain faster than the normal 40+ events/s, but bound each request to 60 KB.
                const batch = [];
                let size = 2;
                for (const item of this.outbox.slice(0, 100)) {
                    const length = new TextEncoder().encode(JSON.stringify(item)).length + 1;
                    if (size + length > 60000) break;
                    batch.push(item); size += length;
                }
                if (!batch.length) return;
                const response = await this.fetchFn(this.endpoint, {method: "POST", mode: "cors",
                    headers: {"Content-Type": "text/plain;charset=UTF-8"},
                    body: JSON.stringify(batch), signal: AbortSignal.timeout(1500)});
                if (!response.ok) throw new Error(`Diagnostic upload HTTP ${response.status}`);
                const result = await response.json();
                if (result.accepted !== batch.length) throw new Error("Diagnostic upload incomplete");
                const ids = new Set(batch.map(item => item.id));
                this.outbox = this.outbox.filter(item => !ids.has(item.id));
                this.uploadError = null;
            } catch (error) { this.uploadError = String(error); }
            finally {
                this.flushing = false;
                this.onStatus({queued: this.outbox.length, dropped: this.dropped,
                    serverLogging: this.serverLogging,
                    storageError: this.storageError, uploadError: this.uploadError});
            }
        }

        async exportText() {
            await this.ready;
            const events = new Map();
            try { if (this.db) (await this.readStored()).forEach(item => events.set(item.id, item)); }
            catch (error) { this.storageError = String(error); }
            this.records.forEach(item => events.set(item.id, item));
            return [...events.values()].sort((a, b) => a.wall_ms - b.wall_ms)
                .map(item => JSON.stringify(item)).join("\n") + "\n";
        }

        async download() {
            const blob = new Blob([await this.exportText()], {type: "application/x-ndjson"});
            const url = URL.createObjectURL(blob), link = document.createElement("a");
            link.href = url; link.download = `carl-browser-${this.pageId}.jsonl`;
            link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        }

        close() { this.clearIntervalFn(this.timer); this.db?.close(); }
    }
    globalThis.CarlJoystickDiagnostics = CarlJoystickDiagnostics;
    if (typeof module !== "undefined") module.exports = CarlJoystickDiagnostics;
})();
