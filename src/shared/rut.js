/**
 * RUT chileno: formato XX.XXX.XXX-X y validación del dígito verificador (módulo 11).
 * Código movido sin cambios desde src/server.js (tarea 1.7).
 */

function formatRut(rawRut) {
  if (!rawRut) return null;
  const clean = rawRut.replace(/[^0-9kK]/g, "").toUpperCase();
  if (clean.length < 8 || clean.length > 9) return null;
  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  const formattedBody = body.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${formattedBody}-${dv}`;
}

function isValidChileanRutMod11(rawRut) {
  if (!rawRut) return false;
  const clean = String(rawRut)
    .replace(/[^0-9kK]/g, "")
    .toUpperCase();
  if (clean.length < 8 || clean.length > 9) return false;
  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  if (!/^\d+$/.test(body)) return false;
  const num = parseInt(body, 10);
  if (num < 1000000 || num > 50000000) return false;
  let sum = 0;
  let mul = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += parseInt(body[i], 10) * mul;
    mul = mul === 7 ? 2 : mul + 1;
  }
  const rem = 11 - (sum % 11);
  const expectedDv = rem === 11 ? "0" : rem === 10 ? "K" : String(rem);
  return dv === expectedDv;
}

module.exports = { formatRut, isValidChileanRutMod11 };
