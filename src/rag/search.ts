import { cosineSimilarity } from './embedder';
import type { StoredChunk } from './store';
import type { VectorStore } from './store';
import type { EmbeddingFn } from './embedder';
import { embed } from './embedder';
import { SqliteVectorStore } from './sqlite-store';


export interface SearchResult {
    // 命中的原始文本块，包含 text、embedding、metadata 等存储层信息。
    chunk: StoredChunk;
    // 最终用于排序的混合分数：vectorScore 和 keywordScore 按权重加权后相加。
    score: number;
    // 向量相似度归一化后的分数，越高表示语义越接近 query。
    vectorScore: number;
    // 关键词检索归一化后的分数，越高表示字面词匹配越强。
    keywordScore: number;
}

// 混合检索中，语义相似度占 70%，关键词匹配占 30%。
const VECTOR_WEIGHT = 0.7;
const KEYWORD_WEIGHT = 0.3;
// 先从每条检索路径多取一些候选，再合并、重排、去重。默认 topK=5 时每路取 20 条。
const CANDIDATE_MULTIPLIER = 4;
// MMR 的相关性/多样性权衡。越接近 1 越偏向高分结果，越接近 0 越偏向减少重复。
const MMR_LAMBDA = 0.7;

/**
 * 对 RAG 文档块执行混合搜索。
 *
 * 流程：
 * 1. 用 embedding 做语义向量检索，找到“意思接近”的文本块。
 * 2. 用 BM25-like 关键词打分，找到“字面词命中”的文本块。
 * 3. 分别归一化两路分数，再按权重合并。
 * 4. 用 MMR 从候选里挑 topK，降低内容重复。
 */
export async function hybridSearch(
    store: VectorStore,
    embedFn: EmbeddingFn,
    query: string,
    topK: number = 5,
): Promise<SearchResult[]> {
    const all = store.getAll();
    if (all.length === 0) return [];

    // 候选数不会超过实际文档块数量，避免 slice 请求无意义的条数。
    const candidateCount = Math.min(topK * CANDIDATE_MULTIPLIER, all.length);

    // Path 1: Vector search
    // 先把 query 转成向量，再和每个 chunk 的 embedding 算余弦相似度。
    const [queryVec] = await embed(embedFn, [query]);
    const vectorResults = all
        .map(chunk => ({ chunk, score: cosineSimilarity(queryVec, chunk.embedding) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, candidateCount);

    // Path 2: Keyword search (BM25-like TF-IDF scoring)
    // BM25 更适合处理用户明确输入了某些关键词、专有名词或代码标识符的情况。
    const queryTerms = tokenize(query);
    const docCount = all.length;
    const keywordResults = all
        .map(chunk => ({ chunk, score: bm25Score(queryTerms, chunk.text, docCount, all) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, candidateCount);

    // Normalize scores to [0, 1]
    // 两路分数的数值范围不同，合并前必须先归一化，否则某一路会因为量纲更大而主导结果。
    const vecNorm = normalizeMinMax(vectorResults.map(r => r.score));
    const kwNorm = normalizeViaSigmoid(keywordResults.map(r => r.score));

    // Merge into unified candidate set
    // 用 chunk.id 去重：同一个 chunk 可能同时出现在向量结果和关键词结果里。
    const candidates = new Map<string, SearchResult>();

    for (let i = 0; i < vectorResults.length; i++) {
        const id = vectorResults[i].chunk.id;
        candidates.set(id, {
            chunk: vectorResults[i].chunk,
            score: vecNorm[i] * VECTOR_WEIGHT,
            vectorScore: vecNorm[i],
            keywordScore: 0,
        });
    }

    for (let i = 0; i < keywordResults.length; i++) {
        const id = keywordResults[i].chunk.id;
        const existing = candidates.get(id);
        if (existing) {
            // 已经被向量检索命中过，则把关键词分数补上，并叠加到最终 score。
            existing.keywordScore = kwNorm[i];
            existing.score += kwNorm[i] * KEYWORD_WEIGHT;
        } else {
            candidates.set(id, {
                chunk: keywordResults[i].chunk,
                score: kwNorm[i] * KEYWORD_WEIGHT,
                vectorScore: 0,
                keywordScore: kwNorm[i],
            });
        }
    }

    // Sort by combined score
    const sorted = [...candidates.values()].sort((a, b) => b.score - a.score);

    // MMR deduplication
    // 直接取前 topK 容易拿到很多相似段落；MMR 会在相关性和多样性之间做一次重排。
    return mmrSelect(sorted, topK);
}

// ── BM25 scoring ──────────────────────────

// 简单分词：统一小写，保留英文/数字/下划线和中日韩统一表意文字，再过滤掉过短 token。
function tokenize(text: string): string[] {
    return text.toLowerCase()
        .replace(/[^\w一-鿿]+/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 1);
}

function bm25Score(queryTerms: string[], docText: string, N: number, allDocs: StoredChunk[]): number {
    // k1 控制词频饱和速度，b 控制文档长度归一化强度；这里使用 BM25 的常见默认值。
    const k1 = 1.2;
    const b = 0.75;
    const docTokens = tokenize(docText);
    // 平均文档长度用于惩罚过长文本，避免长 chunk 因为词多而天然占优。
    const avgDl = allDocs.reduce((s, d) => s + tokenize(d.text).length, 0) / (N || 1);
    const dl = docTokens.length;
    let score = 0;

    for (const term of queryTerms) {
        // tf: 当前文档里该词出现次数；df: 有多少文档包含该词。
        const tf = docTokens.filter(t => t === term).length;
        const df = allDocs.filter(d => tokenize(d.text).includes(term)).length;
        // idf 越高，说明这个词越少见，对区分文档越有帮助。
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
        // tfNorm 会让重复出现的词加分，但增长逐渐变慢，避免刷词无限抬高分数。
        const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / avgDl)));
        score += idf * tfNorm;
    }

    return score;
}

// ── Normalization ──────────────────────────

function normalizeMinMax(scores: number[]): number[] {
    if (scores.length === 0) return [];
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    // 所有分数相同会导致 range=0；用 1 兜底，避免除以 0。
    const range = max - min || 1;
    return scores.map(s => (s - min) / range);
}

function normalizeViaSigmoid(scores: number[]): number[] {
    // Sigmoid 把任意正负分数压到 0~1，适合 BM25 这种没有固定上限的分数。
    return scores.map(s => 1 / (1 + Math.exp(-s)));
}

// ── MMR deduplication ──────────────────────

function mmrSelect(results: SearchResult[], topK: number): SearchResult[] {
    if (results.length <= topK) return results;

    // 先选综合分最高的结果作为锚点，再逐个挑“相关但不太重复”的候选。
    const selected: SearchResult[] = [results[0]];
    const remaining = results.slice(1);

    while (selected.length < topK && remaining.length > 0) {
        let bestIdx = 0;
        let bestMmr = -Infinity;

        for (let i = 0; i < remaining.length; i++) {
            const relevance = remaining[i].score;
            // 用当前候选和已选结果中的最大 Jaccard 相似度，估计它是否和已选内容重复。
            const maxSim = Math.max(...selected.map(s => jaccardSimilarity(s.chunk.text, remaining[i].chunk.text)));
            // MMR = 相关性奖励 - 重复度惩罚。
            const mmr = MMR_LAMBDA * relevance - (1 - MMR_LAMBDA) * maxSim;
            if (mmr > bestMmr) {
                bestMmr = mmr;
                bestIdx = i;
            }
        }

        selected.push(remaining[bestIdx]);
        remaining.splice(bestIdx, 1);
    }

    return selected;
}

function jaccardSimilarity(a: string, b: string): number {
    // Jaccard = 交集大小 / 并集大小，用 token 集合粗略衡量两段文本的重合程度。
    const setA = new Set(tokenize(a));
    const setB = new Set(tokenize(b));
    const intersection = [...setA].filter(t => setB.has(t)).length;
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 0 : intersection / union;
}
