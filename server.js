import http from "node:http";
import { readFileSync, existsSync } from "node:fs";

const PORT = Number(process.env.PORT || 3000);
const HOST = "127.0.0.1";

function loadEnv() {
  if (!existsSync(".env")) return {};
  const lines = readFileSync(".env", "utf8").split(/\r?\n/);
  const env = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    env[key] = value;
    if (!(key in process.env)) process.env[key] = value;
  }
  return env;
}

const env = loadEnv();

function secretState(key) {
  return env[key] ? "configured" : "missing";
}

async function callBand(action, payload) {
  if (!env.BAND_API_KEY) {
    return { ok: false, mode: "local", reason: "BAND_API_KEY missing" };
  }

  const baseUrl = (env.BAND_BASE_URL || "https://app.band.ai").replace(/\/$/, "");
  let url = `${baseUrl}/api/v1/agent/chats/${payload.bandChatId || env.BAND_ROOM_ID}/events`;
  let body = {
    event: {
      content: payload.content || `${action}: ${JSON.stringify(payload)}`,
      message_type: "thought",
      metadata: {
        action,
        futureboard_room_id: payload.roomId,
        ...payload
      }
    }
  };

  if (action === "createRoom") {
    url = `${baseUrl}/api/v1/agent/chats`;
    body = { chat: {} };
  }

  if (action === "remember") {
    url = `${baseUrl}/api/v1/agent/memories`;
    body = {
      memory: {
        content: payload.record,
        segment: "user",
        system: "sensory",
        thought: "FutureBoard decision memory from multi-agent Band workflow",
        type: "iconic",
        metadata: {
          futureboard_room_id: payload.roomId,
          band_chat_id: payload.bandChatId
        }
      }
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "X-API-Key": env.BAND_API_KEY
      },
      body: JSON.stringify(body)
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return { ok: false, mode: "external-failed", reason: `HTTP ${response.status}` };
    }

    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }

    return { ok: true, mode: "external", data };
  } catch (error) {
    return { ok: false, mode: "external-failed", reason: error.name === "AbortError" ? "timeout" : error.message };
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

class BandRoom {
  constructor(decision) {
    this.id = `band-${decision.company.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now().toString().slice(-5)}`;
    this.decision = decision;
    this.state = {
      assumptions: [],
      agentOutputs: {},
      disagreementIndex: 0,
      escalations: [],
      handoffs: [],
      memory: [],
      transcript: []
    };
    this.events = [`[Band] Decision room ${this.id} created`];
    this.bandMode = env.BAND_API_KEY ? "external-pending" : "local adapter";
    this.bandAttempts = [];
    this.externalBandDisabled = false;
    this.bandChatId = env.BAND_ROOM_ID || null;
    this.message("Band", "System", `Decision room created for ${decision.company}. Shared state is open.`);
  }

  async sync(action, payload) {
    if (this.externalBandDisabled) {
      this.bandAttempts.push({ action, ok: false, mode: "local", reason: "external Band disabled after first failure" });
      this.bandMode = "external Band API failed; local adapter active";
      return { ok: false, mode: "local", reason: "external Band disabled after first failure" };
    }
    const result = await callBand(action, { roomId: this.id, bandChatId: this.bandChatId, ...payload });
    this.bandAttempts.push({ action, ok: result.ok, mode: result.mode, reason: result.reason });
    if (result.ok) {
      if (action === "createRoom" && result.data?.data?.id) {
        this.bandChatId = result.data.data.id;
      }
      this.bandMode = "external Band API connected";
      this.events.push(`[Band API] ${action} synced to external Band`);
    } else if (result.mode === "external-failed") {
      this.externalBandDisabled = true;
      this.bandMode = "external Band API failed; local adapter active";
      this.events.push(`[Band API] ${action} failed (${result.reason}); local BandRoom continued`);
    } else {
      this.bandMode = "local adapter";
    }
    return result;
  }

  async init() {
    await this.sync("createRoom", { decision: this.decision });
  }

  async publish(agent, payload) {
    this.state.agentOutputs[agent] = payload;
    this.events.push(`[Band] ${agent} published structured context`);
    this.message(agent, "Band shared state", Object.values(payload).join(" "));
    await this.sync("publish", { agent, payload });
  }

  async handoff(from, to, context) {
    this.state.handoffs.push({ from, to, context });
    this.events.push(`[Band] ${from} handed context to ${to}: ${context}`);
    this.message("Band", `${from} -> ${to}`, context);
    await this.sync("handoff", { from, to, context });
  }

  async disagree(agent, reason, severity) {
    this.state.disagreementIndex = clamp(this.state.disagreementIndex + severity, 0, 100);
    this.state.assumptions.push({ agent, reason, severity });
    this.events.push(`[Band] ${agent} challenged assumption: ${reason}`);
    this.message(agent, "Disagreement", `${reason}. Severity +${severity}. Current disagreement index: ${this.state.disagreementIndex}%.`);
    await this.sync("disagree", { agent, reason, severity, disagreementIndex: this.state.disagreementIndex });
  }

  async escalate(agent, reason) {
    this.state.escalations.push({ agent, reason });
    this.events.push(`[Band] ${agent} opened escalation: ${reason}`);
    this.message(agent, "Escalation", reason);
    await this.sync("escalate", { agent, reason });
  }

  async remember(record) {
    this.state.memory.push(record);
    this.events.push("[Band] Decision memory stored");
    this.message("Memory Agent", "Decision memory", record);
    await this.sync("remember", { record });
  }

  message(agent, channel, content) {
    this.state.transcript.push({
      agent,
      channel,
      content,
      time: new Date().toLocaleTimeString("en-US", { hour12: false })
    });
  }
}

async function callOpenAICompatible({ apiKey, baseUrl, model, system, prompt }) {
  if (!apiKey || !baseUrl || !model) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt }
        ],
        temperature: 0.35,
        max_tokens: 220
      })
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const json = await response.json();
    return json?.choices?.[0]?.message?.content || null;
  } catch {
    return null;
  }
}

async function agentReasoning(agent, decision, fallback) {
  const prompt = `Decision: ${decision.company} may replace ${decision.replacementPercent}% of support with AI in ${decision.horizonDays} days to save $${decision.savingsGoal}M/year. VIP customers: ${decision.vipCustomers}. Churn: ${decision.churn}%. Risk tolerance: ${decision.riskTolerance}. Return one concise executive insight.`;

  if (["Strategy", "Finance", "Customer", "Negotiator"].includes(agent)) {
    const groqKey = env.groq_API_KEY || env.GROQ_API_KEY || env.AIML_API_KEY;
    const groqBase = env.GROQ_BASE_URL || env.AIML_BASE_URL || "https://api.groq.com/openai/v1";
    const groqModel = env.GROQ_MODEL || env.AIML_MODEL || "llama-3.1-8b-instant";
    const result = await callOpenAICompatible({
      apiKey: groqKey,
      baseUrl: groqBase,
      model: groqModel,
      system: `You are the ${agent} Agent in FutureBoard. Be specific and decision-oriented.`,
      prompt
    });
    if (result) return { text: result, provider: groqKey === env.AIML_API_KEY ? "AI/ML API" : "Groq/OpenAI-compatible" };
  }

  if (["Employee", "Competitor", "Red-Team"].includes(agent)) {
    const result = await callOpenAICompatible({
      apiKey: env.FEATHERLESS_API_KEY,
      baseUrl: env.FEATHERLESS_BASE_URL || "https://api.featherless.ai/v1",
      model: env.FEATHERLESS_MODEL,
      system: `You are the ${agent} specialist Agent in FutureBoard. Stress-test the decision.`,
      prompt
    });
    if (result) return { text: result, provider: "Featherless AI" };
  }

  return { text: fallback, provider: "Local simulation" };
}

async function runDecision(decision) {
  const room = new BandRoom(decision);
  await room.init();
  const replacementRisk = clamp(decision.replacementPercent * 1.25, 12, 55);
  const speedRisk = clamp((120 - decision.horizonDays) / 3, 0, 28);
  const vipRisk = clamp(decision.vipCustomers / 18, 4, 24);
  const toleranceOffset = decision.riskTolerance === "low" ? 12 : decision.riskTolerance === "high" ? -8 : 0;
  const originalRisk = clamp(Math.round(28 + replacementRisk + speedRisk + vipRisk + toleranceOffset), 34, 96);
  const negotiatedAutomation = clamp(Math.round(decision.replacementPercent * 0.62), 8, decision.replacementPercent);
  const negotiatedRisk = clamp(Math.round(originalRisk * 0.5), 18, 58);

  const strategy = await agentReasoning("Strategy", decision, `${decision.company} should treat the move as a reversible staged automation program, not a one-shot workforce replacement.`);
  await room.publish("Strategy Agent", { successCriteria: strategy.text });
  await room.handoff("Strategy Agent", "Finance Agent", "success criteria and risk tolerance");

  const finance = await agentReasoning("Finance", decision, `$${decision.savingsGoal}M savings is possible, but only if churn and escalation costs stay near baseline.`);
  await room.publish("Finance Agent", { savingsModel: finance.text });
  await room.handoff("Finance Agent", "Customer Agent", "savings model and churn sensitivity");

  const customer = await agentReasoning("Customer", decision, `${decision.vipCustomers} VIP customers make AI-first support risky unless premium human escalation is preserved.`);
  await room.publish("Customer Agent", { churnRisk: customer.text });
  await room.disagree("Customer Agent", "finance model underprices trust damage", Math.round(vipRisk));
  await room.handoff("Customer Agent", "Employee Agent", "customer trust risk and escalation pressure");

  const employee = await agentReasoning("Employee", decision, "Support specialists should be redeployed into AI QA, escalation, and knowledge operations to reduce attrition.");
  await room.publish("Employee Agent", { moraleRisk: employee.text });
  await room.disagree("Employee Agent", "rapid replacement creates internal resistance", Math.round(replacementRisk / 2));
  await room.handoff("Employee Agent", "Operations Agent", "redeployment needs, morale risk, and training capacity");

  await room.publish("Operations Agent", {
    rolloutPlan: `${decision.horizonDays}-day rollout requires pilot queues, fallback staffing, QA scorecards, and escalation latency monitoring.`
  });
  await room.handoff("Operations Agent", "Red-Team Agent", "rollout plan and operational constraints");

  const redTeam = await agentReasoning("Red-Team", decision, "The plan fails if AI deflection is optimized before escalation quality and customer trust are proven.");
  await room.publish("Red-Team Agent", { failureMode: redTeam.text });
  await room.disagree("Red-Team Agent", "hidden failure path detected", Math.round(speedRisk + 12));
  await room.handoff("Red-Team Agent", "Competitor Agent", "public failure paths and brand-positioning exposure");

  const competitor = await agentReasoning("Competitor", decision, "Competitors will position against AcmeCorp if premium human support appears weakened.");
  await room.publish("Competitor Agent", { marketResponse: competitor.text });

  if (room.state.disagreementIndex >= 35) {
    await room.escalate("Legal Risk Agent", "VIP and regulated support workflows need human-in-loop controls");
  }

  await room.handoff("Legal Risk Agent", "Negotiator Agent", "escalation constraints, failure paths, disagreements, and market response");
  const negotiator = await agentReasoning("Negotiator", decision, `Automate ${negotiatedAutomation}% first, protect VIP accounts, redeploy staff, and review at 30/60/90 days.`);
  await room.publish("Negotiator Agent", { negotiatedPlan: negotiator.text });

  const memory = [
    `Original risk: ${originalRisk}%. Negotiated risk: ${negotiatedRisk}%.`,
    `Band tracked ${room.state.handoffs.length} handoffs, ${room.state.assumptions.length} disagreements, and ${room.state.escalations.length} escalations.`,
    `Final plan: automate ${negotiatedAutomation}% first, protect VIP/regulated accounts, redeploy staff, then review outcomes.`
  ];
  await room.remember(memory.join(" "));

  return {
    providers: {
      band: room.bandMode,
      groq: secretState("groq_API_KEY") === "configured" || secretState("GROQ_API_KEY") === "configured" ? "configured" : "missing",
      aiml: secretState("AIML_API_KEY"),
      featherless: secretState("FEATHERLESS_API_KEY")
    },
    roomId: room.id,
    bandMode: room.bandMode,
    bandAttempts: room.bandAttempts,
    events: room.events,
    disagreementIndex: room.state.disagreementIndex,
    handoffs: room.state.handoffs,
    escalations: room.state.escalations,
    assumptions: room.state.assumptions,
    transcript: room.state.transcript,
    agents: [
      { name: "Strategy", provider: strategy.provider, output: strategy.text },
      { name: "Finance", provider: finance.provider, output: finance.text },
      { name: "Customer", provider: customer.provider, output: customer.text },
      { name: "Employee", provider: employee.provider, output: employee.text },
      { name: "Red-Team", provider: redTeam.provider, output: redTeam.text },
      { name: "Competitor", provider: competitor.provider, output: competitor.text },
      { name: "Negotiator", provider: negotiator.provider, output: negotiator.text }
    ],
    predictions: [
      { label: "Original plan risk", value: originalRisk },
      { label: "Negotiated plan risk", value: negotiatedRisk },
      { label: "Savings preserved", value: clamp(Math.round((negotiatedAutomation / decision.replacementPercent) * 100 + 22), 45, 92) },
      { label: "VIP trust retained", value: clamp(100 - Math.round(vipRisk + speedRisk * 0.4), 52, 91) }
    ],
    originalPlan: [
      `Replace ${decision.replacementPercent}% of support capacity within ${decision.horizonDays} days.`,
      `Target $${decision.savingsGoal}M annual savings before proving customer trust thresholds.`,
      `Risk exposing ${decision.vipCustomers} VIP customers to AI-first support leakage.`
    ],
    negotiatedPlan: [
      `Automate ${negotiatedAutomation}% of repeat tier-1 volume after quality gates.`,
      "Protect VIP and regulated accounts with human-in-loop routing.",
      "Redeploy senior support staff into AI QA, escalation, and knowledge operations.",
      "Store decision memory and review churn, CSAT, savings, and attrition at 30/60/90 days."
    ],
    memory
  };
}

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FutureBoard: Enterprise Decision Immune System</title>
  <style>
    :root{--bg:#080B12;--panel:#111827;--line:#1E293B;--blue:#38BDF8;--red:#EF4444;--amber:#F59E0B;--green:#22C55E;--text:#F8FAFC;--muted:#94A3B8}
    *{box-sizing:border-box} body{margin:0;background:radial-gradient(circle at 50% 0,rgba(56,189,248,.18),transparent 34rem),var(--bg);color:var(--text);font-family:Inter,system-ui,sans-serif}
    main{max-width:1200px;margin:0 auto;padding:28px 20px 60px}.top{display:flex;justify-content:space-between;border-bottom:1px solid rgba(56,189,248,.25);padding-bottom:16px;color:var(--muted);font-size:12px;letter-spacing:.22em;text-transform:uppercase}
    h1{font-size:clamp(42px,7vw,82px);line-height:.95;margin:54px 0 18px;max-width:920px}.tag{color:var(--muted);font-size:20px;line-height:1.65;max-width:760px}.badge{display:inline-block;border:1px solid rgba(56,189,248,.4);background:rgba(56,189,248,.1);color:var(--blue);padding:10px 12px;margin-top:42px;font-size:12px;letter-spacing:.18em;text-transform:uppercase}
    section{margin-top:42px}.grid{display:grid;gap:16px}.controls{grid-template-columns:repeat(4,1fr);border:1px solid rgba(56,189,248,.3);background:rgba(17,24,39,.85);padding:18px}.cards{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}.warroom{grid-template-columns:1.15fr .85fr;align-items:start}
    label span{display:block;color:var(--muted);font-size:11px;letter-spacing:.16em;text-transform:uppercase;margin-bottom:8px} input,select{width:100%;background:var(--bg);border:1px solid var(--line);color:var(--text);padding:11px;font:inherit} button{background:var(--blue);color:var(--bg);border:0;padding:12px 18px;font-weight:800;cursor:pointer}button:disabled{opacity:.6;cursor:wait}
    .panel{border:1px solid var(--line);background:rgba(17,24,39,.86);padding:18px}.panel.blue{border-color:rgba(56,189,248,.45)}.panel.red{border-color:rgba(239,68,68,.45);background:rgba(239,68,68,.08)}.panel.green{border-color:rgba(34,197,94,.45);background:rgba(34,197,94,.08)}
    h2{font-size:32px;margin:0 0 10px}.muted{color:var(--muted)}.event{border:1px solid var(--line);padding:12px;margin-top:10px;color:#c7e9ff}.agent strong{color:var(--blue)}.meter{height:12px;background:var(--line);margin-top:8px}.bar{height:100%;background:var(--blue);transition:width .6s ease}.risk .bar{background:var(--red)}.safe .bar{background:var(--green)}ul{padding-left:20px;line-height:1.7}.provider{font-size:12px;color:var(--amber);margin-top:8px}
    .room-header{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:14px}.room-id{color:var(--blue);font-size:12px;letter-spacing:.12em;text-transform:uppercase}.chat{max-height:620px;overflow:auto;padding-right:8px}.msg{border:1px solid var(--line);background:rgba(8,11,18,.72);padding:14px;margin:10px 0}.msg.band{border-color:rgba(56,189,248,.55);background:rgba(56,189,248,.08)}.msg.red{border-color:rgba(239,68,68,.4);background:rgba(239,68,68,.08)}.msg.green{border-color:rgba(34,197,94,.4);background:rgba(34,197,94,.08)}.msg-top{display:flex;justify-content:space-between;gap:10px;margin-bottom:8px}.agent-name{font-weight:800}.channel{color:var(--amber);font-size:12px}.time{color:var(--muted);font-size:12px}.proof{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.proof div{border:1px solid var(--line);padding:12px;background:rgba(8,11,18,.64)}.proof strong{display:block;color:var(--blue);font-size:24px}.pill{display:inline-block;border:1px solid rgba(56,189,248,.35);padding:5px 8px;margin:4px;color:#c7e9ff;font-size:12px}
    @media(max-width:900px){.controls,.warroom{grid-template-columns:1fr}.top{display:block}.top span{display:block;margin-bottom:8px}h1{font-size:42px}.proof{grid-template-columns:1fr}}
  </style>
</head>
<body>
<main>
  <div class="top"><span>FutureBoard Command Layer</span><span>Band Multi-Agent Room: Real Execution Demo</span></div>
  <div class="badge">Enterprise Decision Immune System</div>
  <h1>Companies have dashboards for the past. FutureBoard gives them an immune system for the future.</h1>
  <p class="tag">Run a real multi-agent workflow: Band coordinates shared state, handoffs, disagreement, escalation, negotiation, and memory. Provider agents use your .env keys when available.</p>

  <section class="grid controls">
    <label><span>Company</span><input id="company" value="AcmeCorp"></label>
    <label><span>Replace support %</span><input id="replacementPercent" type="number" value="30"></label>
    <label><span>Horizon days</span><input id="horizonDays" type="number" value="90"></label>
    <label><span>Savings goal $M</span><input id="savingsGoal" type="number" value="12"></label>
    <label><span>VIP customers</span><input id="vipCustomers" type="number" value="300"></label>
    <label><span>Current churn %</span><input id="churn" type="number" value="8"></label>
    <label><span>Risk tolerance</span><select id="riskTolerance"><option>medium</option><option>low</option><option>high</option></select></label>
    <button id="run">Run Band Immune Response</button>
  </section>

  <section class="grid cards" id="providers"></section>
  <section class="grid cards" id="predictions"></section>

  <section class="grid warroom">
    <div class="panel blue">
      <div class="room-header"><h2>Live Band Chat Room</h2><div id="roomId" class="room-id">Waiting for room</div></div>
      <div id="transcript" class="chat muted">Run the workflow to create a multi-agent room.</div>
    </div>
    <div class="panel blue">
      <h2>Band Proof</h2>
      <div id="proof" class="proof"></div>
      <h2 style="margin-top:22px">Handoffs</h2>
      <div id="handoffs" class="muted"></div>
      <h2 style="margin-top:22px">Agent Outputs</h2>
      <div id="agents" class="muted">Agents will publish structured context here.</div>
    </div>
  </section>

  <section class="panel blue"><h2>Band Event Bus</h2><div id="events" class="muted">Waiting for execution.</div></section>

  <section class="grid cards">
    <div class="panel red"><h2>Original Plan</h2><ul id="original"></ul></div>
    <div class="panel green"><h2>Negotiated Plan</h2><ul id="negotiated"></ul></div>
  </section>

  <section class="panel"><h2>Decision Memory</h2><ul id="memory"></ul></section>
  <section class="panel blue">
    <h2>Why This Meets The Band Challenge</h2>
    <p class="muted">Minimum requirement is at least 3 agents collaborating through Band. FutureBoard runs 7 agents through a BandRoom coordination layer. Band is not a final notification channel: it owns room state, handoffs, disagreement tracking, escalation triggers, negotiation context, transcript, and memory.</p>
    <div>
      <span class="pill">Strategy -> Finance</span>
      <span class="pill">Finance -> Customer</span>
      <span class="pill">Customer -> Employee</span>
      <span class="pill">Employee -> Operations</span>
      <span class="pill">Operations -> Red-Team</span>
      <span class="pill">Legal Risk -> Negotiator</span>
      <span class="pill">Negotiator -> Memory</span>
    </div>
  </section>
</main>
<script>
const fields = ["company","replacementPercent","horizonDays","savingsGoal","vipCustomers","churn","riskTolerance"];
function decision(){
  const data = {};
  for (const id of fields) {
    const value = document.getElementById(id).value;
    data[id] = id === "company" || id === "riskTolerance" ? value : Number(value);
  }
  return data;
}
function esc(value){
  return String(value ?? "").replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
}
function list(target, items){ document.getElementById(target).innerHTML = items.map(i => "<li>"+esc(i)+"</li>").join(""); }
function msgClass(message){
  if (message.agent === "Band") return "band";
  if (message.channel === "Disagreement" || message.channel === "Escalation") return "red";
  if (message.agent === "Memory Agent" || message.agent === "Negotiator Agent") return "green";
  return "";
}
function render(result){
  document.getElementById("roomId").textContent = result.roomId;
  document.getElementById("providers").innerHTML = Object.entries(result.providers).map(([k,v]) => '<div class="panel"><strong>'+esc(k.toUpperCase())+'</strong><div class="provider">'+esc(v)+'</div></div>').join("");
  document.getElementById("predictions").innerHTML = result.predictions.map((p,i) => '<div class="panel '+(i===0?'red':i===1?'green':'')+'"><strong>'+esc(p.label)+': '+p.value+'%</strong><div class="meter '+(i===0?'risk':i===1?'safe':'')+'"><div class="bar" style="width:'+p.value+'%"></div></div></div>').join("");
  document.getElementById("events").innerHTML = result.events.map(e => '<div class="event">'+esc(e)+'</div>').join("");
  document.getElementById("proof").innerHTML = [
    ["Agents", result.agents.length],
    ["Handoffs", result.handoffs.length],
    ["Disagreement", result.disagreementIndex + "%"]
  ].map(([label,value]) => '<div><strong>'+esc(value)+'</strong><span class="muted">'+esc(label)+'</span></div>').join("");
  document.getElementById("handoffs").innerHTML = result.handoffs.map(h => '<span class="pill">'+esc(h.from)+' -> '+esc(h.to)+'</span>').join("");
  document.getElementById("transcript").innerHTML = result.transcript.map(m => '<div class="msg '+msgClass(m)+'"><div class="msg-top"><div><span class="agent-name">'+esc(m.agent)+'</span><div class="channel">'+esc(m.channel)+'</div></div><span class="time">'+esc(m.time)+'</span></div><div>'+esc(m.content)+'</div></div>').join("");
  document.getElementById("agents").innerHTML = result.agents.map(a => '<div class="event agent"><strong>'+esc(a.name)+'</strong><div class="provider">'+esc(a.provider)+'</div><div>'+esc(a.output)+'</div></div>').join("");
  list("original", result.originalPlan); list("negotiated", result.negotiatedPlan); list("memory", result.memory);
}
async function run(){
  const btn = document.getElementById("run");
  btn.disabled = true; btn.textContent = "Running agents through Band...";
  const res = await fetch("/api/run-decision", { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(decision()) });
  render(await res.json());
  btn.disabled = false; btn.textContent = "Run Band Immune Response";
}
document.getElementById("run").addEventListener("click", run);
run();
</script>
</body>
</html>`;

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function handleRequest(request, response) {
  if (request.method === "GET") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }

  if (request.method === "POST" && (request.url === "/api/run-decision" || request.url === "/api" || request.url === "/api/")) {
    try {
      const input = await readJson(request);
      const result = await runDecision({
        company: input.company || "AcmeCorp",
        replacementPercent: Number(input.replacementPercent || 30),
        horizonDays: Number(input.horizonDays || 90),
        savingsGoal: Number(input.savingsGoal || 12),
        vipCustomers: Number(input.vipCustomers || 300),
        churn: Number(input.churn || 8),
        riskTolerance: input.riskTolerance || "medium"
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Decision run failed" }));
    }
    return;
  }

  response.writeHead(404, { "content-type": "text/plain" });
  response.end("Not found");
}

if (!process.env.VERCEL) {
  const server = http.createServer(handleRequest);
  server.listen(PORT, HOST, () => {
    console.log(`FutureBoard running at http://${HOST}:${PORT}`);
  });
}

export default handleRequest;
