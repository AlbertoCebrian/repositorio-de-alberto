/***************
 * CONFIG
 ***************/
// URLs de las APIs para obtener cotizaciones, noticias e histórico
const QUOTES_ENDPOINT  = "api/quotes.php";   // precios actuales
const NEWS_ENDPOINT    = "api/news.php";     // titulares
const HISTORY_ENDPOINT = "api/history.php";  // histórico real (nuevo)

// Si queremos usar noticias simuladas en lugar de reales
let USE_SIMULATED_NEWS = false;

// Símbolos por defecto que vamos a mostrar en la app
const DEFAULT_SYMBOLS = [
  "AAPL","MSFT","GOOGL","AMZN","NVDA","META","TSLA","NFLX","AMD","INTC","IBM","ORCL",
  "SAN.MC","BBVA.MC","IBE.MC","ITX.MC","TEF.MC","REP.MC","ACS.MC","FER.MC","AENA.MC","GRF.MC",
  "AIR.PA","SAP.DE","BMW.DE","SIE.DE",
  "^IBEX","^GSPC","^NDX"
];

// Diferentes rangos de tiempo para ver el histórico de las acciones
const TIMEFRAMES = [
  {key:"1D", label:"1D", days:1},
  {key:"1W", label:"1S", days:7},
  {key:"1M", label:"1M", days:31},
  {key:"3M", label:"3M", days:93},
  {key:"6M", label:"6M", days:186},
  {key:"1Y", label:"1A", days:372},
  {key:"2Y", label:"2A", days:744},
  {key:"5Y", label:"5A", days:1860},
  {key:"10Y",label:"10A",days:3720}
];

/*************************
 * Estado runtime
 *************************/
// Variables que cambian mientras la app está abierta
let stocks = [];           // cotizaciones actuales
let newsExpanded = false;  // si las noticias están expandidas
let currentDetail = { symbol:null, name:null, tf:"6M" }; // acción que se ve en detalle

/****************
 * DOM Elements
 ****************/
// Referencias a los elementos de la página que vamos a modificar
const favoritesSection   = document.getElementById("favoritesSection");
const favoritesContainer = document.getElementById("favoritesContainer");
const stocksContainer    = document.getElementById("stocksContainer");
const listView           = document.getElementById("list-view");
const detailView         = document.getElementById("detail-view");
const detailTitle        = document.getElementById("detailTitle");
const backButton         = document.getElementById("backButton");

const newsContainer      = document.getElementById("newsContainer");
const newsError          = document.getElementById("newsError");
const refreshNewsBtn     = document.getElementById("refreshNewsBtn");
const newsModeBadge      = document.getElementById("newsModeBadge");
const refreshQuotesBtn   = document.getElementById("refreshQuotesBtn");
const toggleNewsBtn      = document.getElementById("toggleNewsBtn");
const searchInput        = document.getElementById("searchInput");

const tfControls         = document.getElementById("tfControls");
const detailChartEl      = document.getElementById("detailChart");
const detailMetaEl       = document.getElementById("detailMeta");

/***********************
 * Watchlist LocalStore
 ***********************/
// Guardar acciones favoritas en el navegador para que no se pierdan
const LS_KEY = "watchlist_symbols_v1";
const getWatchlist = () => { 
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); } 
  catch { return []; } 
};
const setWatchlist = (arr) => localStorage.setItem(LS_KEY, JSON.stringify(arr));

// Añadir o quitar acción de favoritos
const toggleWatch = (symbol) => {
  const wl = getWatchlist();
  const i = wl.indexOf(symbol);
  if (i >= 0) wl.splice(i, 1); // si ya estaba, quitar
  else wl.unshift(symbol);      // si no estaba, añadir al principio
  setWatchlist(wl);
};

/***********************
 * Sparklines (pequeños gráficos en la lista)
 ***********************/
// Generar números pseudoaleatorios a partir de un string
function seededRandom(seed) {
  let s = 0;
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
  return () => { s = (1664525 * s + 1013904223) >>> 0; return (s & 0xfffffff) / 0xfffffff; };
}

// Crear sparkline para cada acción
function makeSparkline(symbol, change) {
  const w = 360, h = 54, n = 24;       // ancho, alto, número de puntos
  const rand = seededRandom(symbol);    // generador pseudoaleatorio
  const pts = [];
  let v = 0;
  for (let i = 0; i < n; i++) { 
    v += (rand() - 0.5) * 0.8;          // generar fluctuaciones
    pts.push(v); 
  }
  const min = Math.min(...pts), max = Math.max(...pts);
  const norm = pts.map(p => (p - min) / (max - min || 1)); // normalizar entre 0 y 1
  const dx = w / (n - 1);
  const path = norm.map((y, i) => `${i === 0 ? "M" : "L"} ${i * dx} ${h - 6 - y * (h - 12)}`).join(" ");
  const stroke = change >= 0 ? "#4caf50" : "#f44336"; // verde si sube, rojo si baja
  return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <path class="axis" d="M 0 ${h-1} L ${w} ${h-1}" />
    <path d="${path}" stroke="${stroke}" fill="none" />
  </svg>`;
}

/*********************
 * Render de acciones (lista)
 *********************/
function renderList(container, list) {
  container.innerHTML = "";              // limpiar el contenedor
  const watchlist = getWatchlist();      // obtener favoritos

  list.forEach(stock => {
    const isFav = watchlist.includes(stock.symbol); // comprobar si está en favoritos
    const row = document.createElement("div");
    row.className = "stock";
    row.innerHTML = `
      <div>
        <button class="pin-btn ${isFav ? "active" : ""}" title="${isFav ? "Quitar de favoritas" : "Añadir a favoritas"}" data-symbol="${stock.symbol}" aria-label="Pin ${stock.symbol}">★</button>
      </div>
      <div class="stock-info">
        <div class="stock-symbol">${stock.symbol}</div>
        <div class="stock-name">${stock.name ?? ""}</div>
      </div>
      <div class="stock-chart-container">
        <div class="stock-chart">${makeSparkline(stock.symbol, stock.change)}</div>
      </div>
      <div class="stock-price-container">
        <div class="stock-price">${Number(stock.price).toFixed(2)}</div>
        <div class="stock-change ${stock.change >= 0 ? "positive" : "negative"}">
          ${stock.change >= 0 ? "+" : ""}${Number(stock.change).toFixed(2)}%
        </div>
      </div>
    `;

    // Click para mostrar detalle
    row.addEventListener("click", () => mostrarDetalle(stock.symbol, stock.name ?? stock.symbol));

    // Click en la estrella para favoritos (evitar que se abra el detalle)
    row.querySelector(".pin-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleWatch(stock.symbol);
      render(); // refrescar lista
    });

    container.appendChild(row);
  });
}

// Función principal para renderizar la lista completa
function render(stockList = stocks) {
  const wl = getWatchlist();
  const bySymbol = new Map(stockList.map(s => [s.symbol, s]));
  const favs = wl.map(sym => bySymbol.get(sym)).filter(Boolean);
  const rest = stockList.filter(s => !wl.includes(s.symbol));

  if (favs.length > 0) {
    favoritesSection.style.display = "";
    renderList(favoritesContainer, favs);
  } else {
    favoritesSection.style.display = "none";
    favoritesContainer.innerHTML = "";
  }
  renderList(stocksContainer, rest);
}

/*****************
 * Vista detalle + histórico real
 *****************/
// Dibujar gráfico de línea en detalle
function drawLineChart(el, points) {
  el.innerHTML = "";
  const w = el.clientWidth || 940;
  const h = el.clientHeight || 260;

  if (!points || points.length === 0) {
    el.innerHTML = `<div class="news-error" style="width:100%;">No hay datos para este periodo.</div>`;
    return;
  }

  const xs = points.map(p => p.t);
  const ys = points.map(p => p.c);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = 10;

  const mapX = t => pad + ((t - minX) / Math.max(1, (maxX - minX))) * (w - 2*pad);
  const mapY = c => (h - pad) - ((c - minY) / Math.max(1e-12, (maxY - minY))) * (h - 2*pad);

  const d = points.map((p, i) => `${i===0?'M':'L'} ${mapX(p.t)} ${mapY(p.c)}`).join(" ");
  const change = points.length >= 2 ? ((points.at(-1).c - points[0].c) / points[0].c) : 0;
  const stroke = change >= 0 ? "#4caf50" : "#f44336";

  el.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none" aria-label="Histórico">
      <rect x="0" y="0" width="${w}" height="${h}" fill="#1a1a1a"/>
      <path d="${d}" stroke="${stroke}" stroke-width="2.5" fill="none"/>
    </svg>
  `;
}

// Pedir datos históricos al backend
async function fetchHistory(symbol, tfKey) {
  const res = await fetch(`${HISTORY_ENDPOINT}?symbol=${encodeURIComponent(symbol)}&range=${encodeURIComponent(tfKey)}`, {
    headers: {"Accept":"application/json"}
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json(); // {symbol, range, points:[{t,c}]}
  return data;
}

// Dibujar botones de rangos de tiempo
function renderTfControls() {
  tfControls.innerHTML = "";
  TIMEFRAMES.forEach(tf => {
    const btn = document.createElement("button");
    btn.className = "tf-btn" + (tf.key === currentDetail.tf ? " active" : "");
    btn.textContent = tf.label;
    btn.setAttribute("role","tab");
    btn.setAttribute("aria-selected", tf.key === currentDetail.tf ? "true":"false");
    btn.addEventListener("click", async () => {
      currentDetail.tf = tf.key;
      Array.from(tfControls.children).forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      await loadAndDrawHistory(currentDetail.symbol, currentDetail.tf);
    });
    tfControls.appendChild(btn);
  });
}

// Cargar histórico y dibujar gráfico
async function loadAndDrawHistory(symbol, tfKey) {
  detailChartEl.innerHTML = `<div class='skel'><div class='shimmer' style='width:60%'></div><div class='gap'></div><div class='shimmer' style='width:90%'></div></div>`;
  try {
    let { points } = await fetchHistory(symbol, tfKey);

    // Fallback si 1D tiene pocos datos
    let note = "Datos diarios (Stooq)";
    if (tfKey === "1D" && (!points || points.length < 2)) {
      const alt = await fetchHistory(symbol, "1W");
      if (alt && alt.points && alt.points.length >= 2) {
        points = alt.points;
        note = "Sin intradía: mostrando últimos 7 cierres (1S)";
      }
    }

    drawLineChart(detailChartEl, points);

    const first = points[0], last = points.at(-1);
    if (first && last) {
      const chg = ((last.c - first.c) / first.c) * 100;
      detailMetaEl.textContent = `Variación ${tfKey}: ${chg>=0?'+':''}${chg.toFixed(2)}% · ${note}`;
    } else {
      detailMetaEl.textContent = "Sin datos suficientes para este periodo.";
    }
  } catch (e) {
    console.error(e);
    detailChartEl.innerHTML = `<div class="news-error">No se pudo cargar el histórico.</div>`;
    detailMetaEl.textContent = "";
  }
}

// Mostrar detalle de una acción
function mostrarDetalle(symbol, name) {
  listView.style.display = "none";
  detailView.style.display = "block";
  detailTitle.textContent = `${name} (${symbol})`;

  currentDetail = { symbol, name, tf: currentDetail.tf || "6M" };
  renderTfControls();                // mostrar botones de tiempo
  loadAndDrawHistory(symbol, currentDetail.tf); // cargar gráfico
}

/************
 * Búsqueda
 ************/
searchInput.addEventListener("input", function () {
  const q = this.value.toLowerCase();
  const filtered = stocks.filter(s =>
    (s.name ?? "").toLowerCase().includes(q) || s.symbol.toLowerCase().includes(q)
  );
  render(filtered);
});

/*****************
 * Fecha (Madrid)
 *****************/
// Mostrar la fecha en español
function formatTodayES(d = new Date()) {
  const opts = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
  return new Intl.DateTimeFormat('es-ES', { ...opts, timeZone: 'Europe/Madrid' })
    .format(d).replace(/^./, c => c.toUpperCase());
}

// Actualizar la fecha a medianoche
function scheduleMidnightUpdate(cb) {
  const now = new Date();
  const tz = 'Europe/Madrid';
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const parts = formatter.formatToParts(now).reduce((acc, p) => (acc[p.type]=p.value, acc), {});
  const currentTzDate = new Date(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`);
  const next = new Date(currentTzDate.getTime());
  next.setDate(next.getDate() + 1);
  next.setHours(0,0,5,0);
  const ms = next - currentTzDate;
  setTimeout(() => { cb(); scheduleMidnightUpdate(cb); }, ms);
}

// Inicializar fecha en la interfaz
function initTodayDate() {
  const el = document.getElementById('todayDate');
  if (!el) return;
  const update = () => el.textContent = formatTodayES();
  update(); scheduleMidnightUpdate(update);
}

/****************
 * Noticias
 ****************/
const simulatedNews = [
  { title:"Ejemplo simulado", source:"Demo", publishedAt: Date.now() - 1000*60*30, url:"#", summary:"Solo se usa si activas modo simulado." }
];

// Mostrar "hace X minutos/días"
function timeAgoES(ts) {
  const diff = Math.max(0, Date.now() - ts);
  const m = Math.floor(diff / 60000);
  if (m < 1) return "ahora";
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "hace 1 día" : `hace ${d} días`;
}

// Renderizar noticias en la interfaz
function renderNews(list) {
  newsContainer.innerHTML = ""; newsError.hidden = true;
  newsContainer.classList.add("collapsible");
  newsContainer.classList.toggle("collapsed", !newsExpanded);
  list.forEach(n => {
    const card = document.createElement("article");
    card.className = "news-card";
    const href = n.url && /^https?:\/\//i.test(n.url) ? n.url : "#";
    card.innerHTML = `
      <div class="news-title"><a href="${href}" target="_blank" rel="noopener noreferrer">${n.title}</a></div>
      <div class="news-chip">${timeAgoES(n.publishedAt)}</div>
      <div class="news-meta">${n.source}</div>
      <div class="news-summary">${n.summary}</div>`;
    newsContainer.appendChild(card);
  });
  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "news-error";
    empty.textContent = "No hay noticias disponibles por ahora.";
    newsContainer.appendChild(empty);
  }
}

// Skeleton de carga para noticias
function renderNewsSkeleton(count = 6) {
  newsContainer.innerHTML = ""; newsError.hidden = true;
  newsContainer.classList.add("collapsible");
  newsContainer.classList.toggle("collapsed", !newsExpanded);
  for (let i = 0; i < count; i++) {
    const sk = document.createElement("div");
    sk.className = "skel";
    sk.innerHTML = `
      <div class="shimmer" style="width:70%;"></div>
      <div class="gap"></div>
      <div class="shimmer" style="width:30%;"></div>
      <div class="gap"></div>
      <div class="shimmer" style="width:95%; height:10px;"></div>
      <div class="gap"></div>
      <div class="shimmer" style="width:88%; height:10px;"></div>`;
    newsContainer.appendChild(sk);
  }
}

// Mostrar error de noticias
function showNewsError(msg) { newsError.textContent = msg; newsError.hidden = false; }

// Aplicar estado colapsado o expandido de noticias
function applyNewsCollapsedState() {
  const isCollapsed = !newsExpanded;
  newsContainer.classList.toggle("collapsed", isCollapsed);
  if (toggleNewsBtn) {
    toggleNewsBtn.textContent = isCollapsed ? "Ver más" : "Ver menos";
    toggleNewsBtn.setAttribute("aria-expanded", String(newsExpanded));
  }
  try { localStorage.setItem("newsExpanded", JSON.stringify(newsExpanded)); } catch {}
}

// Alternar noticias
function toggleNews() {
  newsExpanded = !newsExpanded; applyNewsCollapsedState();
  if (!newsExpanded) document.getElementById("newsSection").scrollIntoView({ behavior:"smooth", block:"start" });
}

// Traer noticias del backend
async function fetchNewsFromBackend() {
  const res = await fetch(NEWS_ENDPOINT, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// Cargar noticias y renderizar
async function loadNews() {
  try {
    const saved = localStorage.getItem("newsExpanded");
    if (saved !== null) newsExpanded = JSON.parse(saved) === true;
  } catch {}
  newsModeBadge.textContent = USE_SIMULATED_NEWS ? "SIMULADO" : "EN VIVO";
  renderNewsSkeleton();
  try {
    const list = USE_SIMULATED_NEWS ? simulatedNews : await fetchNewsFromBackend();
    renderNews(list);
    applyNewsCollapsedState();
  } catch (err) {
    console.error(err);
    showNewsError("No se pudieron cargar las noticias. Reintenta más tarde.");
    if (!USE_SIMULATED_NEWS) { renderNews(simulatedNews); applyNewsCollapsedState(); }
  }
}

/********************
 * Cotizaciones API (precios del listado)
 ********************/
const SIMULATED_QUOTES = [
  { symbol:"AAPL", name:"Apple Inc.",    price:172.50, change:+0.85 },
  { symbol:"MSFT", name:"Microsoft Corp.",price:420.10, change:-0.42 },
  { symbol:"SAN.MC", name:"Banco Santander, S.A.", price:4.15, change:+1.20 },
  { symbol:"BBVA.MC", name:"BBVA",       price:8.40,  change:+0.35 },
  { symbol:"NVDA",  name:"NVIDIA Corp.", price:920.12,change:+1.90 },
  { symbol:"TSLA",  name:"Tesla, Inc.",  price:210.33,change:-2.10 },
  { symbol:"^IBEX", name:"IBEX 35",      price:10550.00, change:+0.15 }
];

// Traer cotizaciones reales del backend
async function fetchQuotes(symbols = DEFAULT_SYMBOLS) {
  const params = new URLSearchParams({ symbols: symbols.join(",") });
  const res = await fetch(`${QUOTES_ENDPOINT}?${params.toString()}`, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// Mostrar error y opción de datos demo
function showQuotesErrorWithDemo(errMsg) {
  stocksContainer.innerHTML = `
    <div class="news-error" style="margin-top:0">
      ${errMsg || "No se pudieron cargar las cotizaciones."}
      <div style="margin-top:8px"><button id="useDemoQuotesBtn" class="btn-outline" type="button">Usar datos demo</button></div>
    </div>`;
  const btn = document.getElementById("useDemoQuotesBtn");
  if (btn) btn.addEventListener("click", () => { stocks = SIMULATED_QUOTES; render(stocks); });
}

// Cargar cotizaciones y renderizar
async function loadQuotes() {
  stocksContainer.innerHTML = `<div class='skel'><div class='shimmer' style='width:40%'></div><div class='gap'></div><div class='shimmer'></div></div>`;
  try {
    const data = await fetchQuotes();
    if (!data || data.length === 0) { showQuotesErrorWithDemo("El servidor no devolvió cotizaciones."); return; }
    stocks = data; render(stocks);
  } catch (e) {
    console.error(e); showQuotesErrorWithDemo("Error al consultar el servidor de cotizaciones.");
  }
}

/*************
 * Listeners (botones y eventos)
 *************/
refreshNewsBtn.addEventListener("click", () => loadNews());
refreshQuotesBtn.addEventListener("click", () => loadQuotes());
toggleNewsBtn.addEventListener("click", toggleNews);
backButton.addEventListener("click", () => { detailView.style.display = "none"; listView.style.display = "block"; });

/*****************
 * Fecha (init)
 *****************/
initTodayDate(); // inicializar la fecha

/********
 * Init
 ********/
function boot() {
  initTodayDate();
  loadNews();
  loadQuotes();
}
boot(); // arrancar la app
