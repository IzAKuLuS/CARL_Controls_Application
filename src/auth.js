"use strict";

(() => {
    const ATTEMPT_LIMIT = 5;
    const FIRST_WAIT_MS = 4 * 60 * 1000;
    const LOCK_KEY = "carl.login.lock.v1";
    const SESSION_KEY = "carl.login.session.v1";

    function emptyState() {
        return { failures: 0, waitMs: 0, lockedUntil: 0 };
    }

    function remainingMs(state, now) {
        return Math.max(0, state.lockedUntil - now);
    }

    function allowed(value, passcodes) {
        return typeof value === "string" && /^[0-9]{8}$/.test(value)
            && passcodes.includes(value);
    }

    // Expiry does NOT reset failures. After the fifth failure, each further
    // failure doubles the previous wait. Only a successful login resets it.
    function failedAttempt(state, now) {
        if (remainingMs(state, now) > 0) return state;
        const failures = state.failures + 1;
        if (failures < ATTEMPT_LIMIT) return { failures, waitMs: 0, lockedUntil: 0 };
        // Bound arithmetic only at JavaScript's maximum exact integer range.
        const waitMs = Math.min(state.waitMs ? state.waitMs * 2 : FIRST_WAIT_MS,
            Number.MAX_SAFE_INTEGER - now);
        return { failures, waitMs, lockedUntil: now + waitMs };
    }

    function formatTime(ms) {
        const seconds = Math.ceil(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
    }

    // Keep policy functions separate from DOM work for repeatable clock-based tests.
    globalThis.CarlLoginPolicy = { emptyState, remainingMs, allowed, failedAttempt, formatTime };
    if (typeof document === "undefined") return;

    const form = document.getElementById("passcode-form");
    const passcodes = window.CARL_PASSCODES;
    const configurationValid = Array.isArray(passcodes)
        && passcodes.every((value) => typeof value === "string" && /^[0-9]{8}$/.test(value));

    function signedIn() {
        if (!configurationValid) return false;
        try {
            // Recheck the configured allowlist on navigation/reload: removing a
            // passcode also invalidates sessions admitted with that passcode.
            return allowed(sessionStorage.getItem(SESSION_KEY), passcodes);
        } catch {
            return false;
        }
    }

    function guardPage() {
        if (!signedIn()) {
            window.location.replace("login.html");
            return;
        }
        document.documentElement.classList.remove("auth-pending");
    }

    if (!form) {
        guardPage();
        // Back/forward cache must not reveal a page after signing out.
        window.addEventListener("pageshow", guardPage);
        document.getElementById("sign-out")?.addEventListener("click", () => {
            sessionStorage.removeItem(SESSION_KEY);
            document.documentElement.classList.add("auth-pending");
            window.location.replace("login.html");
        });
        return;
    }

    const input = document.getElementById("passcode");
    const submit = document.getElementById("sign-in");
    const message = document.getElementById("login-message");
    const countdown = document.getElementById("cooldown");
    let lastMessage = "";

    function readState() {
        const raw = localStorage.getItem(LOCK_KEY);
        if (raw === null) return emptyState();
        const state = JSON.parse(raw);
        if (!state || !["failures", "waitMs", "lockedUntil"].every(
            (key) => Number.isSafeInteger(state[key]) && state[key] >= 0
        )) throw new Error("Invalid stored login state.");
        return state;
    }

    function render() {
        try {
            if (!configurationValid || passcodes.length === 0) {
                throw new Error("No valid passcodes are configured. Check passcodes.js.");
            }
            const state = readState();
            const remaining = remainingMs(state, Date.now());
            input.disabled = submit.disabled = remaining > 0;
            if (remaining > 0) {
                message.textContent = "Too many incorrect attempts. Sign-in is temporarily locked.";
                countdown.textContent = `Try again in ${formatTime(remaining)}.`;
            } else {
                countdown.textContent = "";
                message.textContent = state.failures >= ATTEMPT_LIMIT
                    ? `Cooldown finished. Another incorrect attempt will lock sign-in for ${formatTime(state.waitMs * 2)}.`
                    : lastMessage || (state.failures
                        ? `${ATTEMPT_LIMIT - state.failures} attempts remaining before a four-minute cooldown.`
                        : "");
            }
        } catch (error) {
            // Do not silently bypass lockout when storage or configuration fails.
            input.disabled = submit.disabled = true;
            message.textContent = `Sign-in unavailable: ${error.message}`;
            countdown.textContent = "";
        }
    }

    form.addEventListener("submit", (event) => {
        event.preventDefault();
        try {
            const state = readState();
            // Also enforce cooldown in the handler, independent of disabled buttons.
            if (!configurationValid || passcodes.length === 0
                || remainingMs(state, Date.now()) > 0) {
                render();
                return;
            }
            if (allowed(input.value, passcodes)) {
                // sessionStorage keeps admission for this tab. localStorage shares
                // failed attempts and cooldown across tabs and browser reloads.
                sessionStorage.setItem(SESSION_KEY, input.value);
                localStorage.removeItem(LOCK_KEY);
                input.value = "";
                window.location.replace("index.html");
                return;
            }
            const next = failedAttempt(state, Date.now());
            localStorage.setItem(LOCK_KEY, JSON.stringify(next));
            lastMessage = `Incorrect passcode. ${Math.max(0, ATTEMPT_LIMIT - next.failures)} attempts remaining before cooldown.`;
            input.value = "";
            render();
            if (!input.disabled) input.focus();
        } catch (error) {
            message.textContent = `Unable to save login state: ${error.message}`;
            input.disabled = submit.disabled = true;
        }
    });

    window.addEventListener("storage", (event) => {
        if (event.key === LOCK_KEY || event.key === null) render();
    });
    // Absolute expiry survives reloads; the interval only refreshes the display.
    setInterval(render, 250);
    render();
})();
