import { lexicalTokens } from './embeddings';

/** Common English, French and Indonesian function words; they swamp OR queries. */
export const STOPWORDS = new Set(`a about above after again against all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just let me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves
  okay yeah yes oh um uh like get got going gonna know think really well right thing things one two make made say said see want
  au aux avec ce ces cette dans de des du elle en et eux il ils je la le les leur lui ma mais me meme mes moi mon ne nos notre nous on ou par pas pour qu que qui sa se ses son sur ta te tes toi ton tu un une vos votre vous c d j l m n s t y ete etre avoir est sont etait fait faire plus tres bien alors donc comme aussi tout tous toute toutes ca cela oui non voila euh bon ben`.split(/\s+/).filter(Boolean));

// Keep negation and domain terms: words such as "belum", "tidak", "risiko" and "keputusan"
// can materially change the meaning of a meeting question.
for (const word of 'yang dan atau di ke dari untuk dengan pada dalam oleh sebagai ini itu tersebut saya kami kita anda mereka dia ada adalah merupakan akan sudah telah sedang juga saja nya ya nah jadi yakni yaitu agar supaya serta tentang terhadap antara karena maka apa apakah siapa kapan bagaimana mengapa mana'.split(' ')) STOPWORDS.add(word);

/** Content words of a question or passage, in order, without stopwords or one-letter tokens. */
export function contentTokens(text: string): string[] {
  return lexicalTokens(text).filter(token => token.length > 1 && !STOPWORDS.has(token));
}

/**
 * An FTS5 OR query over the content words of free text, quoted so no input can
 * inject FTS syntax. bm25 then ranks passages matching more words higher, which
 * suits natural-language questions better than requiring every word.
 */
export function ftsOrQuery(text: string, max = 16): string {
  const tokens = [...new Set(contentTokens(text))].slice(0, max);
  return tokens.map(token => `"${token.replaceAll('"', '""')}"${token.length >= 4 ? '*' : ''}`).join(' OR ');
}
