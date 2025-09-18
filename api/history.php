<?php
// api/history.php — histórico diario desde Stooq (gratis) + selector de rango
// Devuelve: { symbol, range, points: [{t: epoch_ms, c: close}, ...] }
declare(strict_types=1);
ini_set('display_errors', '0');
error_reporting(E_ALL);

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');

$debug   = isset($_GET['debug']);
$symbol  = $_GET['symbol'] ?? '';
$range   = strtoupper(trim($_GET['range'] ?? '6M'));

if (!$symbol) {
  echo json_encode(['symbol'=>null,'range'=>$range,'points'=>[]]);
  exit;
}

// Mapeo rangos → días aprox (trading diario)
$rangeDays = [
  '1D'=>1, '1W'=>7, '1M'=>31, '3M'=>93, '6M'=>186,
  '1Y'=>372, '2Y'=>744, '5Y'=>1860, '10Y'=>3720
];
$days = $rangeDays[$range] ?? 186;

// ===== Mapeo símbolo a Stooq =====
function mapToStooq(string $sym): ?string {
  $s = strtoupper(trim($sym));
  if ($s === '^GSPC') return '^spx';
  if ($s === '^NDX')  return '^ndx';
  if ($s === '^IBEX') return '^ibex';
  if (preg_match('/\.(DE|PA)$/i', $s)) return strtolower($s);
  if (str_ends_with($s, '.MC')) {
    $base = substr($s, 0, -3);
    $mapADR = ['SAN'=>'SAN.US','TEF'=>'TEF.US','GRF'=>'GRFS.US'];
    return isset($mapADR[$base]) ? strtolower($mapADR[$base]) : null;
  }
  if (!preg_match('/\.[A-Z]{2}$/', $s)) $s .= '.US';
  return strtolower($s);
}
$stooqSym = mapToStooq($symbol);
if (!$stooqSym) { echo json_encode(['symbol'=>$symbol,'range'=>$range,'points'=>[]]); exit; }

// ===== HTTP helpers =====
function http_get_curl(string $url): array {
  if (!function_exists('curl_init')) return [0,null,'curl_missing'];
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER=>true,
    CURLOPT_FOLLOWLOCATION=>true,
    CURLOPT_CONNECTTIMEOUT=>6,
    CURLOPT_TIMEOUT=>12,
    CURLOPT_USERAGENT=>'AppBolsa/1.0 (+history)'
  ]);
  $body = curl_exec($ch);
  $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
  $err  = curl_error($ch);
  curl_close($ch);
  if ($body === false) return [$code?:0,null,$err?:'curl_exec_failed'];
  return [$code,$body,null];
}
function http_get_stream(string $url): array {
  if (!ini_get('allow_url_fopen')) return [0,null,'allow_url_fopen_off'];
  $ctx = stream_context_create(['http'=>['timeout'=>12,'user_agent'=>'AppBolsa/1.0 (+history)']]);
  $body = @file_get_contents($url, false, $ctx);
  $code = 0;
  if (isset($http_response_header[0]) && preg_match('#\s(\d{3})\s#', $http_response_header[0], $m)) {
    $code = (int)$m[1];
  }
  if ($body === false) return [$code,null,'stream_failed'];
  return [$code,$body,null];
}

// ===== Descarga histórico diario (CSV) =====
// Stooq: q/d/l/?s={sym}&i=d  => "Date,Open,High,Low,Close,Volume"
$urls = [
  fn($s) => "https://stooq.com/q/d/l/?s={$s}&i=d",
  fn($s) => "http://stooq.com/q/d/l/?s={$s}&i=d",
  fn($s) => "https://stooq.pl/q/d/l/?s={$s}&i=d",
  fn($s) => "http://stooq.pl/q/d/l/?s={$s}&i=d",
];

$csv = null; $tries = [];
foreach ($urls as $make) {
  $url = $make($stooqSym);
  [$code,$body,$err] = http_get_curl($url);
  $tries[] = ['method'=>'curl','url'=>$url,'code'=>$code,'err'=>$err,'ok'=>($code===200 && $body)];
  if ($code===200 && $body) { $csv = $body; break; }
  [$code,$body,$err] = http_get_stream($url);
  $tries[] = ['method'=>'stream','url'=>$url,'code'=>$code,'err'=>$err,'ok'=>($code===200 && $body)];
  if ($code===200 && $body) { $csv = $body; break; }
}

$points = [];
if ($csv) {
  $csv = str_replace("\r\n","\n",$csv);
  $lines = array_values(array_filter(array_map('trim', explode("\n",$csv))));
  if (!empty($lines) && stripos($lines[0],'date,open,high,low,close') !== false) array_shift($lines);

  foreach ($lines as $ln) {
    if ($ln==='') continue;
    $p = str_getcsv($ln);
    if (count($p) < 5) continue;
    [$date,$open,$high,$low,$close] = $p;
    if (!is_numeric($close)) continue;
    $ts = strtotime($date);
    if ($ts === false) continue;
    $points[] = ['t'=>$ts*1000, 'c'=>(float)$close];
  }

  // Orden creciente por fecha
  usort($points, fn($a,$b)=> $a['t'] <=> $b['t']);

  // === Recorte según rango ===
  // Para 1D y 1W, como no hay intradía, devolvemos 7 cierres diarios (para que siempre haya forma)
  if ($range === '1D' || $range === '1W') {
    $N = 7;
    if (count($points) > $N) $points = array_slice($points, -$N);
  } else {
    // para el resto, aproximamos “días de trading” con margen por findes
    $target = max(2, (int)$days);
    $maxPts = (int)ceil($target * 1.4);
    if (count($points) > $maxPts) $points = array_slice($points, -$maxPts);
  }
}

// Responder
if ($debug) {
  echo json_encode(['symbol'=>$symbol,'mapped'=>$stooqSym,'range'=>$range,'points'=>$points,'debug'=>$tries], JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES|JSON_PRETTY_PRINT);
} else {
  echo json_encode(['symbol'=>$symbol,'range'=>$range,'points'=>$points], JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
}
