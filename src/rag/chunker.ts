export interface Chunk {
    id: string;
    text: string;
    source: string;
    index: number;
    tokenEstimate: number;
}

const TARGET_TOKENS = 256; // 每个chunk 大小 256 token
const CHARS_PER_TOKEN = 4; // 每个token 大约 4 个字符
const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN; // 每个chunk 大小 256 token 对应的字符数

// 文档名，文档内容
export function chunkDocument(source: string, text: string): Chunk[] {
    const paragraphs = text.split(/\n{2,}/); // 按空行分割成段落。段落列表
    const chunks: Chunk[] = []; // 存储chunk
    let current = ''; // 当前正在拼接的块缓冲区
    let idx = 0; // chunk索引

    for (const para of paragraphs) {
        const trimmed = para.trim();
        if (!trimmed) continue;

        // 如果当前缓冲区 + 新段落 超过目标大小 → 先保存当前块。 \n\n
        if (current.length + trimmed.length + 2 > TARGET_CHARS && current.length > 0) {
            chunks.push(makeChunk(source, current.trim(), idx++));
            current = ''; // 重置当前缓冲区
        }

        // 如果当前段落字数很多，超出
        if (trimmed.length > TARGET_CHARS) {
            if (current.length > 0) {
                chunks.push(makeChunk(source, current.trim(), idx++));
                current = '';
            }
            // 段落内容 按 句号、问号、感叹号 + 可能空格 切分句子
            const sentences = trimmed.split(/(?<=[。！？.!?])\s*/);
            let sentBuf = '';
            for (const sent of sentences) { // 句子间是一个空格
                if (sentBuf.length + sent.length + 1 > TARGET_CHARS && sentBuf.length > 0) {
                    chunks.push(makeChunk(source, sentBuf.trim(), idx++));
                    sentBuf = '';
                }
                sentBuf += (sentBuf ? ' ' : '') + sent;
            }
            if (sentBuf.trim()) {
                current = sentBuf.trim();
            }
        } else {
            // 段落内容少 直接拼接
            current += (current ? '\n\n' : '') + trimmed;
        }
    }

    if (current.trim()) {
        chunks.push(makeChunk(source, current.trim(), idx++));
    }

    return chunks;
}

function makeChunk(source: string, text: string, index: number): Chunk {
    return {
        id: `${source}#${index}`,
        text,
        source,
        index,
        tokenEstimate: Math.ceil(text.length / CHARS_PER_TOKEN),
    };
}
