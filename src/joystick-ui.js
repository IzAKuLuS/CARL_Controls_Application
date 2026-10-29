"use strict";

(() => {
    const zone = document.getElementById("joystick-zone");
    if (!zone) return;
    const status = document.getElementById("joystick-status");
    const address = document.getElementById("joystick-url");
    const xDisplay = document.getElementById("joystick-x");
    const yDisplay = document.getElementById("joystick-y");
    const estop = document.getElementById("joystick-estop");
    const reset = document.getElementById("joystick-reset-estop");
    const link = document.getElementById("joystick-link");
    const key = "carl.joystick.url.v1";
    const defaultUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname || "localhost"}:8001/ws`;
    try { address.value = localStorage.getItem(key) || defaultUrl; }
    catch { address.value = defaultUrl; }

    let wanted = false;
    let endpoint = null;

    function clearDisplay() { xDisplay.textContent = yDisplay.textContent = "0.00"; }
    const client = new CarlJoystickClient({ onState(message, state) {
        status.textContent = message;
        if (link) link.textContent = `Last reply: ${client.lastRttMs ?? "—"} ms · `
            + `Input pauses: ${client.pauseCount} · Reconnect attempts: ${client.reconnectCount}`;
        estop.disabled = reset.disabled = !client.connected;
        if (!state?.active) clearDisplay();
    } });

    if (typeof nipplejs === "undefined") {
        status.textContent = "Joystick library could not load. Check your connection and reload.";
        return;
    }
    const joystick = nipplejs.create({ zone, mode: "static",
        // Status text, scrolling and responsive layout can move the zone after
        // initialization. Re-read its center before even the first move event.
        dynamicPage: true,
        position: { left: "50%", top: "50%" }, color: "#888", size: 150, restOpacity: 1 });
    joystick.on("start", () => client.begin());
    joystick.on("move", (event, data) => {
        if (!Number.isFinite(data?.distance) || data.distance < 0
            || !Number.isFinite(data?.vector?.x) || !Number.isFinite(data?.vector?.y)) {
            release();
            return;
        }
        // Retain the existing soft-center response curve and +Y-up convention.
        const distance = Math.min(data.distance / 75, 1);
        const x = Math.max(-1, Math.min(1, data.vector.x * distance));
        const y = Math.max(-1, Math.min(1, data.vector.y * distance));
        client.move(x, y);
        xDisplay.textContent = client.x.toFixed(2);
        yDisplay.textContent = client.y.toFixed(2);
    });
    function release() { client.release(); clearDisplay(); }
    joystick.on("end", release);
    window.addEventListener("blur", release);
    window.addEventListener("pointercancel", release);
    window.addEventListener("touchcancel", release);
    function suspend() {
        client.disconnect();
        clearDisplay();
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
        if (document.hidden) suspend();
        else resume();
    });
    document.getElementById("sign-out")?.addEventListener("click", disconnect);
    document.getElementById("joystick-disconnect").addEventListener("click", disconnect);
    document.getElementById("joystick-connection-form").addEventListener("submit", (event) => {
        event.preventDefault();
        try {
            const url = CarlRosClient.endpoint(address.value.trim(), location.protocol);
            endpoint = url;
            wanted = true;
            client.connect(url);
            try { localStorage.setItem(key, url); } catch { /* Storage is optional. */ }
        } catch (error) { status.textContent = error.message; }
    });
    estop.addEventListener("click", () => { client.command("estop"); clearDisplay(); });
    reset.addEventListener("click", () => { client.command("reset_estop"); clearDisplay(); });
})();
