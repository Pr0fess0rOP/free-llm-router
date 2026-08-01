import fs from "node:fs/promises";
import path from "node:path";

import { Presentation, PresentationFile } from "@oai/artifact-tool";
import { buildSlide02 } from "./slide-02.mjs";
import { buildSlide11 } from "./slide-11.mjs";
import { buildSlide12 } from "./slide-12.mjs";
import { buildSlide13 } from "./slide-13.mjs";
import { buildSlide16 } from "./slide-16.mjs";
import { buildSlide17 } from "./slide-17.mjs";
import { buildSlide18 } from "./slide-18.mjs";
import { buildSlide19 } from "./slide-19.mjs";
import { buildSlide26 } from "./slide-26.mjs";

const ROOT = "D:/Pavallion/Coding Slashers/Pr0fess0rOP Github Repos/free-llm-router";
const TMP = `${ROOT}/.tmp/free-llm-router-mvp-deck`;
const FINAL = `${ROOT}/artifacts/Free_LLM_Router_MVP_Presentation.pptx`;
const RENDER_DIR = `${TMP}/rendered`;
const GREEN = "#0F6B52";
const BLACK = "#111A17";
const MUTED = "#53615C";

function paragraph(text, options = {}) {
  const {
    size = 21.33,
    bold = false,
    color = BLACK,
    spaceAfter = 0,
    spaceBefore = 0,
    bullet = false,
  } = options;
  return {
    runs: [{ run: text, textStyle: { fontSize: `${size}px`, typeface: "Helvetica Neue", color, bold } }],
    ...(spaceAfter ? { spaceAfter } : {}),
    ...(spaceBefore ? { spaceBefore } : {}),
    ...(bullet ? { bulletCharacter: "•", marginLeft: 2540, indent: 0 } : {}),
    paragraphStyle: { lineSpacingPercent: 108000 },
  };
}

function title(text) {
  return paragraph(text, { size: 38.67, bold: true, color: GREEN });
}

function pair(heading, body, compact = false) {
  return {
    titleGoesHere: paragraph(heading, { size: compact ? 20 : 23, bold: true, color: GREEN, spaceAfter: 450 }),
    loremIpsumDolorSitAmetConsecteturAdipiscing: paragraph(body, { size: compact ? 16 : 17.5, color: MUTED }),
  };
}

function pairHere(heading, body, compact = false) {
  return {
    titleHere: paragraph(heading, { size: compact ? 20 : 23, bold: true, color: GREEN, spaceAfter: 450 }),
    loremIpsumDolorSitAmetConsecteturAdipiscing: paragraph(body, { size: compact ? 16 : 17.5, color: MUTED }),
  };
}

function intro(label, body, extra = "") {
  return {
    topic: paragraph(label, { size: 18, bold: true, color: GREEN, spaceAfter: 500 }),
    loremIpsumDolorSitAmetConsecteturAdipiscing: paragraph(body, { size: 19, color: BLACK, spaceAfter: extra ? 400 : 0 }),
    ...(extra ? { loremIpsumDolorSitAmetConsecteturAdipiscing2: paragraph(extra, { size: 17.5, color: MUTED }) } : {}),
  };
}

function bullets(lines) {
  return {
    detailGoesHere: paragraph(lines[0], { size: 17.5, color: MUTED, bullet: true, spaceAfter: 250 }),
    detailGoesHere2: paragraph(lines[1], { size: 17.5, color: MUTED, bullet: true, spaceAfter: 250 }),
    detailGoesHere3: paragraph(lines[2], { size: 17.5, color: MUTED, bullet: true }),
  };
}

function addNotes(slide, cue, sources) {
  slide.speakerNotes.textFrame.setText(
    `${cue}\n\n[Sources]\n${sources.map((source) => `- ${source}`).join("\n")}`,
  );
  slide.speakerNotes.setVisible(true);
}

function addFooter(tokens, page) {
  return { ...tokens, footer1: String(page) };
}

async function addLogo(slide) {
  const imagePath = `${ROOT}/public/assets/brand/logo-mark-white-bg.png`;
  const bytes = await fs.readFile(imagePath);
  const blob = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  slide.images.add({
    blob,
    contentType: "image/png",
    alt: "Free LLM Router logo",
    fit: "contain",
    position: { left: 1080, top: 28, width: 150, height: 150 },
  });
}

function buildDeck() {
  return Presentation.create({ slideSize: { width: 1280, height: 720 } });
}

async function main() {
  await fs.mkdir(RENDER_DIR, { recursive: true });
  await fs.mkdir(path.dirname(FINAL), { recursive: true });
  const deck = buildDeck();

  // 1 — Cover
  let slide = buildSlide02(deck, {
    title: paragraph("MVP PRESENTATION", { size: 24, bold: true, color: GREEN }),
    title2: paragraph("SELF-HOSTED AI GATEWAY", { size: 20, bold: true, color: MUTED }),
    title3: paragraph("Free LLM Router\nCloud reliability. Local privacy.", { size: 68, bold: true, color: BLACK }),
  });
  await addLogo(slide);
  addNotes(slide, "Open with the promise: applications should not have to choose permanently between cloud reach and local privacy.", ["README.md", "docs/MANUAL.md", "docs/CONNECT_LOCAL_LLM.md"]);

  // 2 — Problem / solution
  slide = buildSlide11(deck, addFooter({
    title: title("AI integration becomes fragile when every provider is a separate decision"),
    body1: intro("THE PROBLEM", "Provider-specific SDKs, changing model names, rate limits, outages, and private workloads all leak into application code.", "The result is duplicated integration work and failures that are difficult to explain."),
    body2: paragraph("Without a router", { size: 27, bold: true, color: BLACK }),
    body3: paragraph("With Free LLM Router", { size: 27, bold: true, color: GREEN }),
    body4: bullets(["One provider outage breaks the flow", "Local models require separate code", "Debugging stops at an error message"]),
    body5: bullets(["One stable API for every model", "Cloud and Ollama share one policy", "Every routing decision is traceable"]),
  }, 2));
  addNotes(slide, "Frame the router as infrastructure that removes provider decisions from product code. A startup can add or replace providers without redeploying its application.", ["README.md", "docs/MANUAL.md"]);

  // 3 — Product promise in three facts
  slide = buildSlide19(deck, addFooter({
    title: title("One endpoint replaces a stack of model-specific integrations"),
    body1: intro("THE MVP", "Bring cloud provider keys and a private Ollama machine into the same self-hosted gateway. Routing, reliability, testing, and observability live in one control plane."),
    stat1: paragraph("1", { size: 58, bold: true, color: GREEN }),
    stat2: paragraph("3", { size: 58, bold: true, color: GREEN }),
    stat3: paragraph("2", { size: 58, bold: true, color: GREEN }),
    body2: paragraph("stable gateway endpoint", { size: 21, bold: true }),
    body3: paragraph("API formats: Chat, Responses, Messages", { size: 19, bold: true }),
    body4: paragraph("provider classes: cloud + local", { size: 20, bold: true }),
  }, 3));
  addNotes(slide, "The counts are product capabilities, not market metrics: one gateway; three supported API compatibility surfaces; cloud and private local provider classes.", ["docs/MANUAL.md", "docs/CONNECT_LOCAL_LLM.md"]);

  // 4 — Explainable request flow
  slide = buildSlide17(deck, addFooter({
    title: title("Every request follows one explainable path"),
    label1: paragraph("REQUEST", { size: 18, bold: true, color: GREEN }),
    label2: paragraph("DECIDE", { size: 18, bold: true, color: GREEN }),
    label3: paragraph("RESPOND", { size: 18, bold: true, color: GREEN }),
    body1: pairHere("Application calls one API", "The client sends a virtual model alias through an OpenAI- or Anthropic-compatible endpoint."),
    body2: pairHere("Router filters and ranks", "Capabilities, health, quota, cooldowns, policy, and local preference determine eligibility."),
    body3: pairHere("Local or cloud model answers", "The selected model streams or returns output while the router records the complete decision."),
  }, 4));
  addNotes(slide, "Use this as the architecture slide. The key idea is that local Ollama looks like a provider to the routing engine but receives stricter ownership and authorization checks.", ["CONNECT_LOCAL_LLM_V1_ROADMAP.md", "docs/MANUAL.md"]);

  // 5 — Local connection
  slide = buildSlide18(deck, addFooter({
    title: title("A private Ollama node connects in three guarded steps"),
    body1: pairHere("Pair", "A one-time dashboard code becomes a CLI command. Ollama and installed models are detected automatically."),
    body2: pairHere("Protect", "A loopback-only agent exposes approved inference and health operations—not raw Ollama administration."),
    body3: pairHere("Operate", "Heartbeats, allowlists, limits, revoke, disconnect, and permanent deletion remain under the owner's control."),
    label1: paragraph("ONE COMMAND", { size: 18, bold: true, color: GREEN }),
    label2: paragraph("LOOPBACK ONLY", { size: 18, bold: true, color: GREEN }),
    label3: paragraph("LIVE CONTROL", { size: 18, bold: true, color: GREEN }),
  }, 5));
  addNotes(slide, "Example: a law office can summarize confidential drafts on its own workstation without publicly exposing Ollama. The agent accepts inference, not model deletion or installation commands.", ["docs/CONNECT_LOCAL_LLM.md", "CONNECT_LOCAL_LLM_V1_ROADMAP.md"]);

  // 6 — Local routing modes
  slide = buildSlide18(deck, addFooter({
    title: title("Local routing makes privacy a policy choice"),
    body1: pairHere("Normal order", "Local models participate beside cloud providers in the configured order."),
    body2: pairHere("Prefer local", "Healthy compatible Ollama models run first; cloud remains available before output begins."),
    body3: pairHere("Local only", "Cloud providers are excluded. If no eligible local model is online, the request fails clearly."),
    label1: paragraph("BALANCED", { size: 18, bold: true, color: GREEN }),
    label2: paragraph("LOWER COST", { size: 18, bold: true, color: GREEN }),
    label3: paragraph("STRICT PRIVACY", { size: 18, bold: true, color: GREEN }),
  }, 6));
  addNotes(slide, "Real cases: normal order for mixed workloads; prefer local for routine summaries that should be cheap; local only for HR, legal, or regulated prompts that must not leave the machine.", ["docs/CONNECT_LOCAL_LLM.md", "CONNECT_LOCAL_LLM_V1_ROADMAP.md"]);

  // 7 — Reliability
  const reliability = [
    ["Automatic failover", "Move to the next eligible provider before output starts."],
    ["Rate-limit cooldown", "Honor Retry-After and stop hammering a limited API."],
    ["Circuit breaker", "Temporarily remove repeatedly failing providers."],
    ["Retry deadlines", "Bound attempts, backoff, and total response time."],
    ["Model health", "Track the active model separately from provider health."],
    ["Quota protection", "Skip providers at daily or monthly request/token limits."],
    ["Deduplication", "Let identical callers share one provider operation."],
    ["Stream cancellation", "Release cloud or local compute when the client stops."],
  ];
  slide = buildSlide16(deck, addFooter({
    title: title("Reliability features keep one failure from becoming an outage"),
    ...Object.fromEntries(reliability.map(([h, b], i) => [`body${i + 1}`, pairHere(h, b, true)])),
  }, 7));
  addNotes(slide, "Example: Groq returns 429, enters cooldown, and OpenRouter answers instead. During a provider outage, the circuit breaker keeps every user request from waiting on the same failing service.", ["docs/MANUAL.md"]);

  // 8 — Model intelligence
  slide = buildSlide12(deck, addFooter({
    title: title("Models are routed by verified capabilities"),
    body1: intro("MODEL INTELLIGENCE", "The router evaluates the exact active provider-model pair—not merely whether a provider is connected."),
    body2: pair("Stable aliases", "Use coding-router or vision-router while the underlying model changes independently."),
    body3: pair("Capability filtering", "Tools, JSON, structured output, vision, reasoning, and streaming guide eligibility."),
    body4: pair("Model catalogs", "Save several provider models, test them, and explicitly activate one for production."),
    body5: pair("Runtime evidence", "Controlled probes and clear model rejections safely improve capability knowledge."),
  }, 8));
  addNotes(slide, "Example: an invoice request with an image skips text-only models. A new model can be probed for tools before it is trusted in an agent workflow.", ["docs/MANUAL.md"]);

  // 9 — Playground
  slide = buildSlide18(deck, addFooter({
    title: title("The Playground answers three different diagnostic questions"),
    body1: pairHere("Router request", "Did the complete alias, capability, ranking, quota, and fallback policy behave correctly?"),
    body2: pairHere("Provider + model", "Does this exact hosted provider key and model work independently of routing?"),
    body3: pairHere("Local LLM", "Does this exact online Ollama node and enabled model answer with the chosen generation settings?"),
    label1: paragraph("END-TO-END", { size: 18, bold: true, color: GREEN }),
    label2: paragraph("EXACT CLOUD", { size: 18, bold: true, color: GREEN }),
    label3: paragraph("EXACT LOCAL", { size: 18, bold: true, color: GREEN }),
  }, 9));
  addNotes(slide, "Example: when a routed request fails, direct tests isolate whether the cause is the provider key, exact model, local node, or routing policy. Temperature and token caps verify the real workload, not just hello world.", ["docs/MANUAL.md", "docs/CONNECT_LOCAL_LLM.md"]);

  // 10 — Observability
  slide = buildSlide12(deck, addFooter({
    title: title("Every request can explain itself"),
    body1: intro("OBSERVABILITY", "A successful answer is useful. A traceable answer is operable."),
    body2: pair("Request IDs", "Correlate client errors, upstream attempts, analytics, and returned headers."),
    body3: pair("Attempt timeline", "See rankings, skips, retries, cooldowns, circuit transitions, and final delivery."),
    body4: pair("Performance timing", "Separate router work, provider latency, retry delay, first token, and stream time."),
    body5: pair("Usage analytics", "Track providers, models, tokens, success, fallback, tools, clients, and latency."),
  }, 10));
  addNotes(slide, "Example: a customer reports a slow request and provides req_… The timeline shows that six seconds were spent waiting for the first provider before fallback succeeded.", ["docs/MANUAL.md"]);

  // 11 — Compatibility
  slide = buildSlide13(deck, addFooter({
    title: title("The same gateway fits existing developer workflows"),
    body1: pair("OpenAI clients", "Change the base URL and router key; keep Chat Completions-compatible application code."),
    body2: pair("Codex CLI", "Use the Responses-compatible gateway with function tools and streaming event conversion."),
    body3: pair("Claude Code", "Route Anthropic Messages, tool use, token counting, and SSE through the same provider pool."),
    body4: pair("Plain HTTP", "Integrate with cURL, fetch, Python requests, or any client that can call the gateway."),
  }, 11));
  addNotes(slide, "Example: a team can point an existing OpenAI SDK app and its coding assistants at one gateway instead of building separate provider integrations.", ["README.md", "docs/MANUAL.md"]);

  // 12 — Real-world value
  const cases = [
    ["Confidential documents", "A legal team uses local-only routing for sensitive drafts."],
    ["Provider outage", "A support assistant fails over before customers notice."],
    ["Free-tier pooling", "A student project spreads usage across limited quotas."],
    ["Changing models", "A startup swaps the active model without redeploying."],
    ["Limited local hardware", "Concurrency and queues keep a laptop responsive."],
    ["Vision workflow", "Capability filters send image prompts only to vision models."],
    ["Duplicate actions", "A double-click produces one upstream model operation."],
    ["Production debugging", "A request ID reveals the exact fallback timeline."],
  ];
  slide = buildSlide16(deck, addFooter({
    title: title("Real workflows make the MVP valuable"),
    ...Object.fromEntries(cases.map(([h, b], i) => [`body${i + 1}`, pairHere(h, b, true)])),
  }, 12));
  addNotes(slide, "Choose the examples that match the audience. The strongest contrast is confidential local-only processing versus cloud-backed continuity when privacy policy allows fallback.", ["docs/MANUAL.md", "docs/CONNECT_LOCAL_LLM.md"]);

  // 13 — Live demo
  slide = buildSlide17(deck, addFooter({
    title: title("A short live demo proves the entire product story"),
    label1: paragraph("LOCAL SUCCESS", { size: 18, bold: true, color: GREEN }),
    label2: paragraph("CONTROLLED FAILURE", { size: 18, bold: true, color: GREEN }),
    label3: paragraph("EXPLAIN THE RESULT", { size: 18, bold: true, color: GREEN }),
    body1: pairHere("Send one routed prompt", "Show the request reaching the connected Ollama model through the normal application endpoint."),
    body2: pairHere("Disconnect the node", "Repeat in prefer-local to demonstrate cloud fallback, then local-only to prove cloud exclusion."),
    body3: pairHere("Open Analysis", "Reveal the selected model, skipped candidates, fallback state, timing, headers, and request ID."),
  }, 13));
  addNotes(slide, "Presenter sequence: local success; disconnect; prefer-local cloud fallback; local-only explicit failure; then inspect the recorded timeline. This is an audience-facing demo flow, not a performance benchmark.", ["docs/CONNECT_LOCAL_LLM.md", "docs/MANUAL.md"]);

  // 14 — Scope
  slide = buildSlide12(deck, addFooter({
    title: title("V1 is intentionally focused—and clear about its boundaries"),
    body1: intro("SCOPE", "The MVP proves secure private inference inside a multi-provider router without pretending to be a full local-model management platform."),
    body2: pair("Included now", "Ollama, cloud + local routing, exact tests, node controls, lifecycle, and analytics."),
    body3: pair("Connection", "V1 uses a protected local agent and an ngrok HTTPS tunnel managed by the CLI."),
    body4: pair("Administration", "Remote model installation, deletion, copying, and pushing are intentionally unavailable."),
    body5: pair("Streaming", "Fallback is safe before first output; a later stream failure never mixes a second model into the answer."),
  }, 14));
  addNotes(slide, "State these boundaries confidently. They are safety and scope decisions: Ollama only in V1, a managed ngrok path, no remote model administration, and no mixing providers once a stream has started.", ["CONNECT_LOCAL_LLM_V1_ROADMAP.md", "docs/CONNECT_LOCAL_LLM.md"]);

  // 15 — Close
  slide = buildSlide26(deck, {
    title: paragraph("FREE LLM ROUTER", { size: 24, bold: true, color: GREEN }),
    title2: paragraph("One API.\nCloud reliability.\nLocal privacy.", { size: 66, bold: true, color: BLACK }),
    title3: {
      loremIpsumDetails: paragraph("Connect providers and Ollama", { size: 23, color: MUTED }),
      loremIpsumDetails2: paragraph("Choose the routing policy", { size: 23, color: MUTED }),
      loremIpsumDetails3: paragraph("Explain every request", { size: 23, color: MUTED }),
    },
  });
  addNotes(slide, "Close by restating the decision the product removes: teams no longer have to choose between local control and cloud resilience at integration time.", ["README.md", "docs/CONNECT_LOCAL_LLM.md"]);

  // 16–19 — Full capability appendix, one real-life use case per feature
  const appendixSlides = [
    {
      title: "Appendix A — Gateway and local access",
      items: [
        ["1 · One API", "Swap providers without changing application code."],
        ["2 · BYOK cloud", "Pool existing provider accounts and free quotas."],
        ["3 · Private Ollama", "Process sensitive drafts on the user's machine."],
        ["4 · One-command pairing", "Connect a workstation without manual networking."],
        ["5 · Protected agent", "Avoid publishing raw Ollama administration routes."],
        ["6 · Account ownership", "Keep each user's computers and models isolated."],
        ["7 · Model allowlist", "Expose stable models while hiding experiments."],
        ["8 · Node controls", "Keep a laptop responsive under routed traffic."],
      ],
      cue: "Each item combines an MVP feature with the moment it becomes valuable.",
      sources: ["README.md", "docs/CONNECT_LOCAL_LLM.md", "CONNECT_LOCAL_LLM_V1_ROADMAP.md"],
    },
    {
      title: "Appendix B — Routing and model intelligence",
      items: [
        ["9 · Local modes", "Choose balanced, local-first, or local-only behavior."],
        ["10 · Failover", "Survive a provider error before output begins."],
        ["11 · Local-cloud fallback", "Continue when a permitted workstation is asleep."],
        ["12 · Six strategies", "Optimize for priority, speed, spread, or reliability."],
        ["13 · Model aliases", "Replace production models without redeploying clients."],
        ["14 · Capability routing", "Send image prompts only to vision-capable models."],
        ["15 · Capability probes", "Verify a new model before agent traffic uses it."],
        ["16 · Model catalogs", "Test a replacement before activating it."],
      ],
      cue: "These features turn the router from a proxy into a policy and model-intelligence layer.",
      sources: ["docs/MANUAL.md", "docs/CONNECT_LOCAL_LLM.md"],
    },
    {
      title: "Appendix C — Testing + reliability",
      items: [
        ["17 · Three test modes", "Separate routing faults from exact-model faults."],
        ["18 · Generation controls", "Validate short deterministic JSON output."],
        ["19 · Cooldowns", "Stop wasting calls on a rate-limited free API."],
        ["20 · Circuit breakers", "Remove an outage from the hot request path."],
        ["21 · Quota protection", "Preserve daily requests for important traffic."],
        ["22 · Retry deadlines", "Meet a chat application's response-time budget."],
        ["23 · Deduplication", "Turn a double-click into one billed operation."],
        ["24 · Stream cancellation", "Release a GPU when the user presses stop."],
      ],
      cue: "The real benefit is controlled degradation: failures become bounded and diagnosable.",
      sources: ["docs/MANUAL.md", "docs/CONNECT_LOCAL_LLM.md"],
    },
    {
      title: "Appendix D — Operations, security and integration",
      items: [
        ["25 · Analytics", "Discover that traffic favors the slowest provider."],
        ["26 · Attempt timeline", "See where fallback added six seconds."],
        ["27 · Performance timing", "Distinguish first-token delay from stream speed."],
        ["28 · Request IDs", "Trace a customer's exact failed operation."],
        ["29 · Auth isolation", "Safely host several developers on one instance."],
        ["30 · Encrypted keys", "Protect saved cloud credentials at rest."],
        ["31 · Node lifecycle", "Revoke and remove an employee's retired computer."],
        ["32 · Integration snippets", "Connect an existing SDK by changing two values."],
      ],
      cue: "These operational capabilities make the MVP presentable as usable infrastructure rather than a routing experiment.",
      sources: ["README.md", "docs/MANUAL.md", "docs/CONNECT_LOCAL_LLM.md"],
    },
  ];

  for (let i = 0; i < appendixSlides.length; i += 1) {
    const item = appendixSlides[i];
    slide = buildSlide16(deck, addFooter({
      title: title(item.title),
      ...Object.fromEntries(item.items.map(([h, b], idx) => [`body${idx + 1}`, pairHere(h, b, true)])),
    }, 16 + i));
    addNotes(slide, item.cue, item.sources);
  }

  for (let i = 0; i < deck.slides.items.length; i += 1) {
    const current = deck.slides.items[i];
    const stem = `slide-${String(i + 1).padStart(2, "0")}`;
    const png = await deck.export({ slide: current, format: "png", scale: 1 });
    await fs.writeFile(`${RENDER_DIR}/${stem}.png`, new Uint8Array(await png.arrayBuffer()));
    const layout = await current.export({ format: "layout" });
    await fs.writeFile(`${RENDER_DIR}/${stem}.layout.json`, await layout.text(), "utf8");
  }

  const montage = await deck.export({ format: "webp", montage: true, scale: 1 });
  await fs.writeFile(`${TMP}/deck-montage.webp`, new Uint8Array(await montage.arrayBuffer()));
  const pptx = await PresentationFile.exportPptx(deck);
  await pptx.save(FINAL);
  console.log(`Created ${FINAL}`);
  console.log(`Slides ${deck.slides.items.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
