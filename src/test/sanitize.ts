// Quick test for sanitizeJson
function sanitizeJson(raw: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) { result += ch; escaped = false; continue; }
    if (ch === '\\') { result += ch; if (inString) escaped = true; continue; }
    if (ch === '"') { inString = !inString; result += ch; continue; }
    if (inString) {
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        switch (ch) {
          case '\n': result += '\\n'; break;
          case '\r': result += '\\r'; break;
          case '\t': result += '\\t'; break;
          case '\b': result += '\\b'; break;
          case '\f': result += '\\f'; break;
          default: result += `\\u${code.toString(16).padStart(4, '0')}`; break;
        }
        continue;
      }
    }
    result += ch;
  }
  return result;
}

// Test 1: Literal newline inside string value (the common LLM bug)
const bad1 = '{"status":"success","summary":"line1\nline2"}';
try { JSON.parse(bad1); console.log('FAIL: bad1 should not parse'); } catch { console.log('Test 1: bad1 correctly fails raw parse'); }
const good1 = JSON.parse(sanitizeJson(bad1));
console.log('Test 1:', good1.summary.includes('\n') ? 'PASS' : 'FAIL', `→ "${good1.summary}"`);

// Test 2: Literal tab
const bad2 = '{"status":"success","summary":"col1\tcol2"}';
const good2 = JSON.parse(sanitizeJson(bad2));
console.log('Test 2:', good2.summary.includes('\t') ? 'PASS' : 'FAIL', `→ "${good2.summary}"`);

// Test 3: Already-escaped (should be untouched)
const ok3 = '{"status":"success","summary":"line1\\nline2"}';
const good3 = JSON.parse(sanitizeJson(ok3));
console.log('Test 3:', good3.summary === 'line1\nline2' ? 'PASS' : 'FAIL', `→ "${good3.summary}"`);

// Test 4: Mixed — some escaped, some literal
const bad4 = '{"status":"partial","summary":"did X\\nthen Y\nthen Z"}';
const good4 = JSON.parse(sanitizeJson(bad4));
console.log('Test 4:', good4.summary.split('\n').length === 3 ? 'PASS' : 'FAIL', `→ "${good4.summary}"`);

// Test 5: Control char outside strings (should be preserved as-is)
const ok5 = '{"a":"b"}\n';
const good5 = JSON.parse(sanitizeJson(ok5));
console.log('Test 5:', good5.a === 'b' ? 'PASS' : 'FAIL');
