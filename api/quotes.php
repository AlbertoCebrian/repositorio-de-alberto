<?php
// api/quotes.php — Stooq por símbolo (sin API key) con fallbacks + debug
declare(strict_types=1);
ini_set('display_errors', '0');
error_reporting(E_ALL);

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');

$debug = isset($_GET['debug']); // añade &debug=1 para ver diagnóstico

// ===== 1) Símbolos =====
$symbolsParam = $_GET['symbols'] ?? '';
$symbols = array_values(array_filter(array_map('trim', explode(',', $symbolsParam))));
if (empty($symbols)) {
  $symbols = [
    // USA
    'AAPL','MSFT','GOOGL','AMZN','NVDA','META','TSLA','NFLX','AMD','INTC','IBM','ORCL',
    // España (.MC) → intentamos ADR cuando exista
    'SAN.MC','BBVA.MC','IBE.MC','ITX.MC','TEF.MC','REP.MC','ACS.MC','FER.MC','AENA.MC','GRF.MC',
    // Europa
    'SAP.DE','BMW.DE','SIE.DE','AIR.PA',
    // Índices
    '^GSPC','^NDX','^IBEX'
  ];
}

// ===== 2) Mapeo a Stooq =====
function mapToStooq(string $sym): ?string {
  $s = strtoupper(trim($sym));
  // Índices
  if ($s === '^GSPC') return '^spx';
  if ($s === '^NDX')  return '^ndx';
  if ($s === '^IBEX') return '^ibex';

  // Xetra/París: .DE / .PA se usan tal cual en Stooq (minúsculas en URL)
  if (preg_match('/\.(DE|PA)$/i', $s)) return strtolower($s);

  // Madrid → ADR USA cuando exista
  if (str_ends_with($s, '.MC')) {
    $base = substr($s, 0, -3);
    $mapADR = [
      'SAN' => 'SAN.US',   // Santander
      'TEF' => 'TEF.US',   // Telefónica
      'GRF' => 'GRFS.US',  // Grifols
    ];
    return isset($mapADR[$base]) ? strtolower($mapADR[$base]) : null; // otros .MC no mapeados → null
  }

  // Por defecto: USA
  if (!preg_match('/\.[A-Z]{2}$/', $s)) $s .= '.US';
  return strtolower($s);
}

$stooqSymbols = [];
$backMap = []; // stooqSym => originalSym
foreach ($symbols as $orig) {
  $m = mapToStooq($orig);
  if ($m) { $stooqSymbols[] = $m; $backMap[$m] = $orig; }
}
if (empty($stooqSymbols)) { echo '[]'; exit; }

// ===== 3) HTTP helpers =====
function http_get_curl(string $url): array {
  if (!function_exists('curl_init')) return [0, null, 'curl_missing'];
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_CONNECTTIMEOUT => 6,
    CURLOPT_TIMEOUT => 10,
    CURLOPT_USERAGENT => 'AppBolsa/1.0 (+stooq)'
  ]);
  $body = curl_exec($ch);
  $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
  $err  = curl_error($ch);
  curl_close($ch);
  if ($body === false) return [$code ?: 0, null, $err ?: 'curl_exec_failed'];
  return [$code, $body, null];
}
function http_get_stream(string $url): array {
  if (!ini_get('allow_url_fopen')) return [0, null, 'allow_url_fopen_off'];
  $ctx = stream_context_create(['http' => ['timeout' => 10, 'user_agent' => 'AppBolsa/1.0 (+stooq)']]);
  $body = @file_get_contents($url, false, $ctx);
  $code = 0;
  if (isset($http_response_header[0]) && preg_match('#\s(\d{3})\s#', $http_response_header[0], $m)) {
    $code = (int)$m[1];
  }
  if ($body === false) return [$code, null, 'stream_failed'];
  return [$code, $body, null];
}

// Stooq endpoints (varios fallbacks)
function stooq_urls(string $stooqSym): array {
  $qs = http_build_query([
    's' => $stooqSym,
    'f' => 'sd2t2ohlcvn', // Symbol,Date,Time,Open,High,Low,Close,Volume,Name
    'h' => '',            // incluye cabecera
    'e' => 'csv'
  ]);
  return [
    "https://stooq.com/q/l/?{$qs}",
    "http://stooq.com/q/l/?{$qs}",
    "https://stooq.pl/q/l/?{$qs}",
    "http://stooq.pl/q/l/?{$qs}",
  ];
}

// ===== 4) Descargar cada símbolo por separado y parsear =====
$results = [];
$debugSteps = [];

foreach ($stooqSymbols as $stooqSym) {
  $ok = false;
  $csv = null; $lastStep = null;

  foreach (stooq_urls($stooqSym) as $url) {
    // cURL
    [$code, $body, $err] = http_get_curl($url);
    $debugSteps[] = ['sym'=>$stooqSym, 'method'=>'curl', 'url'=>$url, 'code'=>$code, 'err'=>$err, 'snippet'=>$body?substr($body,0,80):null];
    if ($code === 200 && $body) { $csv = $body; $ok = true; break; }

    // stream
    [$code, $body, $err] = http_get_stream($url);
    $debugSteps[] = ['sym'=>$stooqSym, 'method'=>'stream', 'url'=>$url, 'code'=>$code, 'err'=>$err, 'snippet'=>$body?substr($body,0,80):null];
    if ($code === 200 && $body) { $csv = $body; $ok = true; break; }
  }

  if (!$ok || !$csv) continue;

  // Normaliza líneas
  $csv = str_replace("\r\n", "\n", $csv);
  $lines = array_values(array_filter(array_map('trim', explode("\n", $csv))));
  if (empty($lines)) continue;

  // Si hay cabecera, quítala
  if (stripos($lines[0], 'symbol,date') !== false) {
    array_shift($lines);
  }
  if (empty($lines)) continue;

  // Stooq por símbolo debería tener UNA línea de datos
  $parts = str_getcsv($lines[0]);
  if (count($parts) < 9) continue;

  [$sym,$date,$time,$open,$high,$low,$close,$vol,$name] = $parts;

  // Algunos símbolos devuelven "N/D" si no hay datos
  $openF  = is_numeric($open)  ? (float)$open  : null;
  $closeF = is_numeric($close) ? (float)$close : null;
  if ($closeF === null || $closeF <= 0) continue;

  $chgPct = ($openF && $openF > 0) ? (($closeF - $openF) / $openF) * 100.0 : 0.0;

  $origSym = $backMap[strtolower(trim($sym))] ?? strtoupper($sym);
  $results[] = [
    'symbol'   => $origSym,
    'name'     => $name ?: $origSym,
    'price'    => round($closeF, 4),
    'change'   => round($chgPct, 2),
    'currency' => null,
    'exchange' => null,
  ];
}

// Orden estable
usort($results, fn($a,$b) => strcmp($a['symbol'], $b['symbol']));

// Cache 60s (opcional)
if (!$debug) {
  $cacheKey  = 'quotes_' . md5(join(',', $symbols)) . '.json';
  $cacheFile = sys_get_temp_dir() . DIRECTORY_SEPARATOR . $cacheKey;
  @file_put_contents($cacheFile, json_encode($results, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
}

// Respuesta
if ($debug) {
  echo json_encode(['data'=>$results, 'debug'=>[
    'mapped'=>$stooqSymbols,
    'steps'=>$debugSteps,
    'env'=>[
      'curl'=>function_exists('curl_init'),
      'allow_url_fopen'=>(bool)ini_get('allow_url_fopen'),
      'php'=>PHP_VERSION
    ]
  ]], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
} else {
  echo json_encode($results, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}
