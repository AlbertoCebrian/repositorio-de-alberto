<?php
// api/news.php
declare(strict_types=1);

ini_set('display_errors', '0');
error_reporting(E_ALL);

// --- CORS + JSON ---
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');

// --- Feeds (puedes añadir más) ---
$FEEDS = [
  ["url" => "https://feeds.reuters.com/reuters/businessNews", "source" => "Reuters"],
  ["url" => "https://e00-expansion.uecdn.es/rss/economia.xml", "source" => "Expansión"],
  ["url" => "https://cincodias.elpais.com/rss/economia.xml", "source" => "CincoDías"],
];

$CACHE_FILE = sys_get_temp_dir() . "/news-cache.json";
$CACHE_TTL  = 300; // 5 minutos

// --- Cache simple ---
if (file_exists($CACHE_FILE) && (time() - filemtime($CACHE_FILE) < $CACHE_TTL)) {
  readfile($CACHE_FILE);
  exit;
}

// --- Utils ---
function cleanTxt(string $s): string {
  $s = html_entity_decode(strip_tags($s), ENT_QUOTES | ENT_HTML5, 'UTF-8');
  $s = preg_replace('/\s+/u', ' ', $s);
  return trim($s);
}
function toEpochMs(?string $date): int {
  if (!$date) return (int)(microtime(true) * 1000);
  $ts = strtotime($date);
  if ($ts === false) $ts = time();
  return $ts * 1000;
}
function fetchRss(string $url): ?string {
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_CONNECTTIMEOUT => 6,
    CURLOPT_TIMEOUT => 8,
    CURLOPT_USERAGENT => 'AppBolsa/1.0 (+news)'
  ]);
  $data = curl_exec($ch);
  $http = curl_getinfo($ch, CURLINFO_HTTP_CODE);
  curl_close($ch);
  return ($data === false || $http !== 200) ? null : $data;
}

// --- Link extractors robustos ---
function extractLinkFromRssItem(SimpleXMLElement $item): string {
  if (isset($item->link) && trim((string)$item->link) !== '') {
    return trim((string)$item->link);
  }
  if (isset($item->guid)) {
    $guid = (string)$item->guid;
    $isPerm = strtolower((string)($item->guid['isPermaLink'] ?? '')) === 'true';
    if ($isPerm && filter_var($guid, FILTER_VALIDATE_URL)) return $guid;
  }
  return '';
}
function extractLinkFromAtomEntry(SimpleXMLElement $entry): string {
  if (!isset($entry->link)) return '';
  foreach ($entry->link as $lnk) {
    $a = $lnk->attributes();
    if (!$a) continue;
    $rel = (string)($a['rel'] ?? '');
    $href = (string)($a['href'] ?? '');
    if ($href !== '' && ($rel === 'alternate' || $rel === '')) return $href;
  }
  return '';
}

// --- Parse ---
$out = [];
foreach ($FEEDS as $f) {
  $xmlStr = fetchRss($f['url']);
  if (!$xmlStr) continue;

  libxml_use_internal_errors(true);
  $xml = @simplexml_load_string($xmlStr);
  if (!$xml) continue;

  // RSS
  if (isset($xml->channel->item)) {
    foreach ($xml->channel->item as $item) {
      $title = cleanTxt((string)$item->title);
      $link  = extractLinkFromRssItem($item);
      $desc  = cleanTxt((string)($item->description ?? $item->summary ?? ''));
      $date  = (string)($item->pubDate ?? $item->date ?? $item->updated ?? '');
      if (!$title || !$link || !preg_match('#^https?://#i', $link)) continue;
      $out[] = [
        'title'       => $title,
        'source'      => $f['source'],
        'publishedAt' => toEpochMs($date),
        'url'         => $link,
        'summary'     => mb_substr($desc, 0, 280),
      ];
    }
  }

  // Atom
  if (isset($xml->entry)) {
    foreach ($xml->entry as $entry) {
      $title = cleanTxt((string)$entry->title);
      $link  = extractLinkFromAtomEntry($entry);
      $summary = cleanTxt((string)($entry->summary ?? $entry->content ?? ''));
      $date    = (string)($entry->updated ?? $entry->published ?? '');
      if (!$title || !$link || !preg_match('#^https?://#i', $link)) continue;
      $out[] = [
        'title'       => $title,
        'source'      => $f['source'],
        'publishedAt' => toEpochMs($date),
        'url'         => $link,
        'summary'     => mb_substr($summary, 0, 280),
      ];
    }
  }
}

// --- Ordenar y recortar ---
usort($out, fn($a, $b) => $b['publishedAt'] <=> $a['publishedAt']);
$out = array_slice($out, 0, 30);

// --- Guardar cache y responder ---
$json = json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
if ($json === false) { http_response_code(500); echo '[]'; exit; }
@file_put_contents($CACHE_FILE, $json);
echo $json;
