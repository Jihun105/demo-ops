function googleEarthUrl(address) {
  if (
    typeof address !== 'string' ||
    !address.trim() ||
    address.length > 1000 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(address) ||
    !address.isWellFormed() ||
    ['.', '..'].includes(address.trim())
  )
    throw new Error('검색할 주소를 올바르게 입력해주세요.');
  return `https://earth.google.com/web/search/${encodeURIComponent(address.trim())}`;
}

module.exports = { googleEarthUrl };
