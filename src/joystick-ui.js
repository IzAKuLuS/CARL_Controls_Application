"use strict";

(() => {
    const zone = document.getElementById("joystick-zone");
    if (!zone) return;
    const status = document.getElementById("joystick-status");
    const address = document.getElementById("joystick-url");
    const xDisplay = document.getElementById("joystick-x");
    const yDisplay = document.getElementById("joystick-y");
    const leftDisplay = document.getElementById("joystick-left");
    const rightDisplay = document.getElementById("joystick-right");
    const limitDisplay = document.getElementById("joystick-limit");
    const estop = document.getElementById("joystick-estop");
    const reset = document.getElementById("joystick-reset-estop");
    const link = document.getElementById("joystick-link");
    const key = "carl.joystick.url.v1";
    const defaultUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname || "localhost"}:8001/ws`;
    try { address.value = localStorage.getItem(key) || defaultUrl; }
    catch { address.value = defaultUrl; }

    const diagnostics = globalThis.CarlJoystickDiagnostics ? new CarlJoystickDiagnostics({
        onStatus(info) {
            const display = document.getElementById("joystick-log-status");
            if (display) display.textContent = `Browser log: ${info.queued} events awaiting upload · `
                + `${info.dropped} dropped. ${info.storageError || info.uploadError || "Saved locally and uploading."}`
                + (info.serverLogging ? ` Server run: ${info.serverLogging.run_id} · `
                    + `${info.serverLogging.dropped} records dropped${info.serverLogging.error ? ` · ${info.serverLogging.error}` : ""}` : "");
        }
    }) : null;
    const record = (event, data = {}) => diagnostics?.record(event, data);
    record("page_loaded", {user_agent: globalThis.navigator?.userAgent});
    document.getElementById("joystick-export-log")?.addEventListener("click", () => { void diagnostics?.download(); });
    document.getElementById("joystick-save-note")?.addEventListener("click", () => {
        const input = document.getElementById("joystick-test-note");
        const note = input?.value.trim().slice(0, 1000);
        if (note) { record("operator_note", {note}); input.value = ""; }
    });
    for (const event of ["online", "offline", "focus", "blur", "pagehide", "pageshow", "pointercancel", "touchcancel"]) {
        window.addEventListener(event, () => { record(event); if (event === "pagehide") void diagnostics?.flush(); });
    }
    globalThis.navigator?.connection?.addEventListener("change", () => record("network_change"));

    let wanted = false;
    let endpoint = null;
    let joystick;

    function clearDisplay() { xDisplay.textContent = yDisplay.textContent = "0.00"; }
    function clearOutput() { leftDisplay.textContent = rightDisplay.textContent = "0.0%"; }
    function percent(value) { return `${(value * 100).toFixed(1)}%`; }
    const client = new CarlJoystickClient({ onDiagnostic: record,
        isInputActive: () => Boolean(joystick?.isActive()), onState(message, state) {
        status.textContent = message;
        if (link) link.textContent = `Last reply: ${client.lastRttMs ?? "—"} ms · `
            + `Input pauses: ${client.pauseCount} · Reconnect attempts: ${client.reconnectCount}`;
        estop.disabled = reset.disabled = !client.connected;
        limitDisplay.textContent = Number.isFinite(state?.max_throttle) ? percent(state.max_throttle) : "—";
        if (client.held && state?.active && Number.isFinite(state.left) && Number.isFinite(state.right)) {
            leftDisplay.textContent = percent(state.left);
            rightDisplay.textContent = percent(state.right);
        } else clearOutput();
        if (!client.held) { joystick?.reset(); clearDisplay(); }
    } });

    if (typeof PointerEvent === "undefined" || typeof CarlJoystickInput === "undefined") {
        status.textContent = "Joystick unavailable. Use a browser with Pointer Events support.";
        return;
    }
    joystick = new CarlJoystickInput({zone, knob: document.getElementById("joystick-knob"),
        onStart: () => client.begin(), onRelease: release,
        onMove(x, y) {
            // Raw travel; the server applies the throttle curve once.
            client.move(x, y);
            xDisplay.textContent = client.x.toFixed(2);
            yDisplay.textContent = client.y.toFixed(2);
        }
    });
    function release(reason = "release") {
        record("ui_release", {reason}); joystick.reset();
        client.release(reason); clearDisplay(); clearOutput();
    }
    function suspend() {
        release("suspend");
        client.disconnect();
        clearDisplay();
        clearOutput();
        limitDisplay.textContent = "—";
        estop.disabled = reset.disabled = true;
        status.textContent = "Joystick disconnected. Connect to drive.";
    }
    function disconnect() { wanted = false; suspend(); }
    function resume() {
        if (wanted && endpoint && !document.hidden
            && !document.documentElement.classList.contains("auth-pending")) client.connect(endpoint);
    }
    window.addEventListener("pagehide", suspend);
    window.addEventListener("pageshow", (event) => { if (event.persisted) resume(); });
    document.addEventListener("visibilitychange", () => {
        record("visibility_change", {hidden: document.hidden});
        if (document.hidden) suspend();
        else resume();
    });
    document.getElementById("sign-out")?.addEventListener("click", disconnect);
    document.getElementById("joystick-disconnect").addEventListener("click", disconnect);
    document.getElementById("joystick-connection-form").addEventListener("submit", (event) => {
        event.preventDefault();
        try {
            const url = CarlJoystickClient.endpoint(address.value.trim(), location.protocol);
            diagnostics?.setEndpoint(url);
            release("connect");
            endpoint = url;
            wanted = true;
            client.connect(url);
            try { localStorage.setItem(key, url); } catch { /* Storage is optional. */ }
        } catch (error) { status.textContent = error.message; }
    });
    function command(type) {
        joystick.reset(); client.command(type); clearDisplay(); clearOutput();
    }
    estop.addEventListener("click", () => command("estop"));
    reset.addEventListener("click", () => command("reset_estop"));
})();
