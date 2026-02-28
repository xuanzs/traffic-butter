// =====================================================
// PART A — Location + CSV-based “jam → emission proxy”
// =====================================================

// 1) Set location (one point)
var site = ee.Geometry.Point([101.663257, 2.9837404]); // [lon, lat]
Map.centerObject(site, 14);
Map.addLayer(site, {color: 'red'}, 'Site');

// 2) Your CSV rows (from traffic_flow_data.csv)
var data = [
  {"ts":"2026-02-24T21:20:15","cars":2,"moto":0,"trucks":0,"buses":0,"flow":2,"queue":12},
  {"ts":"2026-02-24T21:20:45","cars":8,"moto":0,"trucks":0,"buses":0,"flow":8,"queue":12},
  {"ts":"2026-02-24T21:21:15","cars":11,"moto":0,"trucks":0,"buses":0,"flow":11,"queue":10},
  {"ts":"2026-02-24T21:21:45","cars":12,"moto":0,"trucks":0,"buses":0,"flow":12,"queue":9},
  {"ts":"2026-02-24T21:22:15","cars":13,"moto":0,"trucks":0,"buses":0,"flow":13,"queue":9},
  {"ts":"2026-02-24T21:22:45","cars":12,"moto":0,"trucks":0,"buses":0,"flow":12,"queue":10},
  {"ts":"2026-02-24T21:23:15","cars":14,"moto":0,"trucks":0,"buses":0,"flow":14,"queue":10},
  {"ts":"2026-02-24T21:23:45","cars":12,"moto":0,"trucks":0,"buses":0,"flow":12,"queue":11},
  {"ts":"2026-02-24T21:24:15","cars":14,"moto":0,"trucks":0,"buses":0,"flow":14,"queue":12},
  {"ts":"2026-02-24T21:24:45","cars":12,"moto":0,"trucks":0,"buses":0,"flow":12,"queue":12},
  {"ts":"2026-02-24T21:25:15","cars":11,"moto":0,"trucks":0,"buses":0,"flow":11,"queue":13},
  {"ts":"2026-02-24T21:25:45","cars":13,"moto":0,"trucks":0,"buses":0,"flow":13,"queue":15},
  {"ts":"2026-02-24T21:26:15","cars":12,"moto":0,"trucks":0,"buses":0,"flow":12,"queue":15},
  {"ts":"2026-02-24T21:26:45","cars":14,"moto":0,"trucks":0,"buses":0,"flow":14,"queue":14},
  {"ts":"2026-02-24T21:27:15","cars":12,"moto":0,"trucks":0,"buses":0,"flow":12,"queue":13},
  {"ts":"2026-02-24T21:27:45","cars":12,"moto":0,"trucks":0,"buses":0,"flow":12,"queue":12},
  {"ts":"2026-02-24T21:28:15","cars":11,"moto":0,"trucks":0,"buses":0,"flow":11,"queue":12},
  {"ts":"2026-02-24T21:28:45","cars":10,"moto":0,"trucks":0,"buses":0,"flow":10,"queue":12},
  {"ts":"2026-02-24T21:29:15","cars":9,"moto":0,"trucks":0,"buses":0,"flow":9,"queue":11}
];

// 3) Define jam + emissions proxy settings
var JAM_THRESHOLD = 13;       // queue proxy >= 13 considered jam
var JAM_REDUCTION = 0.70;     // AI reduces jam emissions by 30%
var NONJAM_REDUCTION = 0.95;  // AI reduces emissions slightly when not jam

function emissionProxy(row) {
  var moving = row.cars * 1.0 + row.moto * 0.5 + row.trucks * 3.0 + row.buses * 3.5;
  var idle = row.queue * 0.8; // idling/stop-go component
  return moving + idle;
}

// 4) Build FeatureCollection for charts
var fc_csv = ee.FeatureCollection(data.map(function(r) {
  var ts = ee.Date(r.ts);
  var jam = (r.queue >= JAM_THRESHOLD);

  var before = emissionProxy(r);
  var after = before * (jam ? JAM_REDUCTION : NONJAM_REDUCTION);

  return ee.Feature(site, {
    time: ts.millis(),
    time_readable: r.ts,
    jam: jam ? 1 : 0,
    queue: r.queue,
    flow: r.flow,
    emission_before: before,
    emission_after: after
  });
})).sort('time');

// 5) Charts
var chart = ui.Chart.feature.byFeature(fc_csv, 'time', ['emission_before', 'emission_after'])
  .setChartType('LineChart')
  .setOptions({
    title: 'Emissions Proxy (Before vs After AI) — Jam increases pollution',
    hAxis: { title: 'Time' },
    vAxis: { title: 'Emissions proxy (relative units)' },
    lineWidth: 3,
    pointSize: 4
  });
print(chart);

var queueChart = ui.Chart.feature.byFeature(fc_csv, 'time', ['queue'])
  .setChartType('LineChart')
  .setOptions({
    title: 'Queue Proxy (Vehicles in frame) — Jam indicator',
    hAxis: { title: 'Time' },
    vAxis: { title: 'Queue proxy' },
    lineWidth: 2,
    pointSize: 3
  });
print(queueChart);

print('CSV Total emission BEFORE (sum):', fc_csv.aggregate_sum('emission_before'));
print('CSV Total emission AFTER (sum):',  fc_csv.aggregate_sum('emission_after'));


// =====================================================
// PART B — BigQuery map layers (Baseline vs AI) + AOI/JAM boxes
// =====================================================

// 6) Load road emissions from BigQuery (your sample table)
var fc_bq = ee.FeatureCollection.loadBigQueryTable(
  'kitahack-2026-487106.kitahack_test.emissions_edges_sample',
  'geom'
);

var base = fc_bq.filter(ee.Filter.eq('scenario', 'baseline'));
var ai   = fc_bq.filter(ee.Filter.eq('scenario', 'ai'));

// Draw baseline/AI road layers
Map.addLayer(base.style({color:'blue', width:8}), {}, 'Baseline CO2 (BigQuery)');
Map.addLayer(ai.style({color:'red', width:3}), {}, 'AI CO2 (BigQuery)');

// 7) Define AOI + Jam boxes (EDIT these to match your rectangles)
// Rectangle format: [west, south, east, north] = [minLon, minLat, maxLon, maxLat]
var AOI  = ee.Geometry.Rectangle([101.6520, 2.9740, 101.6780, 2.9910]); // big area
var JAM1 = ee.Geometry.Rectangle([101.6595, 2.9820, 101.6675, 2.9885]); // hotspot 1
var JAM2 = ee.Geometry.Rectangle([101.6545, 2.9765, 101.6615, 2.9808]); // hotspot 2

Map.addLayer(AOI,  {color:'orange'}, 'AOI (Big area)');
Map.addLayer(JAM1, {color:'yellow'}, 'Jam Box 1');
Map.addLayer(JAM2, {color:'yellow'}, 'Jam Box 2');

// 8) Totals inside AOI/JAM boxes (BigQuery lines intersecting rectangle)
function sumCO2(fc0) {
  return ee.Number(fc0.aggregate_sum('co2_g'));
}
function inBox(fc0, box) {
  return fc0.filterBounds(box);
}

var base_AOI = inBox(base, AOI);
var ai_AOI   = inBox(ai, AOI);
var base_J1  = inBox(base, JAM1);
var ai_J1    = inBox(ai, JAM1);
var base_J2  = inBox(base, JAM2);
var ai_J2    = inBox(ai, JAM2);

print('BigQuery AOI baseline CO2', sumCO2(base_AOI));
print('BigQuery AOI AI CO2',       sumCO2(ai_AOI));
print('BigQuery JAM1 baseline CO2', sumCO2(base_J1));
print('BigQuery JAM1 AI CO2',       sumCO2(ai_J1));
print('BigQuery JAM2 baseline CO2', sumCO2(base_J2));
print('BigQuery JAM2 AI CO2',       sumCO2(ai_J2));

// Optional: % reduction helper
function reductionPct(b, a) {
  b = ee.Number(b); a = ee.Number(a);
  return ee.Algorithms.If(b.neq(0), ee.Number(1).subtract(a.divide(b)).multiply(100), null);
}
print('AOI reduction %',  reductionPct(sumCO2(base_AOI), sumCO2(ai_AOI)));
print('JAM1 reduction %', reductionPct(sumCO2(base_J1),  sumCO2(ai_J1)));
print('JAM2 reduction %', reductionPct(sumCO2(base_J2),  sumCO2(ai_J2)));
