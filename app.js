/* =========================================================================
   Ridgeline — Deriv Trading Bot
   Vanilla JS client for the Deriv WebSocket API (https://api.deriv.com).
   No build step, no dependencies. Everything runs client-side; your API
   token is only ever sent to Deriv's own WebSocket endpoint.
   ========================================================================= */

const WS_HOST = "wss://ws.derivws.com/websockets/v3";
const LS_APPID = "ridgeline_app_id";
const LS_TOKEN = "ridgeline_token";

/* ---------------------------------------------------------------------- */
/* Thin WebSocket client with request/response correlation via req_id    */
/* ---------------------------------------------------------------------- */

class DerivClient {
  constructor() {
    this.ws = null;
    this.reqId = 1;
    this.pending = new Map();
    this.listeners = { tick: [], contract: [], open: [], close: [], error: [] };
  }

  on(event, fn) {
    this.listeners[event]?.push(fn);
  }

  emit(event, payload) {
    this.listeners[event]?.forEach((fn) => fn(payload));
  }

  connect(appId) {
    return new Promise((resolve, reject) => {
      const url = `${WS_HOST}?app_id=${encodeURIComponent(appId)}`;
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.emit("open");
        resolve();
      };

      this.ws.onerror = (err) => {
        this.emit("error", err);
        reject(err);
      };

      this.ws.onclose = () => this.emit("close");

      this.ws.onmessage = (msg) => {
        let data;
        try {
          data = JSON.parse(msg.data);
        } catch {
          return;
        }

        if (data.msg_type === "tick") {
          this.emit("tick", data.tick);
        }
        if (data.msg_type === "proposal_open_contract") {
          this.emit("contract", data.proposal_open_contract);
        }

        if (data.req_id && this.pending.has(data.req_id)) {
          const { resolve: res, reject: rej } = this.pending.get(data.req_id);
          this.pending.delete(data.req_id);
          if (data.error) rej(data.error);
          else res(data);
        }
      };
    });
  }

  send(payload) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject({ message: "Not connected" });
        return;
      }
      const req_id = this.reqId++;
      this.pending.set(req_id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...payload, req_id }));

      // Safety timeout so a dropped request doesn't hang the UI forever.
      setTimeout(() => {
        if (this.pending.has(req_id)) {
          this.pending.delete(req_id);
          reject({ message: "Request timed out" });
        }
      }, 15000);
    });
  }

  authorize(token) {
    return this.send({ authorize: token });
  }

  subscribeTicks(symbol) {
    return this.send({ ticks: symbol, subscribe: 1 });
  }

  async forgetAll(type) {
    try {
      await this.send({ forget_all: type });
    } catch {
      /* non-fatal */
    }
  }

  getProposal({ symbol, contractType, stake, duration, durationUnit }) {
    return this.send({
      proposal: 1,
      amount: stake,
      basis: "stake",
      contract_type: contractType,
      currency: "USD",
      duration,
      duration_unit: durationUnit,
      symbol,
    });
  }

  buy(proposalId, price) {
    return this.send({ buy: proposalId, price });
  }

  subscribeContract(contractId) {
    return this.send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
  }

  balance() {
    return this.send({ balance: 1, subscribe: 1 });
  }
}

/* ---------------------------------------------------------------------- */
/* Strategy engine — decides direction for the next auto-trade            */
/* ---------------------------------------------------------------------- */

const Strategy = {
  // Simply flips direction after every completed trade.
  alternate(state) {
    state.lastDirection = state.lastDirection === "CALL" ? "PUT" : "CALL";
    return state.lastDirection;
  },

  // Trades in the direction of the moving average slope over N ticks.
  trend(state, ticks, lookback) {
    const window = ticks.slice(-lookback);
    if (window.length < lookback) return null;
    const avgFirstHalf = average(window.slice(0, Math.floor(lookback / 2)));
    const avgSecondHalf = average(window.slice(Math.floor(lookback / 2)));
    return avgSecondHalf >= avgFirstHalf ? "CALL" : "PUT";
  },

  // Fades a run of N same-direction ticks, betting on reversion.
  counterStreak(state, ticks, streakLen) {
    if (ticks.length < streakLen + 1) return null;
    const recent = ticks.slice(-(streakLen + 1));
    let up = true, down = true;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i] <= recent[i - 1]) up = false;
      if (recent[i] >= recent[i - 1]) down = false;
    }
    if (up) return "PUT";
    if (down) return "CALL";
    return null;
  },
};

function average(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/* ---------------------------------------------------------------------- */
/* Application state                                                      */
/* ---------------------------------------------------------------------- */

const client = new DerivClient();

const app = {
  connected: false,
  authorized: false,
  currency: "USD",
  balance: null,
  startingBalance: null,
  ticks: [],
  currentSymbol: null,
  autoRunning: false,
  autoStep: 0,       // martingale step counter
  currentStake: 0,
  trades: 0,
  wins: 0,
  sessionPL: 0,
  lastDirection: "CALL",
};

/* ---------------------------------------------------------------------- */
/* DOM references                                                         */
/* ---------------------------------------------------------------------- */

const el = (id) => document.getElementById(id);

const dom = {
  appIdInput: el("appIdInput"),
  tokenInput: el("tokenInput"),
  rememberToken: el("rememberToken"),
  connectBtn: el("connectBtn"),
  connDot: el("connDot"),
  connLabel: el("connLabel"),
  accountBadge: el("accountBadge"),

  strategyBlock: el("strategyBlock"),
  autoBlock: el("autoBlock"),

  symbolSelect: el("symbolSelect"),
  contractTypeSelect: el("contractTypeSelect"),
  durationInput: el("durationInput"),
  durationUnitSelect: el("durationUnitSelect"),
  stakeInput: el("stakeInput"),

  strategySelect: el("strategySelect"),
  lookbackInput: el("lookbackInput"),
  mmModeSelect: el("mmModeSelect"),
  multiplierInput: el("multiplierInput"),
  maxStepsInput: el("maxStepsInput"),
  tpInput: el("tpInput"),
  slInput: el("slInput"),

  balanceStat: el("balanceStat"),
  plStat: el("plStat"),
  tradesStat: el("tradesStat"),
  winrateStat: el("winrateStat"),

  tickerSymbolLabel: el("tickerSymbolLabel"),
  tickerPrice: el("tickerPrice"),
  tickChart: el("tickChart"),
  lastDigits: el("lastDigits"),

  buyRiseBtn: el("buyRiseBtn"),
  buyFallBtn: el("buyFallBtn"),
  startAutoBtn: el("startAutoBtn"),
  stopAutoBtn: el("stopAutoBtn"),

  logBody: el("logBody"),
  clearLogBtn: el("clearLogBtn"),
};

/* ---------------------------------------------------------------------- */
/* Connection flow                                                        */
/* ---------------------------------------------------------------------- */

function setConnStatus(mode, label) {
  dom.connDot.className = "conn-dot" + (mode ? ` ${mode}` : "");
  dom.connLabel.textContent = label;
}

async function handleConnect() {
  const appId = dom.appIdInput.value.trim();
  const token = dom.tokenInput.value.trim();

  if (!appId || !token) {
    alert("Enter both an App ID and an API token.");
    return;
  }

  dom.connectBtn.disabled = true;
  dom.connectBtn.textContent = "Connecting…";
  setConnStatus("pending", "Connecting…");

  try {
    await client.connect(appId);
    const authResult = await client.authorize(token);

    app.connected = true;
    app.authorized = true;
    app.currency = authResult.authorize.currency || "USD";
    app.balance = authResult.authorize.balance;
    app.startingBalance = authResult.authorize.balance;

    setConnStatus("live", "Live");
    dom.accountBadge.textContent = `${authResult.authorize.loginid} · ${app.currency}`;
    dom.accountBadge.classList.remove("hidden");
    dom.connectBtn.textContent = "Connected";

    dom.strategyBlock.classList.add("active");
    dom.autoBlock.classList.add("active");
    dom.buyRiseBtn.disabled = false;
    dom.buyFallBtn.disabled = false;
    dom.startAutoBtn.disabled = false;

    if (dom.rememberToken.checked) {
      localStorage.setItem(LS_APPID, appId);
      localStorage.setItem(LS_TOKEN, token);
    } else {
      localStorage.removeItem(LS_APPID);
      localStorage.removeItem(LS_TOKEN);
    }

    updateStats();
    subscribeToSymbol(dom.symbolSelect.value);

    client.on("contract", handleContractUpdate);
  } catch (err) {
    setConnStatus(null, "Connection failed");
    dom.connectBtn.disabled = false;
    dom.connectBtn.textContent = "Connect";
    alert("Couldn't connect: " + (err?.message || err?.error?.message || "check your App ID and token."));
  }
}

client.on("close", () => {
  if (app.connected) {
    setConnStatus(null, "Disconnected");
    app.connected = false;
    stopAutoTrade();
  }
});

/* ---------------------------------------------------------------------- */
/* Ticks + chart                                                          */
/* ---------------------------------------------------------------------- */

async function subscribeToSymbol(symbol) {
  await client.forgetAll("ticks");
  app.ticks = [];
  app.currentSymbol = symbol;
  dom.tickerSymbolLabel.textContent = dom.symbolSelect.selectedOptions[0].textContent;
  await client.subscribeTicks(symbol);
}

client.on("tick", (tick) => {
  if (tick.symbol !== app.currentSymbol) return;
  app.ticks.push(tick.quote);
  if (app.ticks.length > 60) app.ticks.shift();

  dom.tickerPrice.textContent = formatPrice(tick.quote);
  renderChart();
  renderLastDigits(tick.quote);

  maybeAutoTrade();
});

function formatPrice(v) {
  return Number(v).toFixed(3);
}

function renderChart() {
  const ticks = app.ticks;
  if (ticks.length < 2) {
    dom.tickChart.innerHTML = "";
    return;
  }
  const min = Math.min(...ticks);
  const max = Math.max(...ticks);
  const range = max - min || 1;
  const w = 600, h = 110, pad = 6;

  const points = ticks.map((v, i) => {
    const x = (i / (ticks.length - 1)) * w;
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const rising = ticks[ticks.length - 1] >= ticks[0];
  const stroke = rising ? "var(--rise)" : "var(--fall)";

  dom.tickChart.innerHTML = `
    <polyline points="${points.join(" ")}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
  `;
}

function renderLastDigits(quote) {
  const digit = String(quote).replace(".", "").slice(-1);
  const chip = document.createElement("span");
  chip.className = "digit-chip " + (Number(digit) % 2 === 0 ? "even" : "odd");
  chip.textContent = digit;
  dom.lastDigits.appendChild(chip);
  while (dom.lastDigits.children.length > 20) {
    dom.lastDigits.removeChild(dom.lastDigits.firstChild);
  }
}

/* ---------------------------------------------------------------------- */
/* Trading                                                                 */
/* ---------------------------------------------------------------------- */

function readTradeConfig() {
  return {
    symbol: app.currentSymbol,
    duration: Number(dom.durationInput.value),
    durationUnit: dom.durationUnitSelect.value,
  };
}

async function placeTrade(contractType, stakeOverride) {
  const { symbol, duration, durationUnit } = readTradeConfig();
  const stake = stakeOverride ?? Number(dom.stakeInput.value);

  setButtonsDuring(true);

  try {
    const proposal = await client.getProposal({
      symbol,
      contractType,
      stake,
      duration,
      durationUnit,
    });

    const buyResult = await client.buy(proposal.proposal.id, proposal.proposal.ask_price);
    const contractId = buyResult.buy.contract_id;

    app.currentStake = stake;

    addLogRow({
      time: new Date(),
      symbol,
      type: contractType,
      stake,
      result: "pending",
      pl: null,
      contractId,
    });

    await client.subscribeContract(contractId);
  } catch (err) {
    alert("Trade failed: " + (err?.message || "unknown error"));
  } finally {
    setButtonsDuring(false);
  }
}

function setButtonsDuring(busy) {
  dom.buyRiseBtn.disabled = busy;
  dom.buyFallBtn.disabled = busy;
}

function handleContractUpdate(contract) {
  if (!contract.is_sold) return; // wait until settled

  const pl = Number(contract.profit);
  app.trades += 1;
  app.sessionPL += pl;
  if (pl > 0) app.wins += 1;

  updateLogRow(contract.contract_id, pl > 0 ? "win" : "loss", pl);
  updateStats();
  applyMoneyManagement(pl > 0);
  checkTPSL();

  if (app.autoRunning) {
    scheduleNextAutoTrade();
  }
}

function applyMoneyManagement(won) {
  const mode = dom.mmModeSelect.value;
  if (mode !== "martingale") {
    app.autoStep = 0;
    return;
  }
  const maxSteps = Number(dom.maxStepsInput.value);
  if (won) {
    app.autoStep = 0;
  } else if (app.autoStep < maxSteps) {
    app.autoStep += 1;
  } else {
    app.autoStep = 0; // reset after hitting the cap, back to base stake
  }
}

function currentStakeForNextTrade() {
  const base = Number(dom.stakeInput.value);
  if (dom.mmModeSelect.value !== "martingale") return base;
  const mult = Number(dom.multiplierInput.value);
  return Number((base * Math.pow(mult, app.autoStep)).toFixed(2));
}

function checkTPSL() {
  const tp = Number(dom.tpInput.value);
  const sl = Number(dom.slInput.value);
  if (tp && app.sessionPL >= tp) {
    stopAutoTrade();
    alert(`Take-profit reached (+$${app.sessionPL.toFixed(2)}). Auto-trade stopped.`);
  } else if (sl && app.sessionPL <= -Math.abs(sl)) {
    stopAutoTrade();
    alert(`Stop-loss reached (-$${Math.abs(app.sessionPL).toFixed(2)}). Auto-trade stopped.`);
  }
}

/* ---------------------------------------------------------------------- */
/* Auto-trade loop                                                        */
/* ---------------------------------------------------------------------- */

let autoTradeInFlight = false;

function startAutoTrade() {
  app.autoRunning = true;
  app.autoStep = 0;
  dom.startAutoBtn.classList.add("hidden");
  dom.stopAutoBtn.classList.remove("hidden");
  scheduleNextAutoTrade(true);
}

function stopAutoTrade() {
  app.autoRunning = false;
  dom.startAutoBtn.classList.remove("hidden");
  dom.stopAutoBtn.classList.add("hidden");
}

function scheduleNextAutoTrade(immediate) {
  if (!app.autoRunning) return;
  const delay = immediate ? 300 : 800;
  setTimeout(() => {
    autoTradeInFlight = false;
  }, delay);
}

function maybeAutoTrade() {
  if (!app.autoRunning || autoTradeInFlight) return;

  const strategy = dom.strategySelect.value;
  if (strategy === "manual") return;

  let direction = null;
  const lookback = Number(dom.lookbackInput.value);

  if (strategy === "alternate") {
    direction = Strategy.alternate(app);
  } else if (strategy === "trend") {
    direction = Strategy.trend(app, app.ticks, lookback);
  } else if (strategy === "counter-streak") {
    direction = Strategy.counterStreak(app, app.ticks, 4);
  }

  if (!direction) return;

  autoTradeInFlight = true;
  const stake = currentStakeForNextTrade();
  placeTrade(direction, stake);
}

/* ---------------------------------------------------------------------- */
/* Stats + log rendering                                                  */
/* ---------------------------------------------------------------------- */

function updateStats() {
  dom.balanceStat.textContent = app.balance != null ? `$${Number(app.balance).toFixed(2)}` : "—";

  dom.plStat.textContent = `${app.sessionPL >= 0 ? "+" : ""}$${app.sessionPL.toFixed(2)}`;
  dom.plStat.classList.toggle("up", app.sessionPL > 0);
  dom.plStat.classList.toggle("down", app.sessionPL < 0);

  dom.tradesStat.textContent = app.trades;

  dom.winrateStat.textContent = app.trades > 0 ? `${Math.round((app.wins / app.trades) * 100)}%` : "—";
}

function addLogRow({ time, symbol, type, stake, result, pl, contractId }) {
  const emptyRow = dom.logBody.querySelector(".log-empty-row");
  if (emptyRow) emptyRow.remove();

  const row = document.createElement("tr");
  row.dataset.contractId = contractId;
  row.innerHTML = `
    <td>${time.toLocaleTimeString()}</td>
    <td>${symbol}</td>
    <td>${type}</td>
    <td>$${stake.toFixed(2)}</td>
    <td class="result-pending">pending</td>
    <td>—</td>
  `;
  dom.logBody.prepend(row);
}

function updateLogRow(contractId, result, pl) {
  const row = dom.logBody.querySelector(`tr[data-contract-id="${contractId}"]`);
  if (!row) return;
  const cells = row.querySelectorAll("td");
  cells[4].textContent = result;
  cells[4].className = result === "win" ? "result-win" : "result-loss";
  cells[5].textContent = `${pl >= 0 ? "+" : ""}$${pl.toFixed(2)}`;
  cells[5].className = pl >= 0 ? "result-win" : "result-loss";
}

/* ---------------------------------------------------------------------- */
/* Event wiring                                                           */
/* ---------------------------------------------------------------------- */

dom.connectBtn.addEventListener("click", handleConnect);

dom.symbolSelect.addEventListener("change", (e) => {
  if (app.connected) subscribeToSymbol(e.target.value);
});

dom.buyRiseBtn.addEventListener("click", () => placeTrade("CALL"));
dom.buyFallBtn.addEventListener("click", () => placeTrade("PUT"));

dom.startAutoBtn.addEventListener("click", () => {
  if (dom.strategySelect.value === "manual") {
    alert("Pick an auto-trade signal first (Alternate, Trend follow, or Counter-streak).");
    return;
  }
  startAutoTrade();
});
dom.stopAutoBtn.addEventListener("click", stopAutoTrade);

dom.clearLogBtn.addEventListener("click", () => {
  dom.logBody.innerHTML = `<tr class="log-empty-row"><td colspan="6">No trades yet — connect and place your first trade.</td></tr>`;
});

/* Restore remembered credentials, if any */
window.addEventListener("DOMContentLoaded", () => {
  const savedAppId = localStorage.getItem(LS_APPID);
  const savedToken = localStorage.getItem(LS_TOKEN);
  if (savedAppId && savedToken) {
    dom.appIdInput.value = savedAppId;
    dom.tokenInput.value = savedToken;
    dom.rememberToken.checked = true;
  }
});
