'use strict';
// Phone numbers from Excel sometimes lost their leading 0 (1098765432 for 010-9876-5432).
// The server keeps digits only; these helpers restore the 0 for showing, calling and texting.
// src/ui/model.js formatPhone follows the same rule for the PC screens.
function phoneDigits(value) {
  const d = String(value ?? '').replace(/\D/g, '');
  // A mobile number (01x) with 10 digits after the lost 0, or an area number (02–06x).
  if (/^1\d{9}$/.test(d) || /^[2-6]\d{7,9}$/.test(d)) return '0' + d;
  return d;
}
function formatPhone(value, empty = '') {
  const d = phoneDigits(value);
  if (!d) return empty;
  if (/^01\d{9}$/.test(d)) return d.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3');
  if (/^01\d{8}$/.test(d)) return d.replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
  if (/^02\d{7,8}$/.test(d)) return d.replace(/(\d{2})(\d{3,4})(\d{4})/, '$1-$2-$3');
  if (/^0\d{8,10}$/.test(d)) return d.replace(/(\d{3})(\d{3,4})(\d{4})/, '$1-$2-$3');
  return String(value);
}
module.exports = { phoneDigits, formatPhone };
