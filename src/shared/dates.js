/**
 * Fechas en documentos chilenos: meses en español, extracción de fechas de un texto y parseo de una fecha.
 * Código movido sin cambios desde src/server.js (tarea 1.7).
 */

const MONTH_MAP = {
  ENE: 1,
  ENERO: 1,
  FEB: 2,
  FEBRERO: 2,
  MAR: 3,
  MARZO: 3,
  ABR: 4,
  ABRIL: 4,
  MAY: 5,
  MAYO: 5,
  JUN: 6,
  JUNIO: 6,
  JUL: 7,
  JULIO: 7,
  AGO: 8,
  AGOSTO: 8,
  SEP: 9,
  SEPT: 9,
  SEPTIEMBRE: 9,
  SETIEMBRE: 9,
  OCT: 10,
  OCTUBRE: 10,
  NOV: 11,
  NOVIEMBRE: 11,
  DIC: 12,
  DICIEMBRE: 12,
};

function extractDatesFromText(rawText) {
  const dates = [];
  if (!rawText) return dates;

  const numDateRegex =
    /\b([0-3]?\d)[\/\-\.]([0-1]?\d)[\/\-\.]((?:19|20)\d{2})\b|\b((?:19|20)\d{2})[\/\-\.]([0-1]?\d)[\/\-\.]([0-3]?\d)\b/g;
  for (const m of rawText.matchAll(numDateRegex)) {
    if (m[1]) {
      dates.push({
        day: parseInt(m[1], 10),
        month: parseInt(m[2], 10),
        year: parseInt(m[3], 10),
      });
    } else if (m[4]) {
      dates.push({
        year: parseInt(m[4], 10),
        month: parseInt(m[5], 10),
        day: parseInt(m[6], 10),
      });
    }
  }

  const textDateRegex =
    /\b([0-3]?\d)\s*(?:DE\s+|\.|\-|\s)\s*(ENE(?:RO)?|FEB(?:RERO)?|MAR(?:ZO)?|ABR(?:IL)?|MAY(?:O)?|JUN(?:IO)?|JUL(?:IO)?|AGO(?:STO)?|SEP(?:T(?:IEMBRE)?)?|SETIEMBRE|OCT(?:UBRE)?|NOV(?:IEMBRE)?|DIC(?:IEMBRE)?)\.?\s*(?:DE\s+|\.|\-|\s)\s*((?:19|20)\d{2})\b/gi;
  for (const m of rawText.matchAll(textDateRegex)) {
    const day = parseInt(m[1], 10);
    const monthKey = m[2].toUpperCase().replace(".", "");
    const month = MONTH_MAP[monthKey];
    const year = parseInt(m[3], 10);
    if (month) {
      dates.push({ day, month, year });
    }
  }

  return dates.filter(
    (d) => d.month >= 1 && d.month <= 12 && d.day >= 1 && d.day <= 31,
  );
}

// Construye una fecha solo si existe en el calendario (rechaza 31/02 o 99/99 en vez de desbordar al mes siguiente).
function buildCalendarDate(year, monthIndex, day) {
  const d = new Date(year, monthIndex, day, 12, 0, 0);
  return d.getFullYear() === year &&
    d.getMonth() === monthIndex &&
    d.getDate() === day
    ? d
    : null;
}

function parseChileanDate(rawDateStr) {
  if (!rawDateStr) return null;
  const str = String(rawDateStr).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const [y, m, d] = str.split("-").map(Number);
    return buildCalendarDate(y, m - 1, d);
  }
  if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}$/.test(str)) {
    const parts = str.split(/[\/\-]/).map(Number);
    return buildCalendarDate(parts[2], parts[1] - 1, parts[0]);
  }
  const meses = {
    enero: 0,
    febrero: 1,
    marzo: 2,
    abril: 3,
    mayo: 4,
    junio: 5,
    julio: 6,
    agosto: 7,
    septiembre: 8,
    setiembre: 8,
    octubre: 9,
    noviembre: 10,
    diciembre: 11,
  };
  const match = str
    .toLowerCase()
    .match(/(\d{1,2})\s+(?:de\s+)?([a-z]+)\s+(?:de\s+)?(\d{4})/);
  if (match) {
    const d = parseInt(match[1], 10);
    const mName = match[2];
    const y = parseInt(match[3], 10);
    if (meses[mName] !== undefined) {
      return buildCalendarDate(y, meses[mName], d);
    }
  }
  const fallback = new Date(str);
  return isNaN(fallback.getTime()) ? null : fallback;
}

module.exports = { MONTH_MAP, extractDatesFromText, parseChileanDate };
