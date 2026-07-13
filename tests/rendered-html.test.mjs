import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the player study", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Pac-Man DDA Player Study<\/title>/i);
  assert.match(html, /Player study/i);
  assert.match(html, /Start session/i);
  assert.match(html, /anonymous gameplay metrics/i);
});

test("collector keeps feedback labels, mobile controls, and cloud keys explicit", async () => {
  const [collector, styles, supabase, envExample] = await Promise.all([
    readFile(new URL("../app/GameCollector.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../lib/supabase.ts", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ]);

  assert.match(collector, /too_difficult/);
  assert.match(collector, /balanced/);
  assert.match(collector, /too_easy/);
  assert.match(collector, /label_source/);
  assert.match(collector, /respawningUntil = Math\.max\(now \+ 1800, game\.frozenUntil \+ 600\)/);
  assert.match(collector, /firstActionAt = Math\.max\(performance\.now\(\), game\.readyUntil\)/);
  assert.match(collector, /buildFairMaze\(17, 29, 5\)/);
  assert.match(collector, /validateFairMaze/);
  assert.match(collector, /deadEnds > 0/);
  assert.match(collector, /nearbyGhosts >= 2 \? baseChase \* 0\.48/);
  assert.match(collector, /window\.setInterval/);
  assert.match(collector, /visibilitychange/);
  assert.match(collector, /thankz cuddh\.\.much love/);
  assert.match(collector, /means a lot\.\.\.<3/);
  assert.match(collector, /"Play again"/);
  assert.match(collector, /submitSessionFeedback/);
  assert.match(collector, /Leave a note/);
  assert.match(collector, /maxLength=\{1000\}/);
  assert.doesNotMatch(collector, /exportPendingRecords/);
  assert.doesNotMatch(collector, /Retry synchronization/);
  assert.doesNotMatch(supabase, /exportPendingRecords/);
  assert.match(supabase, /web_session_feedback/);
  assert.match(collector, /onPointerDown=\{startSwipe\}/);
  assert.match(collector, /onPointerUp=\{finishSwipe\}/);
  assert.match(styles, /touch-action:\s*none/);
  assert.match(styles, /\.dpad \.up/);
  assert.match(styles, /@media \(max-width:\s*760px\)/);
  assert.match(supabase, /pacman-dda-pending-v1/);
  assert.match(supabase, /response\.status === 409/);
  assert.match(supabase, /conflict\.code === "23505"/);
  assert.doesNotMatch(supabase, /on_conflict/);
  assert.match(supabase, /SUPABASE_KEY\.startsWith\("eyJ"\)/);
  assert.match(envExample, /NEXT_PUBLIC_SUPABASE_ANON_KEY=replace_with_public_anon_key/);
  assert.doesNotMatch(envExample, /service_role/i);
});
