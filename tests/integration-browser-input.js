"use strict";
// Optional real-engine checks, with a simulated WebSocket peer and no CARL link.
// npm install --prefix /tmp/carl-browser-tests playwright
// CARL_PLAYWRIGHT_MODULE=/tmp/carl-browser-tests/node_modules/playwright node tests/integration-browser-input.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {chromium, webkit} = require(process.env.CARL_PLAYWRIGHT_MODULE || "playwright");
const src = path.resolve(__dirname, "../src");

async function check(name, type) {
    const browser = await type.launch({headless: true, ...(name === "chromium" ? {
        executablePath: process.env.CARL_CHROMIUM_EXECUTABLE || undefined,
        args: ["--no-sandbox", "--disable-dev-shm-usage"]
    } : {})});
    try {
        const context = await browser.newContext({viewport: {width: 430, height: 932}, isMobile: true, hasTouch: true});
        await context.route("http://carl.test/**", async route => {
            const basename = path.basename(new URL(route.request().url()).pathname);
            // Synthetic admission data only; this test does not exercise login policy.
            if (basename === "passcodes.js") return route.fulfill({contentType: "text/javascript", body: 'window.CARL_PASSCODES=["00000000"];'});
            if (basename === "health" || basename === "browser-events") return route.fulfill({contentType: "application/json", body: "{}"});
            const file = path.join(src, basename);
            if (!fs.existsSync(file)) return route.fulfill({status: 404, body: "Missing test asset"});
            await route.fulfill({contentType: basename.endsWith(".js") ? "text/javascript"
                : basename.endsWith(".css") ? "text/css" : "text/html", body: fs.readFileSync(file)});
        });
        const page = await context.newPage(), errors = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.addInitScript(() => {
            sessionStorage.setItem("carl.login.session.v1", "00000000");
            window.__packets = [];
            window.__connections = [];
            // Protocol-only peer. Real throttle shaping and firmware wire outputs
            // are validated separately by the ROS integration suite.
            window.WebSocket = class {
                constructor(url) { window.__connections.push(url); this.bufferedAmount = 0; setTimeout(() => this.onopen?.(), 0); }
                send(value) {
                    const packet = JSON.parse(value); window.__packets.push(packet);
                    setTimeout(() => this.onmessage?.({data: JSON.stringify({protocol: 2,
                        token: "0123456789abcdef", ready: true, neutral_required: false,
                        active: Boolean(packet.deadman), left: packet.deadman ? packet.y : 0,
                        right: packet.deadman ? packet.y : 0, max_throttle: 0.75})}), 5);
                }
                close() { setTimeout(() => this.onclose?.({code: 1000}), 0); }
            };
            document.addEventListener("pointerdown", e => { window.__pointerId = e.pointerId; }, true);
        });
        await page.goto("http://carl.test/joystick.html");
        assert.equal(await page.locator("#telemetry-sections, #ros-connection-form, #rosbridge-url, #carl-connection-status").count(), 0);
        assert.equal(await page.locator('script[src="app.js"], script[src="ros-client.js"]').count(), 0);
        assert.deepEqual(await page.evaluate(() => window.__connections), []);
        await page.getByRole("button", {name: "Connect joystick", exact: true}).click();
        await page.waitForFunction(() => document.querySelector("#joystick-status").textContent.startsWith("Ready"));
        const zone = page.locator("#joystick-zone");
        await zone.scrollIntoViewIfNeeded();
        const box = await zone.boundingBox();
        const x = box.x + box.width / 2, y = box.y + box.height / 2 - 37.5;
        const active = () => page.waitForFunction(() => window.__packets.at(-1)?.deadman === true);
        const zero = () => page.waitForFunction(() => {
            const p = window.__packets.at(-1);
            return p?.type === "control" && p.deadman === false && p.x === 0 && p.y === 0
                && document.querySelector("#joystick-status").textContent.startsWith("Ready");
        });
        const press = async () => { await page.mouse.move(x, y); await page.mouse.down(); await active(); };
        assert.equal(await zone.evaluate(el => getComputedStyle(el).userSelect), "none");
        assert.equal(await page.locator("#joystick-knob").evaluate(el => getComputedStyle(el).userSelect), "none");
        assert.notEqual(await page.locator("#joystick-url").evaluate(el => getComputedStyle(el).userSelect), "none");
        // Linux WebKit does not implement the iOS-only callout property.
        // Verify the declaration is shipped; assert its computed value where supported.
        assert.match(fs.readFileSync(path.join(src, "styles.css"), "utf8"), /-webkit-touch-callout:\s*none/);
        if (await page.evaluate(() => CSS.supports("-webkit-touch-callout", "none")))
            assert.equal(await zone.evaluate(el => getComputedStyle(el).getPropertyValue("-webkit-touch-callout")), "none");
        for (const type of ["contextmenu", "selectstart", "dragstart", "gesturestart"]) {
            await press();
            assert.equal(await zone.evaluate((el, type) => !el.dispatchEvent(new Event(type, {cancelable: true, bubbles: true})), type), true);
            await zero();
            await page.mouse.move(x + 10, y - 10); await page.waitForTimeout(100); await zero();
            await page.mouse.up();
        }
        await press();
        await zone.evaluate(el => el.releasePointerCapture(window.__pointerId));
        await zero(); await page.mouse.up();
        await press();
        await zone.dispatchEvent("pointercancel", {pointerId: await page.evaluate(() => window.__pointerId), pointerType: "touch"});
        await zero(); await page.mouse.up();
        await press();
        await page.evaluate(() => document.dispatchEvent(new Event("touchcancel", {bubbles: true})));
        await zero(); await page.mouse.up();
        await press();
        await page.mouse.move(5, 5); await page.mouse.up(); await zero(); // Release outside the control.
        await press();
        await page.evaluate(() => window.dispatchEvent(new Event("blur")));
        await zero(); await page.mouse.up();
        await press();
        // Preserve a stationary hold; no stream of move events is required.
        await page.waitForTimeout(1200); await active();
        await page.mouse.up(); await zero();
        await page.getByRole("button", {name: "Disconnect joystick", exact: true}).click();
        await page.getByRole("button", {name: "Connect joystick", exact: true}).click();
        await page.waitForFunction(() => document.querySelector("#joystick-status").textContent.startsWith("Ready"));
        await zone.scrollIntoViewIfNeeded();
        const next = await zone.boundingBox();
        await page.mouse.move(next.x + next.width / 2, next.y + next.height / 2 - 37.5);
        await page.mouse.down(); await active(); await page.mouse.up(); await zero();
        if (name === "chromium") {
            const session = await context.newCDPSession(page);
            const point = {x: next.x + next.width / 2, y: next.y + next.height / 2 - 37.5, id: 1};
            await session.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [point]});
            await active(); await page.waitForTimeout(1200); await active();
            assert.equal(await page.evaluate(() => document.getSelection().isCollapsed), true);
            await session.send("Input.dispatchTouchEvent", {type: "touchCancel", touchPoints: []});
            await zero();
            await session.send("Input.dispatchTouchEvent", {type: "touchStart", touchPoints: [point]});
            await active();
            await session.send("Input.dispatchTouchEvent", {type: "touchEnd", touchPoints: []});
            await zero();
        }
        if (process.env.CARL_BROWSER_ARTIFACT_DIR) await zone.screenshot({path: path.join(process.env.CARL_BROWSER_ARTIFACT_DIR, `carl-${name}-joystick.png`)});
        assert.ok(await page.evaluate(() => window.__connections.length > 0
            && window.__connections.every(url => url === "ws://carl.test:8001/ws")));
        assert.equal(await page.evaluate(() => window.__packets.some(packet => packet.op)), false);
        assert.deepEqual(errors, []);
        console.log(`${name}: no telemetry or rosbridge connection; scoped CSS, captured hold, native DOM interruptions, outside release, long hold and reconnect recovery passed`);
        await context.close();
    } finally { await browser.close(); }
}
(async () => {
    const engines = {chromium, webkit};
    for (const name of (process.env.CARL_BROWSER_ENGINES || "chromium,webkit").split(",")) {
        assert.ok(engines[name], `Unsupported browser engine: ${name}`);
        await check(name, engines[name]);
    }
})()
    .catch(error => { console.error(error); process.exitCode = 1; });
