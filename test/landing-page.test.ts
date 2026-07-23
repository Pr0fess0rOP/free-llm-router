import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readPublicFile } from "../src/dashboard.js";

const root = new URL("../", import.meta.url);

test("root is a public landing page and dashboard remains isolated", async () => {
  const landing = await readFile(new URL("public/index.html", root), "utf8");
  const dashboard = await readFile(new URL("public/dashboard.html", root), "utf8");

  assert.match(landing, /One API for every/);
  assert.match(landing, /26[\s\S]*providers/);
  assert.match(landing, /href="\/dashboard"/);
  assert.match(landing, /href="\/docs"/);
  assert.match(landing, /id="features"/);
  assert.match(landing, /id="providers"/);
  assert.match(landing, /id="workflow"/);
  assert.doesNotMatch(landing, /id="auth-gate"/);
  assert.doesNotMatch(landing, /src="\/app\.js"/);

  assert.match(dashboard, /id="auth-gate"/);
  assert.match(dashboard, /id="dashboard"/);
  assert.match(dashboard, /src="\/app\.js"/);
});

test("public docs expose all supported API surfaces and quick-start actions", async () => {
  const docs = await readFile(new URL("public/docs.html", root), "utf8");

  for (const section of [
    "overview",
    "deploy",
    "configure",
    "first-request",
    "chat-completions",
    "responses",
    "messages",
    "aliases",
    "reliability",
    "security",
  ]) {
    assert.match(docs, new RegExp(`id="${section}"`));
  }

  assert.match(docs, /\/v1\/chat\/completions/);
  assert.match(docs, /\/v1\/responses/);
  assert.match(docs, /\/v1\/messages/);
  assert.match(docs, /CLERK_PUBLISHABLE_KEY/);
  assert.match(docs, /data-copy-target=/);
});

test("friendly public routes resolve to their static documents", async () => {
  const landing = await readPublicFile("/");
  const dashboard = await readPublicFile("/dashboard");
  const signIn = await readPublicFile("/sign-in");
  const docs = await readPublicFile("/docs");

  assert.match(landing?.body.toString("utf8") ?? "", /One API for every/);
  assert.match(dashboard?.body.toString("utf8") ?? "", /id="auth-gate"/);
  assert.match(signIn?.body.toString("utf8") ?? "", /id="clerk-sign-in"/);
  assert.match(docs?.body.toString("utf8") ?? "", /Quick-start documentation/);
});

test("Vercel rewrites preserve landing, docs, dashboard, and sign-in routes", async () => {
  const vercel = JSON.parse(await readFile(new URL("vercel.json", root), "utf8")) as {
    rewrites: Array<{ source: string; destination: string }>;
  };
  const bySource = new Map(vercel.rewrites.map((rewrite) => [rewrite.source, rewrite.destination]));

  assert.equal(bySource.get("/dashboard"), "/dashboard.html");
  assert.equal(bySource.get("/sign-in"), "/dashboard.html");
  assert.equal(bySource.get("/docs"), "/docs.html");
});

test("dashboard authentication returns to the dashboard route", async () => {
  const app = await readFile(new URL("public/app.js", root), "utf8");
  assert.match(app, /fallbackRedirectUrl: "\/dashboard"/);
  assert.match(app, /signUpFallbackRedirectUrl: "\/dashboard"/);
});

test("landing page motion is interactive, local, and accessibility-aware", async () => {
  const landing = await readFile(new URL("public/index.html", root), "utf8");
  const script = await readFile(new URL("public/landing.js", root), "utf8");
  const styles = await readFile(new URL("public/landing.css", root), "utf8");

  assert.match(landing, /data-scroll-progress/);
  assert.match(landing, /data-route-demo/);
  assert.match(landing, /data-route-replay/);
  assert.match(landing, /data-route-announcer/);
  assert.match(landing, /data-counter-value="26"/);
  assert.match(landing, /data-interactive-card/);
  assert.match(landing, /data-reveal/);

  assert.match(script, /IntersectionObserver/);
  assert.match(script, /requestAnimationFrame/);
  assert.match(script, /prefers-reduced-motion/);
  assert.match(script, /playRouteTrace/);
  assert.match(script, /enableInteractiveCards/);
  assert.match(script, /enableHeroParallax/);

  assert.match(styles, /@keyframes routePulse/);
  assert.match(styles, /@keyframes chartDraw/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(landing, /https?:\/\/(?!your-router\.com)/);
});
