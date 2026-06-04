import {
  chunkMessagesByMaxTokens,
  estimateCompactionMessageTokens,
} from "./src/agents/compaction-planning.ts";

const messages = Array.from({ length: 50 }, (_, i) => ({
  role: i % 2 === 0 ? "user" : "assistant",
  content: `Message ${i} with some content that should be chunked normally`,
  timestamp: i + 1,
}));

const totalTokens = messages.reduce((sum, msg) => sum + estimateCompactionMessageTokens(msg), 0);
console.log("Total tokens:", totalTokens);
console.log("Effective max (500/1.2):", Math.floor(500 / 1.2));

const chunks = chunkMessagesByMaxTokens(messages, 500);
console.log("Number of chunks:", chunks.length);
chunks.forEach((chunk, i) => {
  const chunkTokens = chunk.reduce((sum, msg) => sum + estimateCompactionMessageTokens(msg), 0);
  console.log(`Chunk ${i}: ${chunk.length} messages, ${chunkTokens} tokens`);
});
