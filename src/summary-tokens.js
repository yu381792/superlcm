// Unicode-weighted estimates, following Lossless Claw's budgeting approach:
// https://github.com/Martian-Engineering/lossless-claw/blob/e05d8d34b2a44fdef556ce95dd90115b46630200/src/estimate-tokens.ts
// These are planning estimates, not a provider's measured billing tokens.
const eastAsian=/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u
const units=char=>eastAsian.test(char)?6:char.codePointAt(0)>0xffff?8:1
export function estimateSummaryTokens(text) {
  let total=0
  for(const char of text)total+=units(char)
  return Math.ceil(total/4)
}
export function takeTokenPrefix(text,budget) {
  let total=0,end=0
  for(const char of text) {
    const next=total+units(char)
    if(next>budget*4)break
    total=next;end+=char.length
  }
  return text.slice(0,end)
}
export function takeTokenSuffix(text,budget) {
  let total=0,start=text.length
  while(start>0) {
    let from=start-1
    const last=text.charCodeAt(from)
    if(last>=0xdc00&&last<=0xdfff&&from>0&&text.charCodeAt(from-1)>=0xd800&&text.charCodeAt(from-1)<=0xdbff)from--
    const next=total+units(text.slice(from,start))
    if(next>budget*4)break
    total=next;start=from
  }
  return text.slice(start)
}
