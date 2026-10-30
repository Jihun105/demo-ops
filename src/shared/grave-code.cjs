'use strict';
// Grave code: 데모-{grave number}-{check letter}, e.g. 데모-328-Z. The letter is computed from the
// number so a code typed or edited by hand rarely matches another grave. Codes carry no names or
// phone numbers. Used by the desktop (shows and matches the code); the number itself comes from
// the server (demo_desktop_registration_reserve).
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O: they look like 1 and 0
const PREFIX = '데모';

function checkLetter(number) {
  const digits = String(number).split('').reverse();
  let sum = 0;
  digits.forEach((digit, index) => {
    sum += Number(digit) * (index + 3);
  });
  return LETTERS[sum % LETTERS.length];
}

function graveCode(number) {
  if (!Number.isSafeInteger(number) || number < 1) throw Error('Invalid grave number');
  return `${PREFIX}-${number}-${checkLetter(number)}`;
}

// Finds the first valid code inside a file name or a text. Returns the grave number or null.
// A browser may add " (1)" or a different extension case; those are ignored.
function findGraveNumber(text) {
  if (typeof text !== 'string') return null;
  const pattern = new RegExp(`${PREFIX}-(\\d{1,15})-([A-Za-z])`, 'gu');
  for (const match of text.normalize('NFC').matchAll(pattern)) {
    const number = Number(match[1]);
    if (
      Number.isSafeInteger(number) &&
      number >= 1 &&
      checkLetter(number) === match[2].toUpperCase()
    )
      return number;
  }
  return null;
}

module.exports = { graveCode, findGraveNumber };
