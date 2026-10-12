// Pure GPS / run math. No DOM access here so it can be unit tested in Node.

export const EARTH_RADIUS_M = 6371008.8;
export const METERS_PER_UNIT = { km: 1000, mi: 1609.344 };

// GPS filtering thresholds.
export const MAX_ACCURACY_M = 35; // ignore fixes worse than this
export const MAX_SPEED_MPS = 12.5; // ~45 km/h: faster than any runner, so it's a GPS jump
export const MIN_STEP_M = 3; // ignore jitter smaller than this

const toRad = (deg) => (deg * Math.PI) / 180;

// Great-circle distance in meters between two {lat, lon} points.
export function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Decide whether a new fix should be recorded, relative to the last recorded point.
// `fix` is {lat, lon, t, acc}; `last` is a recorded point or null.
export function evaluateFix(last, fix) {
  if (!(fix.acc <= MAX_ACCURACY_M)) return { accept: false, reason: "inaccurate", distance: 0 };
  if (!last) return { accept: true, reason: "first", distance: 0 };

  const dt = (fix.t - last.t) / 1000;
  if (dt <= 0) return { accept: false, reason: "stale", distance: 0 };

  const distance = haversine(last, fix);
  if (distance / dt > MAX_SPEED_MPS) return { accept: false, reason: "jump", distance: 0 };

  // Standing still, GPS wanders by a few meters. Only count movement that is
  // bigger than the noise floor for this fix.
  const minStep = Math.max(MIN_STEP_M, fix.acc / 3);
  if (distance < minStep) return { accept: false, reason: "too-close", distance: 0 };

  return { accept: true, reason: "ok", distance };
}

// Flatten segments into one chronological list of points.
export function allPoints(segments) {
  return segments.flat();
}

// Split times for each full unit (km or mi). Points carry cumulative distance `d`
// (meters) and moving time `e` (ms). Split boundaries are linearly interpolated.
export function computeSplits(points, unit = "km") {
  const unitM = METERS_PER_UNIT[unit];
  const splits = [];
  let next = unitM;
  let prevBoundaryE = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    while (b.d >= next && b.d > a.d) {
      const f = (next - a.d) / (b.d - a.d);
      const e = a.e + f * (b.e - a.e);
      splits.push({ index: splits.length + 1, ms: e - prevBoundaryE, partial: false });
      prevBoundaryE = e;
      next += unitM;
    }
  }
  const last = points[points.length - 1];
  if (last) {
    const remaining = last.d - (next - unitM);
    if (remaining > unitM * 0.05) {
      splits.push({
        index: splits.length + 1,
        ms: last.e - prevBoundaryE,
        partial: true,
        fraction: remaining / unitM,
      });
    }
  }
  return splits;
}

// Pace over the most recent `windowMs` of moving time, in seconds per unit.
// Returns null when there isn't enough movement to say.
export function recentPace(points, unit = "km", windowMs = 30000) {
  if (points.length < 2) return null;
  const last = points[points.length - 1];
  let i = points.length - 2;
  while (i > 0 && last.e - points[i].e < windowMs) i--;
  const first = points[i];
  const dd = last.d - first.d;
  const de = last.e - first.e;
  if (dd < 10 || de <= 0) return null;
  return paceSecondsPerUnit(dd, de, unit);
}

export function paceSecondsPerUnit(meters, ms, unit = "km") {
  if (!meters || meters <= 0) return null;
  return (ms / 1000) / (meters / METERS_PER_UNIT[unit]);
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// Pace like "5:32". Anything slower than 60 min/unit is effectively standing still.
export function formatPace(secondsPerUnit) {
  if (secondsPerUnit == null || !isFinite(secondsPerUnit) || secondsPerUnit >= 3600) return "–:––";
  const total = Math.round(secondsPerUnit);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function formatDistance(meters, unit = "km") {
  return (meters / METERS_PER_UNIT[unit]).toFixed(2);
}

// Project segments into SVG coordinates that fit a w×h box. Returns a list of
// point strings, one per segment, for use in <polyline points="…">.
export function projectRoute(segments, w, h, pad = 8) {
  const pts = segments.flat();
  if (pts.length === 0) return { lines: [], start: null, end: null };
  const lat0 = toRad(pts.reduce((s, p) => s + p.lat, 0) / pts.length);
  const xy = (p) => [p.lon * Math.cos(lat0), -p.lat];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    const [x, y] = xy(p);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const spanX = maxX - minX || 1e-9;
  const spanY = maxY - minY || 1e-9;
  const scale = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);
  const offX = (w - spanX * scale) / 2;
  const offY = (h - spanY * scale) / 2;
  const map = (p) => {
    const [x, y] = xy(p);
    return [+(offX + (x - minX) * scale).toFixed(1), +(offY + (y - minY) * scale).toFixed(1)];
  };
  const lines = segments
    .filter((seg) => seg.length > 0)
    .map((seg) => seg.map((p) => map(p).join(",")).join(" "));
  return { lines, start: map(pts[0]), end: map(pts[pts.length - 1]) };
}

const escapeXml = (s) =>
  String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);

// GPX 1.1 document for import into Strava, Garmin Connect, etc.
export function toGPX(run, name = "RunRunRun run") {
  const segs = run.segments
    .filter((seg) => seg.length > 0)
    .map((seg) => {
      const pts = seg
        .map((p) => {
          const ele = p.alt != null ? `<ele>${p.alt.toFixed(1)}</ele>` : "";
          return `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">${ele}<time>${new Date(p.t).toISOString()}</time></trkpt>`;
        })
        .join("\n");
      return `    <trkseg>\n${pts}\n    </trkseg>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="RunRunRun" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><time>${new Date(run.startedAt).toISOString()}</time></metadata>
  <trk>
    <name>${escapeXml(name)}</name>
    <type>running</type>
${segs}
  </trk>
</gpx>
`;
}
