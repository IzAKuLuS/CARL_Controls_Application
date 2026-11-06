"use strict";

// One physical pointer owns a hold. Only a new pointerdown can arm movement;
// move, reconnect, and delayed events can never re-arm a cancelled gesture.
(() => {
    class CarlJoystickInput {
        constructor({zone, knob, onStart, onMove, onRelease}) {
            Object.assign(this, {zone, knob, onStart, onMove, onRelease});
            this.pointerId = null;
            const rejectedStarts = new WeakSet();
            const prevent = (event) => { if (event.cancelable) event.preventDefault(); };
            zone.addEventListener("pointerdown", (event) => {
                prevent(event);
                if (rejectedStarts.has(event)) return;
                if (this.pointerId !== null) { this.cancel("additional_pointer"); return; }
                if (!event.isPrimary || event.button !== 0 || event.buttons !== 1
                    || !Number.isFinite(event.pointerId) || !this.coordinates(event)) return;
                if (!onStart()) return;
                this.pointerId = event.pointerId;
                try { zone.setPointerCapture(event.pointerId); }
                catch { this.cancel("capture_failed"); return; }
                this.move(event);
            }, {passive: false});
            zone.addEventListener("pointermove", (event) => {
                if (event.pointerId !== this.pointerId) return;
                prevent(event);
                this.move(event);
            }, {passive: false});
            // Capture phase sees release even when another widget stops bubbling.
            for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
                document.addEventListener(type, (event) => {
                    if (event.pointerId === this.pointerId) this.cancel(type);
                }, true);
            }
            document.addEventListener("pointerdown", (event) => {
                if (this.pointerId !== null && event.pointerId !== this.pointerId) {
                    rejectedStarts.add(event);
                    this.cancel("additional_pointer");
                }
            }, true);
            // A second, independent release path for browsers that lose a
            // PointerEvent during native touch UI. Never arm from TouchEvents.
            for (const type of ["touchend", "touchcancel", "touchstart"]) {
                document.addEventListener(type, (event) => {
                    if (type === "touchcancel" || event.touches?.length !== 1) this.cancel(type);
                }, {capture: true, passive: true});
            }
            for (const type of ["contextmenu", "selectstart", "dragstart", "gesturestart"]) {
                zone.addEventListener(type, (event) => { prevent(event); this.cancel(type); }, {passive: false});
            }
            document.addEventListener("selectionchange", () => {
                if (document.getSelection()?.isCollapsed === false) this.cancel("selectionchange");
            });
            for (const type of ["blur", "pagehide", "resize", "orientationchange", "scroll"]) {
                window.addEventListener(type, () => this.cancel(type), true);
            }
            document.addEventListener("visibilitychange", () => {
                if (document.hidden) this.cancel("hidden");
            });
            this.reset();
        }

        coordinates(event) {
            const box = this.zone.getBoundingClientRect();
            if (![event.clientX, event.clientY, box.left, box.top, box.width, box.height].every(Number.isFinite)
                || box.width <= 0 || box.height <= 0) return null;
            // Preserve the existing 150px stick and 75px travel radius.
            const dx = event.clientX - (box.left + box.width / 2);
            const dy = (box.top + box.height / 2) - event.clientY;
            const scale = Math.max(75, Math.hypot(dx, dy));
            return [dx / scale, dy / scale];
        }

        isActive() {
            return this.pointerId !== null && !document.hidden
                && this.zone.hasPointerCapture(this.pointerId);
        }

        move(event) {
            if (!this.isActive() || event.buttons !== 1) { this.cancel("contact_lost"); return; }
            const point = this.coordinates(event);
            if (!point) { this.cancel("invalid_coordinates"); return; }
            const [x, y] = point;
            this.knob.style.transform = `translate(${x * 75}px, ${-y * 75}px)`;
            this.onMove(x, y);
        }

        reset() {
            const id = this.pointerId;
            // Clear ownership before releasing capture: lostpointercapture can
            // fire during cleanup and must not stop a subsequent fresh gesture.
            this.pointerId = null;
            this.knob.style.transform = "translate(0px, 0px)";
            if (id !== null) {
                try { this.zone.releasePointerCapture(id); } catch { /* Already cancelled by browser. */ }
            }
        }

        cancel(reason) {
            if (this.pointerId === null) return;
            this.reset();
            this.onRelease(reason);
        }
    }
    globalThis.CarlJoystickInput = CarlJoystickInput;
    if (typeof module !== "undefined") module.exports = CarlJoystickInput;
})();
